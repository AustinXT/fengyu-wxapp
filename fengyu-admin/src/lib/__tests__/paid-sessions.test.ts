/**
 * paid_sessions 公式单测 — ticket 2026-05-19-cuddly-pancake
 *
 * 守护语义：
 *   - settled = max(0, received - refunded)；received 已含 '储值卡抵扣'
 *   - 储值卡全额支付订单 (received = total, prepaid_card_amount = total) → paid_sessions = session_count
 *   - 部分支付 → paid_sessions = floor(received/total × session_count)
 *   - total = 0（免单/寄存）→ paid_sessions = session_count
 *   - session_count = NULL（非次数卡）→ paid_sessions = NULL
 *   - refund 单调下降
 */
import { describe, it, expect } from 'vitest'
import { computePaidSessionsForItem } from '@/lib/paid-sessions'

describe('computePaidSessionsForItem', () => {
  it('储值卡全额抵扣订单：received 含抵扣 = total → paid_sessions = session_count', () => {
    // admin confirmOfflinePayment 修复后：储值卡 10 元全付订单 received=10, total=10
    const v = computePaidSessionsForItem({
      saleOrderReceived: 10,
      saleOrderTotal: 10,
      itemSessionCount: 10,
    })
    expect(v).toBe(10)
  })

  it('线下现金 + 储值卡混合全付：received 累计 = total → paid_sessions = session_count', () => {
    // 现金 60 + 储值卡 40 = 100, total = 100
    const v = computePaidSessionsForItem({
      saleOrderReceived: 100,
      saleOrderTotal: 100,
      itemSessionCount: 10,
    })
    expect(v).toBe(10)
  })

  it('部分支付：received = 50% total → paid_sessions = floor(50% × session_count)', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: 50,
      saleOrderTotal: 100,
      itemSessionCount: 10,
    })
    expect(v).toBe(5)
  })

  it('部分支付带 floor：received 33% × session_count=10 → 3', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: 33,
      saleOrderTotal: 100,
      itemSessionCount: 10,
    })
    expect(v).toBe(3)
  })

  it('免单订单 total=0 → paid_sessions = session_count（兜底全付）', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: 0,
      saleOrderTotal: 0,
      itemSessionCount: 5,
    })
    expect(v).toBe(5)
  })

  it('寄存单 total=0 → paid_sessions = session_count', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: 0,
      saleOrderTotal: '0',
      itemSessionCount: 8,
    })
    expect(v).toBe(8)
  })

  it('退款单调下降：received=100、refunded=30、total=100 → settled=70 → paid_sessions=7', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: 100,
      saleOrderRefunded: 30,
      saleOrderTotal: 100,
      itemSessionCount: 10,
    })
    expect(v).toBe(7)
  })

  it('退款全额：received=100、refunded=100 → settled=0 → paid_sessions=0', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: 100,
      saleOrderRefunded: 100,
      saleOrderTotal: 100,
      itemSessionCount: 10,
    })
    expect(v).toBe(0)
  })

  it('refunded 大于 received（不该发生但兜底）→ paid_sessions=0', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: 50,
      saleOrderRefunded: 80,
      saleOrderTotal: 100,
      itemSessionCount: 10,
    })
    expect(v).toBe(0)
  })

  it('非次数卡 session_count = null → paid_sessions = null', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: 100,
      saleOrderTotal: 100,
      itemSessionCount: null,
    })
    expect(v).toBeNull()
  })

  it('字符串入参（drizzle numeric 返回 string）：received="200.00", total="100.00" → 上限封顶 session_count', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: '200.00',
      saleOrderTotal: '100.00',
      itemSessionCount: 10,
    })
    expect(v).toBe(10)
  })

  it('settled > total（过度回款，理论不该发生）→ paid_sessions 封顶 session_count', () => {
    const v = computePaidSessionsForItem({
      saleOrderReceived: 150,
      saleOrderTotal: 100,
      itemSessionCount: 10,
    })
    expect(v).toBe(10)
  })
})
