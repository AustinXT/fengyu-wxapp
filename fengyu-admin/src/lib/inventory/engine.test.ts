import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDb, mockGetSession } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
  mockGetSession: vi.fn(),
}))

vi.mock('@/db', () => ({ db: mockDb }))
vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }))
vi.mock('@/lib/permissions', () => ({
  hasPermission: vi.fn(() => true),
  isAdminScope: vi.fn(() => true),
  requireAnyPermission: vi.fn(),
  requirePermission: vi.fn(),
}))
vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import {
  approveInventoryCoreDoc,
  confirmInventoryCoreReceive,
  createInventoryCoreDoc,
  createInventoryPromotionPlan,
  createInventorySku,
  createInventorySupplier,
  disableInventoryPromotionPlan,
  getInventoryCoreDocById,
  listInventoryLocationFilterOptions,
  rejectInventoryCoreDoc,
  syncInventoryLocations,
  updateInventorySku,
  updateInventoryPromotionPlan,
} from './engine'
import { hasPermission, isAdminScope } from '@/lib/permissions'

const SESSION = {
  employeeId: 'E001',
  name: '测试用户',
  phone: '13800000000',
  roles: [{ role: 'admin', scopeId: 'HQ', scopeType: '总部' }],
  permissions: { actions: ['inventory:create_doc', 'inventory:approve'], scopeStoreIds: [] },
} as never

function selectWithLimit(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  }
}

function selectWithoutLimit(rows: unknown[]) {
  return {
    from: () => ({
      where: async () => rows,
    }),
  }
}

function selectWithOrder(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: async () => rows,
      }),
    }),
  }
}

function detailHeadSelect(rows: unknown[]) {
  return {
    from: () => ({
      leftJoin: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    }),
  }
}

function detailItemsSelect(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: async () => rows,
      }),
    }),
  }
}

function promotionPlanSelect(rows: unknown[]) {
  return {
    from: () => ({
      leftJoin: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  }
}

function promotionItemSelect(rows: unknown[]) {
  return {
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
  }
}

function renderSql(query: unknown): string {
  const chunks = (query as { queryChunks?: Array<{ value?: unknown }> }).queryChunks ?? []
  return chunks
    .map((chunk) => {
      if (!chunk) return ''
      return Array.isArray(chunk.value) ? chunk.value.join('') : String(chunk)
    })
    .join('')
}

function sqlContains(query: unknown, fragment: string): boolean {
  const seen = new Set<object>()
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes(fragment)
    if (!value || typeof value !== 'object') return false
    if (seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.some(visit)
    return Object.values(value as Record<string, unknown>).some(visit)
  }
  return visit(query)
}

function initializedCutoverExecutor(txExecute: (query: unknown) => Promise<unknown>) {
  return async (query: unknown) => {
    const rendered = renderSql(query)
    if (rendered.includes('inventory_cutover_states')) {
      return rendered.includes('SELECT status') ? [{ status: '已初始化' }] : []
    }
    return txExecute(query)
  }
}

function lotRow(quantityOnHand = '10') {
  return {
    id: 1,
    location_id: 'HQ',
    sku_id: 'SKU-1',
    sku_name: '测试 SKU',
    spec_name: null,
    supplier: null,
    product_series: null,
    batch_no: null,
    expiry_date: null,
    is_gift: false,
    quantity_on_hand: quantityOnHand,
    supply_chain_unit_cost: null,
    market_standard_unit_price: null,
    market_unit_discount: null,
    market_actual_unit_price: null,
    store_standard_unit_price: null,
    store_unit_discount: null,
    store_actual_unit_price: null,
  }
}

describe('库存通用建单边界', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.execute.mockResolvedValue([])
    mockDb.select.mockReset()
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: '总部' }]))
    mockDb.transaction.mockReset()
  })

  it('拒绝手工创建调货入库和期初库存', async () => {
    for (const docType of ['分院调货入库', '市场间调货入库', '期初库存'] as const) {
      await expect(createInventoryCoreDoc({ docType, items: [] } as never))
        .rejects.toThrow('只能由收货确认或期初迁移流程生成')
    }
  })

  it('拒绝从通用入口创建需要专用流程的单据', async () => {
    await expect(createInventoryCoreDoc({ docType: '市场采购入库', items: [] } as never))
      .rejects.toThrow('必须从对应的专用业务流程创建')
  })

  it('期初库存未核验完成时禁止写入库存业务', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: '待核验' }])
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: txExecute,
    }))

    await expect(approveInventoryCoreDoc('MBS-260809-0001'))
      .rejects.toThrow('库存期初尚未导入并核验完成')
    expect(txExecute).toHaveBeenCalledTimes(2)
  })

  it('专用单据不能经通用审批、驳回或收货入口绕过业务状态机', async () => {
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(vi.fn().mockResolvedValueOnce([{
        id: 'YTH-260809-0001', doc_type: '院退货', status: '待审批', source_location_id: 'STORE-1',
      }])),
    }))
    await expect(approveInventoryCoreDoc('YTH-260809-0001'))
      .rejects.toThrow('必须通过对应的专用业务流程处理')

    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(vi.fn().mockResolvedValueOnce([{
        doc_type: '市场退货', status: '待审批', source_location_id: 'MARKET-1', target_location_id: 'HQ',
      }])),
    }))
    await expect(rejectInventoryCoreDoc('MTH-260809-0001'))
      .rejects.toThrow('必须通过对应的专用业务流程处理')

    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(vi.fn().mockResolvedValueOnce([{
        id: 'FPH-260809-0001', doc_type: '分院配货', status: '待收货',
        source_location_id: 'MARKET-1', target_location_id: 'STORE-1',
        total_quantity: '1', remark: null,
      }])),
    }))
    await expect(confirmInventoryCoreReceive('FPH-260809-0001'))
      .rejects.toThrow('必须通过对应的专用业务流程处理')
  })

  it('分院调货的两端必须均为门店', async () => {
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithoutLimit([
        { locationId: 'market-A', locationType: '市场', parentLocationId: 'HQ' },
        { locationId: 'store-A', locationType: '门店', parentLocationId: 'market-A' },
      ]))

    await expect(createInventoryCoreDoc({
      docType: '分院调货出库',
      sourceLocationId: 'market-A',
      targetLocationId: 'store-A',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('出入库主体必须均为门店')
  })

  it('分院调货的门店必须属于同一市场', async () => {
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithoutLimit([
        { locationId: 'store-A', locationType: '门店', parentLocationId: 'market-A' },
        { locationId: 'store-B', locationType: '门店', parentLocationId: 'market-B' },
      ]))

    await expect(createInventoryCoreDoc({
      docType: '分院调货出库',
      sourceLocationId: 'store-A',
      targetLocationId: 'store-B',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('同市场内部的门店才可调货')
  })

  it('市场间调货的两端必须均为市场', async () => {
    mockDb.select
      .mockReturnValueOnce(selectWithLimit([{ locationType: '市场' }]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '市场' }]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '门店' }]))
      .mockReturnValueOnce(selectWithoutLimit([
        { locationId: 'market-A', locationType: '市场', parentLocationId: 'HQ' },
        { locationId: 'store-A', locationType: '门店', parentLocationId: 'market-A' },
      ]))

    await expect(createInventoryCoreDoc({
      docType: '市场间调货出库',
      sourceLocationId: 'market-A',
      targetLocationId: 'store-A',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('出入库主体必须均为市场')
  })

  it('供应链采购入库不能经通用入口绕过专用采购收货流程', async () => {
    await expect(createInventoryCoreDoc({
      docType: '供应链采购入库',
      targetLocationId: 'market-A',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('必须从对应的专用业务流程创建')
  })

  it('通用入库不能写入其他市场的自采 SKU', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sku_id: 'SELF-SKU',
        product_name: '市场 A 自采产品',
        spec_name: null,
        supplier: null,
        product_series: null,
        source_type: '市场自采',
        owner_market_id: 'MARKET-A',
        supply_chain_purchase_price: null,
        market_purchase_price: null,
        store_purchase_price: null,
      }])
      .mockResolvedValueOnce([{
        location_id: 'MARKET-B',
        location_type: '市场',
        parent_location_id: 'HQ',
      }])
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    }))
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: '市场' }]))

    await expect(createInventoryCoreDoc({
      docType: '市场产品盘溢',
      targetLocationId: 'MARKET-B',
      items: [{ skuId: 'SELF-SKU', quantity: 1 }],
    } as never)).rejects.toThrow('仅可在归属市场使用')
  })

  it.each([
    ['内部领用', 'sourceLocationId', '市场', '内部领用出库主体必须是总部'],
    ['院顾客产品出库', 'sourceLocationId', '市场', '院顾客产品出库出库主体必须是门店'],
    ['院顾客退货', 'targetLocationId', '市场', '院顾客退货入库主体必须是门店'],
    ['市场产品报损', 'sourceLocationId', '门店', '市场产品报损出库主体必须是市场'],
    ['院产品报损', 'sourceLocationId', '市场', '院产品报损出库主体必须是门店'],
    ['市场产品盘溢', 'targetLocationId', '门店', '市场产品盘溢入库主体必须是市场'],
    ['市场库存盘点', 'sourceLocationId', '门店', '市场库存盘点主体必须是市场'],
    ['分院库存盘点', 'sourceLocationId', '市场', '分院库存盘点主体必须是门店'],
  ] as const)('%s 限制库存主体类型', async (docType, locationField, actualType, expectedMessage) => {
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: actualType }]))
    const input: Record<string, unknown> = {
      docType,
      items: [{ skuId: 'SKU-1', quantity: 1 }],
      [locationField]: 'LOCATION-1',
    }

    await expect(createInventoryCoreDoc(input as never)).rejects.toThrow(expectedMessage)
  })
})

describe('库存 SKU 来源与价格保护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.select.mockReset()
  })

  it('库存商品编号按上海日期和当日序号由系统生成', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T04:00:00.000Z'))
    try {
      const values = vi.fn().mockResolvedValue(undefined)
      const txExecute = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ value: 'INV-SKU-20260813-0009' }])
      mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
        execute: txExecute,
        insert: vi.fn(() => ({ values })),
      }))

      await expect(createInventorySku({ productName: '测试商品' })).resolves.toEqual({
        success: true,
        skuId: 'INV-SKU-20260813-0010',
      })
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        skuId: 'INV-SKU-20260813-0010',
        productCode: 'INV-SKU-20260813-0010',
        productName: '测试商品',
      }))
      expect(renderSql(txExecute.mock.calls[0]?.[0])).toContain('pg_advisory_xact_lock')
      expect(renderSql(txExecute.mock.calls[0]?.[0])).toContain('inventory_skus:INV-SKU:20260813')
    } finally {
      vi.useRealTimers()
    }
  })

  it('福利方案编号按上海日期和当日序号由系统生成', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T04:00:00.000Z'))
    try {
      mockDb.select.mockReturnValueOnce(selectWithoutLimit([{
        skuId: 'SKU-1',
        productName: '测试商品',
        marketPurchasePrice: '100',
      }]))
      const values = vi.fn().mockResolvedValue(undefined)
      const txExecute = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ value: 'PROMO-20260813-0041' }])
      mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
        execute: txExecute,
        insert: vi.fn(() => ({ values })),
      }))

      await createInventoryPromotionPlan({
        name: '测试福利',
        startsAt: '2026-08-13',
        endsAt: '2026-08-31',
        items: [{ skuId: 'SKU-1', marketUnitDiscount: 10 }],
      })

      expect(values.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        planNo: 'PROMO-20260813-0042',
        name: '测试福利',
      }))
      expect(renderSql(txExecute.mock.calls[0]?.[0])).toContain('pg_advisory_xact_lock')
      expect(renderSql(txExecute.mock.calls[0]?.[0])).toContain('inventory_promotion_plans:PROMO:20260813')
    } finally {
      vi.useRealTimers()
    }
  })

  it('供应商编号始终由系统生成并忽略调用方伪造编号', async () => {
    const values = vi.fn().mockResolvedValue(undefined)
    mockDb.insert.mockReturnValueOnce({ values })

    const result = await createInventorySupplier({
      supplierId: 'MANUAL-SUPPLIER-ID',
      name: '测试供应商',
    } as never)

    expect(result.supplierId).toMatch(/^INV-SUP-[0-9a-f-]{36}$/)
    expect(result.supplierId).not.toBe('MANUAL-SUPPLIER-ID')
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      supplierId: result.supplierId,
      name: '测试供应商',
    }))
  })

  it('创建后不能跨市场或转换库存 SKU 来源', async () => {
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null,
      marketPurchaseDiscount: null,
      sourceType: '市场自采',
      ownerMarketId: 'MARKET-1',
    }]))

    await expect(updateInventorySku('SKU-1', {
      sourceType: '供应链',
      ownerMarketId: null,
    })).rejects.toThrow('来源和归属市场创建后不可修改')
  })

  it('允许手工填写市场进货价且不要求核算价和市场折扣', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: '78',
      marketPurchasePriceMode: '手工覆盖',
      marketPurchasePriceOverrideReason: '历史维护',
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      marketPurchasePrice: 123,
      marketPurchasePriceMode: '手工覆盖',
      marketPurchasePriceOverrideReason: '供应商临时调价',
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      marketPurchasePrice: '123',
    }))
  })

  it('手工市场进货价优先于核算价和市场折扣公式', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: '4000',
      marketPurchaseDiscount: '0.25',
      marketPurchasePrice: '1000',
      marketPurchasePriceMode: '手工覆盖',
      marketPurchasePriceOverrideReason: '历史维护',
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      accountingPrice: 5000,
      marketPurchaseDiscount: 25,
      marketPurchasePrice: 1200,
      marketPurchasePriceMode: '手工覆盖',
      marketPurchasePriceOverrideReason: '合同结算价',
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      accountingPrice: '5000',
      marketPurchaseDiscount: '25',
      marketPurchasePrice: '1200',
    }))
  })

  it('市场进货价留空且公式完整时自动计算', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: null,
      marketPurchasePriceMode: '公式',
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      accountingPrice: 4000,
      marketPurchaseDiscount: 25,
      marketPurchasePrice: null,
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      marketPurchasePrice: '1000',
    }))
  })

  it('核算价或市场折扣单独填写时允许保存并保留现有市场进货价', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: '78',
      marketPurchasePriceMode: '公式',
      marketPurchasePriceOverrideReason: null,
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      accountingPrice: 100,
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      accountingPrice: '100',
      marketPurchasePrice: null,
    }))
  })

  it('明确清空市场进货价且公式不完整时保存为空', async () => {
    const set = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }))
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: '4000',
      marketPurchaseDiscount: '0.25',
      marketPurchasePrice: '1000',
      sourceType: '供应链',
      ownerMarketId: null,
    }]))
    mockDb.update.mockReturnValue({ set })

    await updateInventorySku('SKU-1', {
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: null,
    })

    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      accountingPrice: null,
      marketPurchaseDiscount: null,
      marketPurchasePrice: null,
    }))
  })

  it('福利方案不能传入市场基础价覆盖产品资料', async () => {
    await expect(createInventoryPromotionPlan({
      name: '福利方案',
      startsAt: '2026-08-01',
      endsAt: '2026-08-31',
      items: [{
        skuId: 'SKU-1',
        marketUnitDiscount: 10,
        marketBasePrice: 1,
      }],
    } as never)).rejects.toThrow('福利方案只允许设置单价优惠')
  })

  it('组合福利必须配置至少两种不同产品且每项都有数量下限', async () => {
    const baseInput = {
      name: '组合福利',
      startsAt: '2026-08-01',
      endsAt: '2026-08-31',
      ruleType: '组合' as const,
    }

    await expect(createInventoryPromotionPlan({
      ...baseInput,
      items: [{ skuId: 'SKU-1', marketUnitDiscount: 10, reportMinQuantity: 1 }],
    })).rejects.toThrow('组合福利至少需要两条不同产品明细')

    await expect(createInventoryPromotionPlan({
      ...baseInput,
      items: [
        { skuId: 'SKU-1', marketUnitDiscount: 10, reportMinQuantity: 1 },
        { skuId: 'SKU-1', marketUnitDiscount: 5, reportMinQuantity: 1 },
      ],
    })).rejects.toThrow('组合福利中同一产品只能出现一次')

    await expect(createInventoryPromotionPlan({
      ...baseInput,
      items: [
        { skuId: 'SKU-1', marketUnitDiscount: 10, reportMinQuantity: 1 },
        { skuId: 'SKU-2', marketUnitDiscount: 5 },
      ],
    })).rejects.toThrow('组合福利必须填写每个产品的数量下限')
  })

  it('福利方案创建和更新必须具备价格查看权限', async () => {
    vi.mocked(isAdminScope).mockReturnValue(false)
    vi.mocked(hasPermission).mockReturnValue(false)
    const input = {
      name: '福利方案',
      startsAt: '2026-08-01',
      endsAt: '2026-08-31',
      items: [{ skuId: 'SKU-1', marketUnitDiscount: 10 }],
    }

    await expect(createInventoryPromotionPlan(input)).rejects.toThrow('无权设置市场报货福利价格')
    await expect(updateInventoryPromotionPlan('PROMO-1', input)).rejects.toThrow('无权设置市场报货福利价格')
    expect(mockDb.select).not.toHaveBeenCalled()
  })
})

describe('库存可用量与收货复核', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.execute.mockResolvedValue([])
    mockDb.select.mockReset()
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: '总部' }]))
    mockDb.transaction.mockReset()
  })

  it('通用建单忽略客户端金额并按锁定批次派生明细和表头金额', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        ...lotRow(),
        supply_chain_unit_cost: '20',
        market_standard_unit_price: '60',
        market_unit_discount: '6',
        market_actual_unit_price: '54',
        store_standard_unit_price: '50',
        store_unit_discount: '5',
        store_actual_unit_price: '45',
      }])
      .mockResolvedValueOnce([{
        product_name: '测试 SKU',
        source_type: '供应链',
        owner_market_id: null,
      }])
      .mockResolvedValueOnce([{ quantity: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
    const headerValues = vi.fn().mockResolvedValue(undefined)
    const itemValues = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 1 }]) }))
    const totalAmountWhere = vi.fn().mockResolvedValue(undefined)
    const totalAmountSet = vi.fn(() => ({ where: totalAmountWhere }))
    const txInsert = vi.fn()
      .mockReturnValueOnce({ values: headerValues })
      .mockReturnValueOnce({ values: itemValues })
    const txUpdate = vi.fn(() => ({ set: totalAmountSet }))
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
      insert: txInsert,
      update: txUpdate,
    }))

    await createInventoryCoreDoc({
      docType: '内部领用',
      sourceLocationId: 'HQ',
      totalAmount: 9999,
      items: [{
        skuId: 'SKU-1',
        lotId: 1,
        quantity: 2,
        standardUnitPrice: 999,
        unitDiscount: 999,
        actualUnitPrice: 999,
        amount: 9999,
        supplyChainUnitCost: 999,
        marketStandardUnitPrice: 999,
        marketUnitDiscount: 999,
        marketActualUnitPrice: 999,
        storeStandardUnitPrice: 999,
        storeUnitDiscount: 999,
        storeActualUnitPrice: 999,
      }],
    })

    expect(headerValues).toHaveBeenCalledWith(expect.objectContaining({ totalAmount: null }))
    expect(itemValues).toHaveBeenCalledWith(expect.objectContaining({
      standardUnitPrice: '50',
      unitDiscount: '5',
      actualUnitPrice: '45',
      amount: '90',
      supplyChainUnitCost: '20',
      marketActualUnitPrice: '54',
      storeActualUnitPrice: '45',
    }))
    expect(totalAmountSet).toHaveBeenCalledWith(expect.objectContaining({ totalAmount: '90' }))
    expect(totalAmountWhere).toHaveBeenCalled()
  })

  it('通用出库不得耗用已被退货预留的库存', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([lotRow()])
      .mockResolvedValueOnce([{
        product_name: '测试 SKU',
        source_type: '供应链',
        owner_market_id: null,
      }])
      .mockResolvedValueOnce([{ quantity: '5' }])
    const txInsert = vi.fn()
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({
        values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 1 }]) })),
      })
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
      insert: txInsert,
    }))

    await expect(createInventoryCoreDoc({
      docType: '内部领用',
      sourceLocationId: 'HQ',
      items: [{ skuId: 'SKU-1', lotId: 1, quantity: 6 }],
    } as never)).rejects.toThrow('库存不足：测试 SKU 可用 5')
  })

  it('通用审批出库不得耗用已被退货预留的库存', async () => {
    const txExecute = vi.fn()
      .mockResolvedValueOnce([{
        id: 'MBS-260809-0001',
        doc_type: '市场产品报损',
        status: '待审批',
        source_location_id: 'MARKET-1',
      }])
      .mockResolvedValueOnce([{ id: 1, lot_id: 1, quantity: '6' }])
      .mockResolvedValueOnce([lotRow()])
      .mockResolvedValueOnce([{ quantity: '5' }])
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
    }))

    await expect(approveInventoryCoreDoc('MBS-260809-0001'))
      .rejects.toThrow('库存不足：测试 SKU 可用 5')
  })

  it('收货确认会拒绝历史异常的分院调货单', async () => {
    const txExecute = vi.fn().mockResolvedValueOnce([{
      id: 'DTO-260809-0001',
      doc_type: '分院调货出库',
      status: '待收货',
      source_location_id: 'MARKET-1',
      target_location_id: 'STORE-1',
      total_quantity: '1',
      remark: null,
    }])
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: initializedCutoverExecutor(txExecute),
    }))
    mockDb.select.mockImplementation(() => selectWithoutLimit([
      { locationId: 'MARKET-1', locationType: '市场', parentLocationId: 'HQ' },
      { locationId: 'STORE-1', locationType: '门店', parentLocationId: 'MARKET-1' },
    ]))

    await expect(confirmInventoryCoreReceive('DTO-260809-0001'))
      .rejects.toThrow('分院调货的出入库主体必须均为门店')
  })
})

describe('库存主体启停同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.execute.mockResolvedValue([])
  })

  it('运行时同步继承组织停用与门店闭店状态', async () => {
    await syncInventoryLocations()

    const [orgSql, storeSql] = mockDb.execute.mock.calls.map(([query]) => renderSql(query))
    expect(orgSql).toContain('parent_location_id, is_active')
    expect(orgSql).toContain('SELECT id, type, name, id, parent_id, is_active')
    expect(orgSql).toContain('is_active = EXCLUDED.is_active')
    expect(storeSql).toContain('parent_location_id, is_active')
    expect(storeSql).toContain('COALESCE(o.is_active, false) AND NOT s.is_closed')
    expect(storeSql).toContain('is_active = EXCLUDED.is_active')
  })

  it('库存主体加固迁移使用与运行时相同的库存主体启停规则', () => {
    const migration = readFileSync(
      resolve(process.cwd(), '../db/migrations/0009_inventory_integrity_guards.sql'),
      'utf8',
    )

    expect(migration).toContain('location_id, location_type, name, org_node_id, parent_location_id, is_active')
    expect(migration).toContain('SELECT node.id, node.type, node.name, node.id, node.parent_id, node.is_active')
    expect(migration).toContain('COALESCE(node.is_active, false) AND NOT store.is_closed')
    expect(migration).toContain('is_active = EXCLUDED.is_active')
  })
})

describe('库存主体筛选 scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(false)
    mockDb.execute.mockResolvedValue([])
  })

  it('使用当前 action 收紧后的市场和门店 scope 生成选项', async () => {
    mockGetSession.mockResolvedValue({
      employeeId: 'E001',
      name: '市场用户',
      phone: '13800000000',
      roles: [{
        role: 'finance',
        scopeId: 'M1',
        scopeType: '市场',
        actions: ['inventory:stock_list'],
        scopeStoreIds: ['S1'],
        scopeOrgNodeIds: ['M1', 'N-S1'],
      }],
      permissions: {
        actions: ['inventory:stock_list'],
        scopeStoreIds: ['S1'],
        scopeOrgNodeIds: ['M1', 'N-S1'],
      },
    })
    mockDb.select.mockReturnValue(selectWithOrder([
      { locationId: 'HQ', locationType: '总部', name: '总部', orgNodeId: 'HQ', storeId: null, parentLocationId: null, isActive: true },
      { locationId: 'M1', locationType: '市场', name: '南昌市场', orgNodeId: 'M1', storeId: null, parentLocationId: 'HQ', isActive: true },
      { locationId: 'M2', locationType: '市场', name: '九江市场', orgNodeId: 'M2', storeId: null, parentLocationId: 'HQ', isActive: true },
      { locationId: 'S1', locationType: '门店', name: '红谷滩店', orgNodeId: 'N-S1', storeId: 'S1', parentLocationId: 'M1', isActive: true },
      { locationId: 'S2', locationType: '门店', name: '九江店', orgNodeId: 'N-S2', storeId: 'S2', parentLocationId: 'M2', isActive: true },
    ]))

    await expect(listInventoryLocationFilterOptions()).resolves.toEqual({
      headquarters: [],
      markets: [{
        locationId: 'M1',
        name: '南昌市场',
        canSelectInventory: true,
        stores: [{ locationId: 'S1', name: '红谷滩店' }],
      }],
      defaultLocationId: 'M1',
    })
  })
})

describe('库存单据详情履约进度', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(true)
    mockGetSession.mockResolvedValue(SESSION)
    mockDb.select.mockReset()
    mockDb.execute.mockReset()
  })

  it('市场报货返回可见血缘及正常、赠送发货收货进度', async () => {
    const now = new Date('2026-08-09T09:00:00.000Z')
    vi.mocked(isAdminScope).mockReturnValue(false)
    mockGetSession.mockResolvedValue({
      employeeId: 'E001',
      name: '测试用户',
      phone: '13800000000',
      roles: [{ role: 'manager', scopeId: 'MARKET-1', scopeType: '市场' }],
      permissions: { actions: ['inventory:list'], scopeStoreIds: [] },
    } as never)
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'MBH-260809-0001',
          docType: '市场报货',
          status: '已完成',
          sourceLocationId: 'MARKET-1',
          targetLocationId: 'HQ',
          marketId: 'MARKET-1',
          supplierId: null,
          docDate: '2026-08-09',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: null,
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '10',
          totalAmount: '0',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: now,
          approvedAt: null,
          rejectedAt: null,
          cancellationReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
        sourceLocationName: '测试市场',
        sourceLocationType: '市场',
        targetLocationName: '供应链总部',
        targetLocationType: '总部',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 101,
        docId: 'MBH-260809-0001',
        lotId: null,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '测试产品',
        specName: null,
        supplier: null,
        productSeries: null,
        batchNo: '',
        expiryDate: null,
        isGift: false,
        quantity: '10',
        stockSnapshot: null,
        requestQuantity: null,
        fulfilledQuantity: '8',
        standardUnitPrice: '100',
        unitDiscount: '0',
        actualUnitPrice: '100',
        amount: '1000',
        supplyChainUnitCost: null,
        marketActualUnitPrice: '100',
        storeActualUnitPrice: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))
    mockDb.execute
      .mockResolvedValueOnce([{
        direction: '下游',
        relation_type: '市场报货采购订单',
        doc_id: 'CGD-260809-0001',
        doc_type: '采购订单',
        status: '已完成',
        // UTC 晚间仍属于上海次日，血缘单据日期必须按 Asia/Shanghai 取值。
        doc_date: new Date('2026-08-08T16:30:00.000Z'),
        total_quantity: '8',
        linked_quantity: '8',
      }])
      .mockResolvedValueOnce([{
        item_id: 101,
        normal_demand_quantity: '10',
        ordered_quantity: '8',
        normal_fulfilled_quantity: '7',
        gift_fulfilled_quantity: '2',
        normal_received_quantity: '5',
        gift_received_quantity: '1',
      }])

    const detail = await getInventoryCoreDocById('MBH-260809-0001')

    expect(detail?.lineage).toEqual([expect.objectContaining({
      direction: '下游',
      relationType: '市场报货采购订单',
      docId: 'CGD-260809-0001',
      docDate: '2026-08-09',
      linkedQuantity: 8,
    })])
    expect(detail?.fulfillmentProgress).toEqual({
      kind: '报货履约',
      items: [{
        itemId: 101,
        normalDemandQuantity: 10,
        orderedQuantity: 8,
        normalFulfilledQuantity: 7,
        giftFulfilledQuantity: 2,
        normalReceivedQuantity: 5,
        giftReceivedQuantity: 1,
      }],
    })

    const [lineageQuery, fulfillmentQuery] = mockDb.execute.mock.calls.map(([query]) => query)
    const lineageSql = renderSql(lineageQuery)
    const fulfillmentSql = renderSql(fulfillmentQuery)
    expect(lineageSql).toContain('inventory_doc_links')
    expect(sqlContains(lineageQuery, 'to_doc.source_location_id')).toBe(true)
    expect(sqlContains(lineageQuery, 'from_doc.target_location_id')).toBe(true)
    expect(fulfillmentSql).toContain('visible_docs')
    expect(sqlContains(fulfillmentQuery, 'visible_doc.source_location_id')).toBe(true)
    expect(fulfillmentSql).toContain('采购订单赠送发货')
    expect(fulfillmentSql).toContain("receipt_doc.status = '已完成'")
  })

  it('供应链采购订单按关联入库单聚合已收与待收数量', async () => {
    const now = new Date('2026-08-10T09:00:00.000Z')
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'PCG-260810-0001',
          docType: '供应链采购订单',
          status: '待收货',
          sourceLocationId: null,
          targetLocationId: 'HQ',
          marketId: null,
          supplierId: 'SUP-1',
          docDate: '2026-08-10',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: '测试供应商',
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '10',
          totalAmount: '1000',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: now,
          approvedAt: null,
          rejectedAt: null,
          cancellationReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
        sourceLocationName: null,
        sourceLocationType: null,
        targetLocationName: '供应链总部',
        targetLocationType: '总部',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 201,
        docId: 'PCG-260810-0001',
        lotId: null,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '供应链产品',
        specName: null,
        supplier: '测试供应商',
        productSeries: null,
        batchNo: '',
        expiryDate: null,
        isGift: false,
        quantity: '10',
        stockSnapshot: null,
        requestQuantity: '10',
        fulfilledQuantity: '4',
        standardUnitPrice: '100',
        unitDiscount: null,
        actualUnitPrice: '100',
        amount: '1000',
        supplyChainUnitCost: '100',
        marketActualUnitPrice: null,
        storeActualUnitPrice: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))
    mockDb.execute
      .mockResolvedValueOnce([{
        direction: '上游',
        relation_type: '品项公司报货采购订单',
        doc_id: 'ZBH-260810-0001',
        doc_type: '品项公司报货需求',
        status: '已完成',
        doc_date: '2026-08-10',
        total_quantity: '10',
        linked_quantity: '10',
      }])
      .mockResolvedValueOnce([{
        item_id: 201,
        purchased_quantity: '10',
        received_quantity: '4',
        purchase_status: '待收货',
      }])

    const detail = await getInventoryCoreDocById('PCG-260810-0001')

    expect(detail?.lineage).toEqual([expect.objectContaining({
      direction: '上游',
      relationType: '品项公司报货采购订单',
      docId: 'ZBH-260810-0001',
    })])
    expect(detail?.fulfillmentProgress).toEqual({
      kind: '供应链采购收货',
      items: [{
        itemId: 201,
        purchasedQuantity: 10,
        receivedQuantity: 4,
        outstandingQuantity: 6,
      }],
    })

    const [, fulfillmentQuery] = mockDb.execute.mock.calls.map(([query]) => query)
    expect(sqlContains(fulfillmentQuery, '采购订单供应链采购入库')).toBe(true)
    expect(sqlContains(fulfillmentQuery, "receipt_doc.status = '已完成'")).toBe(true)
  })

  it('已取消的品项公司发货不再显示待收数量', async () => {
    const now = new Date('2026-08-10T09:00:00.000Z')
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'GFH-260810-0001',
          docType: '品项公司发货',
          status: '已取消',
          sourceLocationId: 'HQ',
          targetLocationId: 'MARKET-1',
          marketId: 'MARKET-1',
          supplierId: null,
          docDate: '2026-08-10',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: null,
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '10',
          totalAmount: '0',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: now,
          approvedAt: null,
          rejectedAt: null,
          cancellationReason: '市场收货前发现错发',
          cancelledAt: now,
          createdAt: now,
          updatedAt: now,
        },
        sourceLocationName: '供应链总部',
        sourceLocationType: '总部',
        targetLocationName: '测试市场',
        targetLocationType: '市场',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 401,
        docId: 'GFH-260810-0001',
        lotId: 1,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '供应链产品',
        specName: null,
        supplier: null,
        productSeries: null,
        batchNo: 'B-1',
        expiryDate: null,
        isGift: false,
        quantity: '10',
        stockSnapshot: null,
        requestQuantity: '10',
        fulfilledQuantity: '0',
        standardUnitPrice: null,
        unitDiscount: null,
        actualUnitPrice: null,
        amount: null,
        supplyChainUnitCost: null,
        marketActualUnitPrice: null,
        storeActualUnitPrice: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))
    mockDb.execute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        item_id: 401,
        shipped_quantity: '10',
        received_quantity: '0',
        shipment_status: '已取消',
      }])

    const detail = await getInventoryCoreDocById('GFH-260810-0001')

    expect(detail?.fulfillmentProgress).toEqual({
      kind: '发货收货',
      items: [{
        itemId: 401,
        shippedQuantity: 10,
        receivedQuantity: 0,
        outstandingQuantity: 0,
      }],
    })
    const [, fulfillmentQuery] = mockDb.execute.mock.calls.map(([query]) => query)
    expect(sqlContains(fulfillmentQuery, 'shipment_doc.status AS shipment_status')).toBe(true)
  })

  it('品项公司报货需求按采购订单与分批入库聚合履约数量', async () => {
    const now = new Date('2026-08-10T09:00:00.000Z')
    mockDb.select
      .mockReturnValueOnce(detailHeadSelect([{
        doc: {
          id: 'ZBH-260810-0001',
          docType: '品项公司报货需求',
          status: '已完成',
          sourceLocationId: null,
          targetLocationId: 'HQ',
          marketId: null,
          supplierId: null,
          docDate: '2026-08-10',
          relatedSaleOrderId: null,
          customerName: null,
          employeeName: null,
          supplierName: null,
          externalPartyName: null,
          logisticsCompany: null,
          trackingNo: null,
          receiptAttachmentUrl: null,
          totalQuantity: '12',
          totalAmount: '1200',
          remark: null,
          auditRemark: null,
          createdBy: 'E001',
          confirmedAt: now,
          approvedAt: null,
          rejectedAt: null,
          cancellationReason: null,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
        sourceLocationName: null,
        sourceLocationType: null,
        targetLocationName: '供应链总部',
        targetLocationType: '总部',
      }]))
      .mockReturnValueOnce(detailItemsSelect([{
        id: 301,
        docId: 'ZBH-260810-0001',
        lotId: null,
        skuId: 'SKU-1',
        saleItemId: null,
        skuName: '供应链产品',
        specName: null,
        supplier: null,
        productSeries: null,
        batchNo: '',
        expiryDate: null,
        isGift: false,
        quantity: '12',
        stockSnapshot: null,
        requestQuantity: '12',
        fulfilledQuantity: '10',
        standardUnitPrice: '100',
        unitDiscount: null,
        actualUnitPrice: '100',
        amount: '1200',
        supplyChainUnitCost: '100',
        marketActualUnitPrice: null,
        storeActualUnitPrice: null,
        reason: null,
        remark: null,
        createdAt: now,
      }]))
    mockDb.execute
      .mockResolvedValueOnce([{
        direction: '下游',
        relation_type: '品项公司报货采购订单',
        doc_id: 'PCG-260810-0001',
        doc_type: '供应链采购订单',
        status: '待收货',
        doc_date: '2026-08-10',
        total_quantity: '10',
        linked_quantity: '10',
      }])
      .mockResolvedValueOnce([{
        item_id: 301,
        demand_quantity: '12',
        ordered_quantity: '10',
        received_quantity: '6',
      }])

    const detail = await getInventoryCoreDocById('ZBH-260810-0001')

    expect(detail?.fulfillmentProgress).toEqual({
      kind: '品项公司报货履约',
      items: [{
        itemId: 301,
        demandQuantity: 12,
        orderedQuantity: 10,
        receivedQuantity: 6,
      }],
    })

    const [, fulfillmentQuery] = mockDb.execute.mock.calls.map(([query]) => query)
    expect(sqlContains(fulfillmentQuery, '品项公司报货采购订单')).toBe(true)
    expect(sqlContains(fulfillmentQuery, '采购订单供应链采购入库')).toBe(true)
    expect(sqlContains(fulfillmentQuery, "purchase_doc.status IN ('待收货', '已完成', '已取消')")).toBe(true)
  })
})

describe('全局福利方案引擎权限', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(false)
    vi.mocked(hasPermission).mockReturnValue(true)
    mockGetSession.mockResolvedValue({
      employeeId: 'E002',
      name: '市场用户',
      phone: '13800000001',
      roles: [{ role: 'manager', scopeId: 'MARKET-1', scopeType: '市场' }],
      permissions: { actions: ['inventory:market_operate', 'inventory:market_price_view'], scopeStoreIds: [] },
    })
    mockDb.select.mockReset()
    mockDb.transaction.mockReset()
  })

  it('市场用户直调引擎时不能停用全局福利方案', async () => {
    const now = new Date()
    mockDb.select
      .mockReturnValueOnce(promotionPlanSelect([{
        id: 'INV-PROMO-GLOBAL',
        planNo: 'GLOBAL-1',
        name: '全局方案',
        startsAt: '2026-01-01',
        endsAt: '2026-12-31',
        scopeMarketId: null,
        scopeMarketName: null,
        status: '启用',
        remark: null,
        createdAt: now,
        updatedAt: now,
      }]))
      .mockReturnValueOnce(promotionItemSelect([]))
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockResolvedValue([{ scope_market_id: null }]),
    }))

    await expect(disableInventoryPromotionPlan('INV-PROMO-GLOBAL'))
      .rejects.toThrow('市场用户不能修改或停用全局福利方案')
  })

  it('市场用户直调引擎时不能修改全局福利方案', async () => {
    const now = new Date()
    mockDb.execute.mockResolvedValue([])
    mockDb.select
      .mockReturnValueOnce(promotionPlanSelect([{
        id: 'INV-PROMO-GLOBAL',
        planNo: 'GLOBAL-1',
        name: '全局方案',
        startsAt: '2026-01-01',
        endsAt: '2026-12-31',
        scopeMarketId: null,
        scopeMarketName: null,
        status: '启用',
        remark: null,
        createdAt: now,
        updatedAt: now,
      }]))
      .mockReturnValueOnce(promotionItemSelect([]))
      .mockReturnValueOnce(selectWithLimit([{ locationType: '市场' }]))
      .mockReturnValueOnce(selectWithoutLimit([]))
      .mockReturnValueOnce(selectWithoutLimit([{ skuId: 'SKU-1' }]))
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockResolvedValue([{ scope_market_id: null }]),
    }))

    await expect(updateInventoryPromotionPlan('INV-PROMO-GLOBAL', {
      name: '修改后的全局方案',
      startsAt: '2026-01-01',
      endsAt: '2026-12-31',
      scopeMarketId: 'MARKET-1',
      items: [{ skuId: 'SKU-1', marketUnitDiscount: 0 }],
    })).rejects.toThrow('市场用户不能修改或停用全局福利方案')
  })
})
