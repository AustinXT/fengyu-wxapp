import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * #341：联动开关**开启**时的提货（#341 评审 round-1）——一次提货同时产出两样东西，缺一不可：
 *   ① pickup_records 冻结售价口径的出库金额（数量 × 顾客实际单价）；
 *   ② GCK 明细带锁定批次的价格快照（成本），actual_unit_price 不写、交给触发器算 amount，并记库存流水。
 * 删掉生产路径里的 createPickupInventoryDoc 调用、或改掉快照取值，这里必红。
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
vi.mock('@/lib/inventory-feature-flags', () => ({ INVENTORY_LINKAGE_ENABLED: true }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createPickupRecord } from './pickup-records'
import { db } from '@/db'
import { getSession } from '@/lib/auth'

const session = {
  employeeId: 'MGR-001',
  roles: [{ role: 'manager', scopeId: 'store-1' }],
  permissions: { actions: ['pickup_record:list', 'pickup_record:create'], scopeStoreIds: ['store-1'] },
}

const SNAPSHOT = {
  version: 1,
  components: [{ inventorySkuId: 'ISKU-1', productCode: 'I1', productName: '库存品', specName: null, quantityPerSaleUnit: 1 }],
}
// tx.execute 返回的 numeric 是字符串（postgres.js 原样），bigint id 也是字符串
const LOT = {
  id: '7', location_id: 'store-1', sku_id: 'ISKU-1', sku_name: '库存品', spec_name: null, supplier: null,
  product_series: null, batch_no: 'B1', expiry_date: null, is_gift: false, quantity_on_hand: '10.00',
  supply_chain_unit_cost: '12.00', market_standard_unit_price: '20.00', market_unit_discount: '1.00',
  market_actual_unit_price: '19.00', store_standard_unit_price: '32.00', store_unit_discount: '2.00',
  store_actual_unit_price: '30.00',
}
const SNAPSHOT_VALUES = ['12.00', '20.00', '1.00', '19.00', '32.00', '2.00', '30.00']

function lockedRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    sale_item_id: id, sale_item_group_id: null, sale_order_id: 'SO-1', sku_id: 'SKU-1', product_name: '家居A',
    product_type: '家居产品', item_direction: '购买', quantity: 5, picked_up_quantity: 0, settled_quantity: 0,
    sale_amount: '442.50', unit_real_price: '88.50', received: '442.50', paid_quantity: 5,
    sale_order_type: '普通单', order_status: '已支付', client_user_id: 'CU-1', customer_name: '顾客A',
    inventory_composition_snapshot: SNAPSHOT,
    ...extra,
  }
}

/** 按 SQL 文本分派 tx.execute（sql mock 把模板片段用 ? 拼接进 __sqlText） */
function makeTx(locked: any[]) {
  const executed: Array<{ text: string; values: unknown[] }> = []
  const inserted: any[] = []
  const tx = {
    execute: vi.fn(async (q: { __sqlText: string; values: unknown[] }) => {
      executed.push({ text: q.__sqlText, values: q.values })
      const t = q.__sqlText
      if (/FOR UPDATE OF si/.test(t)) return locked
      if (/AS converted_amount/.test(t)) return locked.map((row) => ({ sale_item_id: row.sale_item_id, converted_amount: '0' }))
      if (/UPDATE sale_items/.test(t)) {
        return [{ ...locked[0], sale_item_id: q.values[q.values.length - 1] ?? locked[0].sale_item_id, picked_up_quantity: 2 }]
      }
      if (/FROM inventory_locations/.test(t) && /SELECT org_node_id/.test(t)) return [{ org_node_id: 'ORG-ST-1' }]
      if (/FROM inventory_stock_lots lot/.test(t)) return [LOT]
      if (/FROM inventory_stock_reservations/.test(t)) return []
      if (/FROM inventory_docs/.test(t) && /LIKE/.test(t)) return []
      if (/INSERT INTO inventory_doc_items/.test(t)) return [{ id: '501' }]
      return []
    }),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        inserted.push(values)
        return { returning: vi.fn(async () => [{ id: 77 }]) }
      }),
    })),
  }
  return { tx, executed, inserted }
}

function assertGck(executed: Array<{ text: string; values: unknown[] }>, expectedQuantity: number) {
  const docItems = executed.filter((q) => /INSERT INTO inventory_doc_items/.test(q.text))
  expect(docItems).toHaveLength(1)
  const [item] = docItems
  expect(item.text).toMatch(/store_actual_unit_price/)
  // 只写批次快照列，不写 actual_unit_price —— 成本 amount 交给触发器按 store → market → 供应链 兜底
  expect(item.text).not.toMatch(/(^|[\s,(])actual_unit_price[\s,)]/)
  // 末 7 位是批次价格快照（成本），与售价口径的 88.50 无关
  expect(item.values.slice(-7)).toEqual(SNAPSHOT_VALUES)
  expect(item.values).toContain(expectedQuantity)
  const movements = executed.filter((q) => /INSERT INTO inventory_movements/.test(q.text))
  expect(movements).toHaveLength(1)
  expect(movements[0].values).toContain(-expectedQuantity)
  expect(executed.some((q) => /INSERT INTO inventory_docs/.test(q.text) && /院顾客产品出库/.test(q.text))).toBe(true)
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(getSession as any).mockResolvedValue(session)
})

describe('#341 联动开启：提货同时冻结售价金额并生成带成本快照的 GCK', () => {
  it('单件路径：88.50 × 2 → pickup 177.00；GCK 明细带门店成本快照 30.00、数量 2、库存流水 −2', async () => {
    ;(db.execute as any).mockResolvedValueOnce([{ sale_order_id: 'SO-1' }])
    const { tx, executed, inserted } = makeTx([lockedRow('SI-1')])
    ;(db.transaction as any).mockImplementation(async (cb: any) => cb(tx))

    const result = await createPickupRecord({ saleItemId: 'SI-1', pickupQuantity: 2, storeId: 'store-1', clientUserId: 'CU-1' })

    expect(result).toMatchObject({ success: true, createdId: 77 })
    expect(inserted).toEqual([expect.objectContaining({ pickupQuantity: 2, pickupUnitPrice: '88.50', pickupAmount: '177.00' })])
    assertGck(executed, 2)
  })

  it('合并路径：两条 quantity=1 来源 → 各冻结 19.99；GCK 一张、数量 2', async () => {
    const group = { sale_item_group_id: 'G-1', quantity: 1, sale_amount: '19.99', unit_real_price: '19.99', received: '19.99', paid_quantity: 1 }
    const { tx, executed, inserted } = makeTx([lockedRow('SI-A', group), lockedRow('SI-B', group)])
    ;(db.transaction as any).mockImplementation(async (cb: any) => cb(tx))

    const result = await createPickupRecord({
      saleItemId: 'SI-A', saleItemIds: ['SI-B', 'SI-A'], pickupQuantity: 2, storeId: 'store-1', clientUserId: 'CU-1',
    })

    expect(result.success).toBe(true)
    expect(inserted).toEqual([
      expect.objectContaining({ saleItemId: 'SI-A', pickupQuantity: 1, pickupUnitPrice: '19.99', pickupAmount: '19.99' }),
      expect.objectContaining({ saleItemId: 'SI-B', pickupQuantity: 1, pickupUnitPrice: '19.99', pickupAmount: '19.99' }),
    ])
    assertGck(executed, 2)
  })
})
