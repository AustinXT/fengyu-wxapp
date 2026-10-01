/**
 * #341 联动开关**关闭**（record-only）时的提货：不生成 GCK、不扣批次，但 pickup_records 照样冻结
 * 「数量 × 顾客实际单价」（验收 5「不依赖联动开关」）。
 *
 * __tests__/setup.js 全局把 INVENTORY_LINKAGE_ENABLED 设为 true（其余用例测联动开启），而 feature-flags
 * 在模块加载期求值一次——所以这里把 feature-flags 换成关闭态桩、重新加载 order.js，结束后还原缓存。
 */
const path = require('path')
const pg = globalThis.__mocks__.pg
const { createManagerCtx } = require('../helpers')

const flagsPath = require.resolve('../../utils/feature-flags')
const orderPath = require.resolve('../../routes/order')
let orderRoutes
let savedFlags
let savedOrder

beforeAll(() => {
  savedFlags = require.cache[flagsPath]
  savedOrder = require.cache[orderPath]
  require.cache[flagsPath] = { id: flagsPath, filename: flagsPath, loaded: true, exports: { INVENTORY_LINKAGE_ENABLED: false } }
  delete require.cache[orderPath]
  orderRoutes = require(path.resolve(__dirname, '../../routes/order'))
})

afterAll(() => {
  if (savedFlags) require.cache[flagsPath] = savedFlags
  else delete require.cache[flagsPath]
  if (savedOrder) require.cache[orderPath] = savedOrder
  else delete require.cache[orderPath]
})

function recordOnlyClient(lockedRows) {
  return {
    query: vi.fn(async (sql, params) => {
      if (/FOR UPDATE OF si/.test(sql) && /AS paid_quantity/.test(sql)) return { rows: lockedRows, rowCount: lockedRows.length }
      if (/AS converted_amount/.test(sql)) {
        return { rows: lockedRows.map((row) => ({ sale_item_id: row.sale_item_id, converted_amount: 0 })), rowCount: lockedRows.length }
      }
      if (/UPDATE sale_items/.test(sql)) {
        return { rows: [{ ...lockedRows[0], sale_item_id: params[params.length - 1], picked_up_quantity: 2 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }),
  }
}

const locked = (id, extra = {}) => ({
  sale_item_id: id, sale_item_group_id: null, sale_order_id: 'FY-001', store_id: 'store-001', sku_id: 'sku-001',
  product_name: '家居A', product_type: '家居产品', item_direction: '购买', quantity: 5, picked_up_quantity: 0,
  settled_quantity: 0, sale_amount: 442.5, unit_real_price: 88.5, received: 442.5, paid_quantity: 5,
  sale_order_type: '销售单', order_status: '已支付', client_user_id: 'cu-001', customer_name: '顾客A',
  inventory_composition_snapshot: null,
  ...extra,
})

describe('#341 record-only：联动关闭时提货仍冻结出库金额', () => {
  beforeEach(() => {
    pg.query.mockReset()
    pg.query.mockResolvedValue([])
    pg.transaction.mockReset()
  })

  test('单件：88.50 × 2 → pickup_records 写入 88.50 / 177.00，不生成 GCK', async () => {
    const client = recordOnlyClient([locked('item-001')])
    pg.transaction.mockImplementation(async (cb) => cb(client))
    const ctx = createManagerCtx({ saleItemId: 'item-001', pickupQuantity: 2 })

    await orderRoutes.createPickup(ctx)

    expect(ctx.result.inventoryMode).toBe('record-only')
    const sqls = client.query.mock.calls.map(([sql]) => sql)
    expect(sqls.some((sql) => /inventory_docs|inventory_doc_items|inventory_stock_lots|inventory_cutover_states/.test(sql))).toBe(false)
    const insert = client.query.mock.calls.find(([sql]) => /INSERT INTO pickup_records/.test(sql))
    expect(insert[1].slice(-2)).toEqual(['88.50', '177.00'])
  })

  test('合并：两条 quantity=1 来源各冻结 19.99，不生成 GCK', async () => {
    const group = { sale_item_group_id: 'G-1', quantity: 1, sale_amount: 19.99, unit_real_price: 19.99, received: 19.99, paid_quantity: 1 }
    const client = recordOnlyClient([locked('g-1', group), locked('g-2', group)])
    pg.transaction.mockImplementation(async (cb) => cb(client))
    const ctx = createManagerCtx({ saleItemId: 'g-1', saleItemIds: ['g-2', 'g-1'], pickupQuantity: 2 })

    await orderRoutes.createPickup(ctx)

    expect(ctx.result).toMatchObject({ pickedUp: 2, inventoryMode: 'record-only' })
    expect(client.query.mock.calls.some(([sql]) => /inventory_doc/.test(sql))).toBe(false)
    const inserts = client.query.mock.calls.filter(([sql]) => /INSERT INTO pickup_records/.test(sql))
    expect(inserts.map(([, params]) => [params[0], ...params.slice(-2)])).toEqual([
      ['g-1', '19.99', '19.99'],
      ['g-2', '19.99', '19.99'],
    ])
  })
})
