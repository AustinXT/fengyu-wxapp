const pg = globalThis.__mocks__.pg
const { createManagerCtx } = require('../helpers')

// Only peripheral mutation/reconciliation is stubbed; the real approval handler and
// calculateUnusedQuantity gate run with the transaction's locked item snapshot.
const cascadeRefund = vi.fn(async () => ({}))
const recalcPaidSessionsForOrder = vi.fn(async () => {})
const swaps = [
  ['../../helpers/refund-cascade', { cascadeRefund }],
  ['../../utils/paid-sessions', { recalcPaidSessionsForOrder }],
  ['../../utils/payment-allocatable', {
    reconcileAllocationStatusAfterRefund: async () => {},
    reconcileOrderStatusAfterRefund: async () => {},
  }],
]
const saved = swaps.map(([name, overrides]) => {
  const id = require.resolve(name), actual = require(name), previous = require.cache[id]
  require.cache[id] = { ...previous, exports: { ...actual, ...overrides } }
  return [id, previous]
})
const routeId = require.resolve('../../routes/order'), previousRoute = require.cache[routeId]
delete require.cache[routeId]
const approvalRoutes = require('../../routes/order')
for (const [id, previous] of saved) require.cache[id] = previous
if (previousRoute) require.cache[routeId] = previousRoute
else delete require.cache[routeId]

describe('寄存疗程卡退款审批：锁内可退次数复核', () => {
  beforeEach(() => { cascadeRefund.mockClear(); recalcPaidSessionsForOrder.mockClear() })
  test.each([
    { label: '部分退款后转换耗尽', rem: 2, paid: 4, requested: 1, allowed: false },
    { label: '已退光的行', rem: 2, paid: 4, requested: 2, allowed: false },
    { label: '部分退款后仍有三次', rem: 5, paid: 4, requested: 3, allowed: true },
    { label: '历史NULL', rem: 3, paid: null, requested: 3, allowed: true },
    { label: '未变化的完整卡', rem: 6, paid: 6, requested: 6, allowed: true },
  ])('$label：审批 allowed=$allowed', async ({ rem, paid, requested, allowed }) => {
    pg.query.mockResolvedValueOnce([{
      id: 1001, sale_order_id: 'deposit', store_id: 'store-001', sale_order_type: '寄存单',
      status: '待审批', amount: '-80', payment_method: '线下', received: 960, refunded_amount: 0,
      note: JSON.stringify({ items: [{ refSaleItemId: 'A', quantity: requested, refundAmount: 80 }] }),
    }])
    const statements = []
    let committed = false, rolledBack = false
    pg.transaction.mockImplementationOnce(async (cb) => {
      try {
        const result = await cb({ query: async (sql) => {
          statements.push(sql)
          if (sql.includes('AS net')) return { rows: [{ net: 960 }], rowCount: 1 }
          if (sql.includes('FROM sale_items') && sql.includes('ORDER BY sale_item_id') && sql.includes('FOR UPDATE')) return { rows: [{
            sale_item_id: 'A', product_type: '疗程卡', quantity: 1,
            session_count: 6, remaining_sessions: rem, paid_sessions: paid,
            unit_real_price: '80', received: '480', picked_up_quantity: 0, refunded_quantity: 0,
          }], rowCount: 1 }
          if (sql.includes('retained_refund_amount')) return { rows: [{ sale_item_id: 'A', retained_refund_amount: 0, converted_amount: 0, converted_quantity: 0 }], rowCount: 1 }
          return { rows: [], rowCount: 1 }
        } })
        committed = true
        return result
      } catch (error) { rolledBack = true; throw error }
    })
    const ctx = createManagerCtx({ paymentId: 1001 })
    if (allowed) {
      await approvalRoutes.approveRefund(ctx)
      expect(committed).toBe(true)
      expect(statements[0]).toContain('FROM sale_orders')
      expect(statements[0]).toContain('FOR UPDATE')
      expect(cascadeRefund).toHaveBeenCalledOnce()
      expect(recalcPaidSessionsForOrder).toHaveBeenCalledOnce()
    } else {
      await expect(approvalRoutes.approveRefund(ctx)).rejects.toThrow('CARD_REFUNDABLE_CHANGED')
      expect(rolledBack).toBe(true)
      expect(committed).toBe(false)
      expect(cascadeRefund).not.toHaveBeenCalled()
      expect(recalcPaidSessionsForOrder).not.toHaveBeenCalled()
    }
  })
})
