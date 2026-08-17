/**
 * paid_sessions 公式单测 — ticket 2026-05-19-cuddly-pancake
 *
 * 行级公式：paid_sessions = floor(min(1, (item.received - item_refund_share) / item.sale_amount) × session_count)
 *   item_refund_share = order.refunded × item.sale_amount / order.total
 *
 * 守护语义：
 *   - item.received 已含 '储值卡抵扣'
 *   - 储值卡全额支付订单 (item.received = item.sale_amount) → paid_sessions = session_count
 *   - 部分支付 → paid_sessions = floor(item.received/item.sale_amount × session_count)
 *   - sale_amount = 0（免单/寄存行）→ paid_sessions = session_count
 *   - session_count = NULL（非次数卡）→ paid_sessions = NULL
 *   - refund 下分后单调下降
 */
import { describe, it, expect } from 'vitest'
import {
  computePaidSessionsForItem,
  CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL,
  recalcPaidSessionsForOrder,
} from '@/lib/paid-sessions'

describe('转换单转入 received 重算', () => {
  it('以旧卡价值 + 净到账为目标，并按转入行金额分摊至分', () => {
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toContain("conversion_order.sale_order_type = '转换单'")
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toContain('conversion_order.converted_value + conversion_order.net_received')
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toContain('LEAST(conversion_order.in_total,')
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toMatch(/WHEN rn = item_count\s+THEN target_received -/)
  })
})

describe('computePaidSessionsForItem 行级', () => {
  it('储值卡全额抵扣订单：item.received 含抵扣 = item.sale_amount → paid_sessions = session_count', () => {
    // admin confirmOfflinePayment 修复后：储值卡 10 元全付行 received=10, sale_amount=10
    const v = computePaidSessionsForItem({
      itemReceived: 10,
      itemSaleAmount: 10,
      itemSessionCount: 10,
      orderTotal: 10,
      orderRefunded: 0,
    })
    expect(v).toBe(10)
  })

  it('线下现金 + 储值卡混合全付：item.received 累计 = item.sale_amount → paid_sessions = session_count', () => {
    // 行 received=100, sale_amount=100
    const v = computePaidSessionsForItem({
      itemReceived: 100,
      itemSaleAmount: 100,
      itemSessionCount: 10,
      orderTotal: 100,
      orderRefunded: 0,
    })
    expect(v).toBe(10)
  })

  it('部分支付：item.received = 50% sale_amount → paid_sessions = floor(50% × session_count)', () => {
    const v = computePaidSessionsForItem({
      itemReceived: 50,
      itemSaleAmount: 100,
      itemSessionCount: 10,
      orderTotal: 100,
      orderRefunded: 0,
    })
    expect(v).toBe(5)
  })

  it('部分支付带 floor：item.received 33% × session_count=10 → 3', () => {
    const v = computePaidSessionsForItem({
      itemReceived: 33,
      itemSaleAmount: 100,
      itemSessionCount: 10,
      orderTotal: 100,
      orderRefunded: 0,
    })
    expect(v).toBe(3)
  })

  it('免单行 sale_amount=0 → paid_sessions = session_count（兜底全付）', () => {
    const v = computePaidSessionsForItem({
      itemReceived: 0,
      itemSaleAmount: 0,
      itemSessionCount: 5,
      orderTotal: 0,
      orderRefunded: 0,
    })
    expect(v).toBe(5)
  })

  it('寄存行 sale_amount=0 → paid_sessions = session_count', () => {
    const v = computePaidSessionsForItem({
      itemReceived: 0,
      itemSaleAmount: '0',
      itemSessionCount: 8,
      orderTotal: '0',
      orderRefunded: 0,
    })
    expect(v).toBe(8)
  })

  it('整数精度（先乘后除）：received=3000、refunded=2600、total=3000、sa=3000、sc=15 → settled=400 → 400×15/3000=2（旧实现先除得 1.9999… 误舍成 1）', () => {
    // 退款单 #18 实测形态：15 次卡退 13 次（净 ¥400=2 次），不得误算成 1 触发 PAID_SESSIONS_UNDERFLOW
    const v = computePaidSessionsForItem({
      itemReceived: 3000,
      itemSaleAmount: 3000,
      itemSessionCount: 15,
      orderTotal: 3000,
      orderRefunded: 2600,
    })
    expect(v).toBe(2)
  })

  it('退款单调下降（单行订单）：received=100、refunded=30、total=100 → item_refund_share=30 → settled=70 → paid_sessions=7', () => {
    const v = computePaidSessionsForItem({
      itemReceived: 100,
      itemSaleAmount: 100,
      itemSessionCount: 10,
      orderTotal: 100,
      orderRefunded: 30,
    })
    expect(v).toBe(7)
  })

  it('退款全额：received=100、refunded=100 → settled=0 → paid_sessions=0', () => {
    const v = computePaidSessionsForItem({
      itemReceived: 100,
      itemSaleAmount: 100,
      itemSessionCount: 10,
      orderTotal: 100,
      orderRefunded: 100,
    })
    expect(v).toBe(0)
  })

  it('refunded 大于 received（不该发生但兜底）→ paid_sessions=0', () => {
    const v = computePaidSessionsForItem({
      itemReceived: 50,
      itemSaleAmount: 100,
      itemSessionCount: 10,
      orderTotal: 100,
      orderRefunded: 80,
    })
    expect(v).toBe(0)
  })

  it('非次数卡 session_count = null → paid_sessions = null', () => {
    const v = computePaidSessionsForItem({
      itemReceived: 100,
      itemSaleAmount: 100,
      itemSessionCount: null,
      orderTotal: 100,
      orderRefunded: 0,
    })
    expect(v).toBeNull()
  })

  it('字符串入参（drizzle numeric 返回 string）：received="200.00", sale_amount="100.00" → 上限封顶 session_count', () => {
    const v = computePaidSessionsForItem({
      itemReceived: '200.00',
      itemSaleAmount: '100.00',
      itemSessionCount: 10,
      orderTotal: '100.00',
      orderRefunded: '0.00',
    })
    expect(v).toBe(10)
  })

  it('item_settled > sale_amount（过度回款，理论不该发生）→ paid_sessions 封顶 session_count', () => {
    const v = computePaidSessionsForItem({
      itemReceived: 150,
      itemSaleAmount: 100,
      itemSessionCount: 10,
      orderTotal: 100,
      orderRefunded: 0,
    })
    expect(v).toBe(10)
  })

  it('多行订单退款按 sale_amount 下分（行1：sale_amount=100, 行2: sale_amount=200, 退款=60）', () => {
    // 行 1：refund_share = 60×100/300 = 20，settled=80，80%×10=8
    expect(
      computePaidSessionsForItem({
        itemReceived: 100,
        itemSaleAmount: 100,
        itemSessionCount: 10,
        orderTotal: 300,
        orderRefunded: 60,
      }),
    ).toBe(8)
    // 行 2：refund_share = 60×200/300 = 40，settled=160，80%×20=16
    expect(
      computePaidSessionsForItem({
        itemReceived: 200,
        itemSaleAmount: 200,
        itemSessionCount: 20,
        orderTotal: 300,
        orderRefunded: 60,
      }),
    ).toBe(16)
  })
})

function drizzleSqlText(query: unknown): string {
  return (query as { toQuery: (config: unknown) => { sql: string } }).toQuery({
    casing: { getColumnCasing: () => '' },
    escapeName: (name: string) => name,
    escapeParam: (index: number) => `$${index + 1}`,
    escapeString: (value: string) => value,
  }).sql
}

function makeRecalcFixture(receiptPositiveTotal: number) {
  const executed: string[] = []
  const signedReceipts = [100, -40]
  const state = { received: 100, paidSessions: 10 }
  const tx = {
    execute: async (query: unknown) => {
      const text = drizzleSqlText(query)
      executed.push(text)
      if (text.includes('AS receipt_positive_total')) {
        return [{ receipt_positive_total: String(receiptPositiveTotal), order_received: '100' }]
      }
      if (text.includes('FROM sale_payment_item_receipts spir')) {
        state.received = signedReceipts.reduce((total, amount) => total + amount, 0)
      }
      if (text.includes('WITH tg AS')) {
        state.received = 100
      }
      if (text.includes('WITH refund_items AS')) {
        state.received = Math.max(0, state.received - 40)
      }
      if (text.includes('paid_sessions = CASE')) {
        state.paidSessions = computePaidSessionsForItem({
          itemReceived: state.received,
          itemSaleAmount: 100,
          itemSessionCount: 10,
          orderTotal: 100,
          orderRefunded: 0,
        })!
      }
      return []
    },
  }
  return { tx, executed, state }
}

describe('退款 receipt 覆盖分流', () => {
  it('+100/-40：正向 receipt 覆盖毛实收时走 Branch A，行净额和已付次数均为 60%', async () => {
    const fixture = makeRecalcFixture(100)

    await recalcPaidSessionsForOrder(fixture.tx as never, 'order-refund-receipt')

    const coverageSql = fixture.executed.find((text) => text.includes('AS receipt_positive_total'))
    expect(coverageSql).toContain("sop.change_type IN ('首次支付','回款','储值卡抵扣')")
    expect(coverageSql).not.toContain("'退款'")
    expect(fixture.executed.some((text) => text.includes('FROM sale_payment_item_receipts spir'))).toBe(true)
    expect(fixture.executed.some((text) => text.includes('WITH tg AS'))).toBe(false)
    expect(fixture.state).toEqual({ received: 60, paidSessions: 6 })
  })

  it('正向 receipt 不完整时走 Branch B，并在重算前扣减 note.items[].refundAmount', async () => {
    const fixture = makeRecalcFixture(0)

    await recalcPaidSessionsForOrder(fixture.tx as never, 'order-refund-fallback')

    const allocationIndex = fixture.executed.findIndex((text) => text.includes('WITH tg AS'))
    const deductIndex = fixture.executed.findIndex((text) => text.includes('WITH refund_items AS'))
    const conversionIndex = fixture.executed.findIndex((text) => text.includes('WITH conversion_order AS'))
    const channelSql = fixture.executed.find((text) => text.includes('AS cumulative_received'))
    const recalcIndex = fixture.executed.findIndex((text) => text.includes('paid_sessions = CASE'))
    expect(allocationIndex).toBeGreaterThan(-1)
    expect(deductIndex).toBeGreaterThan(allocationIndex)
    expect(conversionIndex).toBeGreaterThan(deductIndex)
    expect(recalcIndex).toBeGreaterThan(conversionIndex)
    expect(channelSql).toContain('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')
    expect(channelSql).toContain('ROUND(prepaid_total * cumulative_received / received_total, 2)')
    expect(channelSql).not.toContain('item_count')
    expect(fixture.state).toEqual({ received: 60, paidSessions: 6 })
  })
})
