import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDb, mockGetSession } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(),
    select: vi.fn(),
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
  disableInventoryPromotionPlan,
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
    .map((chunk) => Array.isArray(chunk.value) ? chunk.value.join('') : String(chunk))
    .join('')
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

  it('专用单据不能经通用审批、驳回或收货入口绕过业务状态机', async () => {
    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockResolvedValueOnce([{
        id: 'YTH-260809-0001', doc_type: '院退货', status: '待审批', source_location_id: 'STORE-1',
      }]),
    }))
    await expect(approveInventoryCoreDoc('YTH-260809-0001'))
      .rejects.toThrow('必须通过对应的专用业务流程处理')

    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockResolvedValueOnce([{
        doc_type: '市场退货', status: '待审批', source_location_id: 'MARKET-1', target_location_id: 'HQ',
      }]),
    }))
    await expect(rejectInventoryCoreDoc('MTH-260809-0001'))
      .rejects.toThrow('必须通过对应的专用业务流程处理')

    mockDb.transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown) => callback({
      execute: vi.fn().mockResolvedValueOnce([{
        id: 'FPH-260809-0001', doc_type: '分院配货', status: '待收货',
        source_location_id: 'MARKET-1', target_location_id: 'STORE-1',
        total_quantity: '1', request_doc_id: 'DBH-1', remark: null,
      }]),
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

  it('供应链采购入库只能进入总部库存', async () => {
    mockDb.select.mockImplementation(() => selectWithLimit([{ locationType: '市场' }]))

    await expect(createInventoryCoreDoc({
      docType: '供应链采购入库',
      targetLocationId: 'market-A',
      items: [{ skuId: 'SKU-1', quantity: 1 }],
    } as never)).rejects.toThrow('供应链采购入库主体必须是总部')
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
      execute: txExecute,
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

  it('市场进货价不能脱离核算价和市场折扣手工写入', async () => {
    mockDb.select.mockImplementation(() => selectWithLimit([{
      accountingPrice: null,
      marketPurchaseDiscount: null,
      sourceType: '供应链',
      ownerMarketId: null,
    }]))

    await expect(updateInventorySku('SKU-1', {
      marketPurchasePrice: 123,
    })).rejects.toThrow('市场进货价由核算价和市场折扣计算')
  })

  it('福利方案不能传入市场基础价覆盖产品资料', async () => {
    await expect(createInventoryPromotionPlan({
      planNo: 'PROMO-1',
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

  it('福利方案创建和更新必须具备价格查看权限', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    const input = {
      planNo: 'PROMO-1',
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
      execute: txExecute,
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
      execute: txExecute,
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
      request_doc_id: null,
      remark: null,
    }])
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      execute: txExecute,
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

  it('初始迁移使用与运行时相同的库存主体启停规则', () => {
    const migration = readFileSync(
      resolve(process.cwd(), '../db/migrations/0005_futuristic_mauler.sql'),
      'utf8',
    )

    expect(migration).toContain('parent_location_id, is_active)')
    expect(migration).toContain('SELECT id, type, name, id, parent_id, is_active')
    expect(migration).toContain('COALESCE(o.is_active, false) AND NOT s.is_closed')
    expect(migration.match(/is_active = EXCLUDED\.is_active/g)).toHaveLength(2)
  })
})

describe('全局福利方案引擎权限', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdminScope).mockReturnValue(false)
    mockGetSession.mockResolvedValue({
      employeeId: 'E002',
      name: '市场用户',
      phone: '13800000001',
      roles: [{ role: 'manager', scopeId: 'MARKET-1', scopeType: '市场' }],
      permissions: { actions: ['inventory:update'], scopeStoreIds: [] },
    })
    mockDb.select.mockReset()
    mockDb.transaction.mockReset()
  })

  it('市场用户直调引擎时不能停用全局福利方案', async () => {
    const now = new Date()
    mockDb.select
      .mockReturnValueOnce(selectWithoutLimit([]))
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
      .mockReturnValueOnce(selectWithoutLimit([]))
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
      planNo: 'GLOBAL-2',
      name: '修改后的全局方案',
      startsAt: '2026-01-01',
      endsAt: '2026-12-31',
      scopeMarketId: 'MARKET-1',
      items: [{ skuId: 'SKU-1', marketUnitDiscount: 0 }],
    })).rejects.toThrow('市场用户不能修改或停用全局福利方案')
  })
})
