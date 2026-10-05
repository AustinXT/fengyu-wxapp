const path = require('node:path')
const root = path.resolve(__dirname, '../../../../..')
const clientAlloc = require('../../utils/payment-allocatable')
const siblingAlloc = [
  require(path.join(root, 'fengyu-staff/cloudfunctions/staffApi/utils/payment-allocatable')),
  require(path.join(root, 'fengyu-client/cloudfunctions/payNotify/payment-allocatable')),
]
function transaction(items, prior = []) {
  return { query: vi.fn(async (sql) => {
    if (/SELECT sale_order_type, legacy_source/.test(sql)) return { rows: [{ sale_order_type: '销售单' }] }
    if (/FROM sale_items si/.test(sql)) return { rows: items }
    if (/AS allocated/.test(sql)) return { rows: prior }
    if (/UPDATE sale_order_payments/.test(sql)) return { rows: [], rowCount: 1 }
    if (/INSERT INTO sale_payment_item_receipts/.test(sql)) return { rows: [{ id: 'receipt' }], rowCount: 1 }
    throw new Error(`unexpected SQL ${sql}`)
  }) }
}
const row = (id, sale, pending, converted = false) => ({ sale_item_id: id, sale_amount: sale, pending_received: pending, converted_out: converted, sales_category: '自销自耗' })
test.each([
  { items: [row('a', 100, 50), row('b', 200, 100)], eventAmount: 150 },
  { items: [row('a', 100, 50), row('b', 200, 100)], eventAmount: 200, prior: [{ sale_item_id: 'a', allocated: 50 }] },
  { items: [row('a', 100, 100, true), row('b', 100, 50)], eventAmount: 50 },
  { items: [row('a', 100, 100), row('b', 100, 100)], eventAmount: 10, prior: [{ sale_item_id: 'a', allocated: 100 }, { sale_item_id: 'b', allocated: 100 }] },
  { items: [row('a', 100, 50), row('b', 200, 100)], eventAmount: 75, directedItems: [{ saleItemId: 'b', amount: 75 }] },
])('预演不写事实，分摊与三端实际capture相同 %#', async ({ items, eventAmount, prior = [], directedItems }) => {
  const db = transaction(items, prior)
  const args = { saleOrderId: 'order', eventAmount, directedItems }
  const planned = await clientAlloc.previewPaymentAllocatables(db, args)
  expect(db.query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true)
  for (const sibling of [clientAlloc, ...siblingAlloc]) {
    const actual = await sibling.capturePaymentAllocatables(transaction(items, prior), { ...args, salePaymentId: 'payment' })
    expect(actual.map(({ saleItemId, amount, salesCategory }) => ({ saleItemId, amount, salesCategory }))).toEqual(planned)
  }
})
