import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * #341：提货冻结出库金额（createPickupRecord 写入）与提货记录导出（exportPickupRecords keyset 分页）。
 * 金额算法本身见 lib/pickup-amount.test.ts；四个写入点与 staffApi 的一致性由
 * staffApi cross-end-sql-snapshot「#341」段守护。本文件只钉住 action 的接线。
 */

vi.mock('@/db', () => ({
  db: { select: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
}))

vi.mock('@db/pickup', () => ({
  pickupRecords: {
    id: 'pickup_records.id',
    saleItemId: 'pickup_records.sale_item_id',
    pickupQuantity: 'pickup_records.pickup_quantity',
    storeId: 'pickup_records.store_id',
    clientUserId: 'pickup_records.client_user_id',
    confirmedBy: 'pickup_records.confirmed_by',
    createdAt: 'pickup_records.created_at',
    pickupUnitPrice: 'pickup_records.pickup_unit_price',
    pickupAmount: 'pickup_records.pickup_amount',
  },
}))

vi.mock('@db/order', () => ({
  saleItems: {
    saleItemId: 'sale_items.sale_item_id',
    saleOrderId: 'sale_items.sale_order_id',
    skuId: 'sale_items.sku_id',
    productName: 'sale_items.product_name',
  },
}))

vi.mock('@db/org', () => ({ stores: { storeId: 'stores.store_id', storeName: 'stores.store_name' } }))

vi.mock('@db/user', () => ({
  clientWechatUsers: { userId: 'cu.user_id', name: 'cu.name', phone: 'cu.phone' },
  staffWechatUsers: { employeeId: 'su.employee_id', name: 'su.name' },
}))

vi.mock('@db/product', () => ({ productSkus: { skuId: 'ps.sku_id', specName: 'ps.spec_name' } }))

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args) => ({ type: 'and', args })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  gte: vi.fn((a, b) => ({ type: 'gte', a, b })),
  ilike: vi.fn((a, b) => ({ type: 'ilike', a, b })),
  lt: vi.fn((a, b) => ({ type: 'lt', a, b })),
  lte: vi.fn((a, b) => ({ type: 'lte', a, b })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      __sqlText: strings.join('?'),
      values,
    })),
    { raw: vi.fn(), join: vi.fn(), param: vi.fn() },
  ),
}))

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }))

vi.mock('@/lib/permissions', () => ({
  requirePermission: vi.fn(),
  requireAdmin: vi.fn(),
  scopeCondition: vi.fn(() => ({ type: 'scope' })),
  isInScope: vi.fn(() => true),
}))

vi.mock('@/lib/market-store-sql', () => ({
  storeInMarketCondition: vi.fn((col, marketId) => ({ type: 'market', col, marketId })),
}))

vi.mock('@/lib/operation-log', () => ({ logOperation: vi.fn() }))
vi.mock('@/lib/refund-cascade', () => ({ hasPendingRefund: vi.fn(async () => false) }))
// record-only：联动开关关闭时照样冻结金额（验收 5）
vi.mock('@/lib/inventory-feature-flags', () => ({ INVENTORY_LINKAGE_ENABLED: false }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createPickupRecord, exportPickupRecords } from './pickup-records'
import { db } from '@/db'
import { getSession } from '@/lib/auth'
import { lt } from 'drizzle-orm'

const session = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['pickup_record:list', 'pickup_record:create'], scopeStoreIds: ['store-1'] },
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(getSession as any).mockResolvedValue(session)
})

describe('#341 createPickupRecord 冻结出库金额（联动开关关闭 / record-only）', () => {
  it('unit_real_price=88.50 提货 2 件 → pickup_records 写入 88.50 / 177.00', async () => {
    ;(db.execute as any).mockResolvedValueOnce([{ sale_order_id: 'SO-1' }])
    const inserted: any[] = []
    const tx = {
      execute: vi.fn()
        // ① 锁行（postgres.js 把 numeric 原样返回字符串）
        .mockResolvedValueOnce([{
          sale_item_id: 'SI-1', sale_order_id: 'SO-1', sku_id: 'SKU-1', product_name: '家居A',
          product_type: '家居产品', item_direction: '购买', quantity: 5, picked_up_quantity: 0,
          settled_quantity: 0, sale_amount: '442.50', unit_real_price: '88.50', received: '442.50',
          paid_quantity: 5, sale_order_type: '普通单', order_status: '已支付',
          client_user_id: 'CU-1', customer_name: '顾客A',
        }])
        // ② 锁后查已转走金额
        .mockResolvedValueOnce([{ sale_item_id: 'SI-1', converted_amount: '0' }])
        // ③ UPDATE sale_items RETURNING
        .mockResolvedValueOnce([{
          sale_item_id: 'SI-1', sale_order_id: 'SO-1', sku_id: 'SKU-1', product_name: '家居A',
          quantity: 5, picked_up_quantity: 2, inventory_composition_snapshot: null,
        }]),
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          inserted.push(values)
          return { returning: vi.fn(async () => [{ id: 77 }]) }
        }),
      })),
    }
    ;(db.transaction as any).mockImplementation(async (cb: any) => cb(tx))

    const result = await createPickupRecord({
      saleItemId: 'SI-1', pickupQuantity: 2, storeId: 'store-1', clientUserId: 'CU-1',
    })

    expect(result).toMatchObject({ success: true, createdId: 77 })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ pickupQuantity: 2, pickupUnitPrice: '88.50', pickupAmount: '177.00' })
  })
})

describe('#341 exportPickupRecords keyset 分页', () => {
  function mockExportRows(rows: any[]) {
    const chain: any = Object.assign(Promise.resolve(rows), {})
    chain.from = vi.fn().mockReturnValue(chain)
    chain.leftJoin = vi.fn().mockReturnValue(chain)
    chain.where = vi.fn().mockReturnValue(chain)
    chain.orderBy = vi.fn().mockReturnValue(chain)
    chain.limit = vi.fn().mockResolvedValue(rows)
    ;(db.select as any).mockReturnValue(chain)
    return chain
  }
  const row = (id: number, amount: string | null) => ({
    id,
    createdAt: new Date('2026-09-25T02:00:00.000Z'),
    pickupQuantity: 2,
    pickupUnitPrice: amount == null ? null : '88.50',
    pickupAmount: amount,
    storeName: '一店',
    clientName: '顾客A',
    saleOrderId: 'SO-1',
    productName: '家居A',
  })

  it('多取一行探测，游标取本页末行 id；历史行金额保持 null', async () => {
    const chain = mockExportRows([row(30, '177.00'), row(20, null), row(10, '177.00')])

    const page = await exportPickupRecords({ store: 'store-1', from: '2026-09-01' }, { limit: 2 })

    expect(chain.limit).toHaveBeenCalledWith(3)
    expect(chain.orderBy).toHaveBeenCalledWith({ type: 'desc', col: 'pickup_records.id' })
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe(20)
    expect(page.rows).toEqual([
      expect.objectContaining({ pickupUnitPrice: '88.50', pickupAmount: '177.00', createdAt: '2026-09-25T02:00:00.000Z' }),
      expect.objectContaining({ pickupUnitPrice: null, pickupAmount: null }),
    ])
    expect(lt).not.toHaveBeenCalled()
  })

  it('带游标时追加 id < cursor；末页不再给游标', async () => {
    mockExportRows([row(10, '177.00')])

    const page = await exportPickupRecords({}, { limit: 2, cursor: 20 })

    expect(lt).toHaveBeenCalledWith('pickup_records.id', 20)
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeUndefined()
  })

  it('筛选条件与列表页同名参数、同一套条件（门店 / 市场 / 日期 / 搜索 / scope）', async () => {
    const chain = mockExportRows([])

    await exportPickupRecords({ market: 'M-1', store: 'store-1', q: '顾客', from: '2026-09-01', to: '2026-09-30' }, { limit: 2 })

    const where = chain.where.mock.calls[0][0]
    const conditions = where.args.filter(Boolean)
    expect(conditions.map((condition: any) => condition.type)).toEqual(['scope', 'market', 'eq', 'or', 'gte', 'lt'])
    // 结束日走半开区间「< 次日零点」，不是 `<= 23:59:59`（会漏最后一秒）
    expect(conditions[5].b.__sqlText).toContain('::date + 1')
    expect(conditions[5].b.values).toEqual(['2026-09-30'])
  })

  it.each([0, -1, 1.5, Number.NaN, '20' as unknown as number])('畸形游标 %s 直接拒绝，不静默从头重扫', async (cursor) => {
    mockExportRows([])
    await expect(exportPickupRecords({}, { limit: 2, cursor })).rejects.toThrow(/导出分页游标无效/)
    expect(db.select).not.toHaveBeenCalled()
  })
})
