/**
 * paid_sessions 计算函数单元测试（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 覆盖 computePaidSessionsForItem 全部边界：
 *   - 全付 / 部分付 / 零付 / 退款扣减 / 免单兜底 / 非次数卡 / 越界保护
 */

const { computePaidSessionsForItem, PAID_SESSIONS_RECALC_SQL } = require('../../utils/paid-sessions')

describe('computePaidSessionsForItem 公式边界', () => {
  test('全额支付：paid_sessions = session_count', () => {
    expect(computePaidSessionsForItem({
      saleOrderReceived: 1000, saleOrderTotal: 1000, itemSessionCount: 10,
    })).toBe(10)
  })

  test('部分支付：floor(ratio × session_count)', () => {
    // 50% 已付 × 10 次 = 5 次
    expect(computePaidSessionsForItem({
      saleOrderReceived: 500, saleOrderTotal: 1000, itemSessionCount: 10,
    })).toBe(5)
    // 30% 已付 × 10 次 = floor(3) = 3 次（D1=A floor，不四舍五入）
    expect(computePaidSessionsForItem({
      saleOrderReceived: 300, saleOrderTotal: 1000, itemSessionCount: 10,
    })).toBe(3)
    // 35% × 10 = floor(3.5) = 3（D1=A floor，不向上取整）
    expect(computePaidSessionsForItem({
      saleOrderReceived: 350, saleOrderTotal: 1000, itemSessionCount: 10,
    })).toBe(3)
    // 99% × 10 = floor(9.9) = 9（关键边界：99% 不算全付）
    expect(computePaidSessionsForItem({
      saleOrderReceived: 990, saleOrderTotal: 1000, itemSessionCount: 10,
    })).toBe(9)
  })

  test('零付：paid_sessions = 0', () => {
    expect(computePaidSessionsForItem({
      saleOrderReceived: 0, saleOrderTotal: 1000, itemSessionCount: 10,
    })).toBe(0)
  })

  test('D3=A 退款扣减：refunded_amount 增加 → paid_sessions 单调下降', () => {
    // 全付后退款 30% → 70% 剩余 × 10 = 7
    expect(computePaidSessionsForItem({
      saleOrderReceived: 1000, saleOrderRefunded: 300, saleOrderTotal: 1000, itemSessionCount: 10,
    })).toBe(7)
    // 退款超过 received → settled = max(0, negative) = 0
    expect(computePaidSessionsForItem({
      saleOrderReceived: 100, saleOrderRefunded: 500, saleOrderTotal: 1000, itemSessionCount: 10,
    })).toBe(0)
  })

  test('total_amount=0 兜底（免单/寄存单）→ 全付', () => {
    expect(computePaidSessionsForItem({
      saleOrderReceived: 0, saleOrderTotal: 0, itemSessionCount: 10,
    })).toBe(10)
    // 即使 received 也为 0，total=0 也兜底全付
    expect(computePaidSessionsForItem({
      saleOrderReceived: 0, saleOrderTotal: 0, itemSessionCount: 5,
    })).toBe(5)
  })

  test('D5=A NULL session_count（非次数卡）→ paid_sessions = NULL', () => {
    expect(computePaidSessionsForItem({
      saleOrderReceived: 1000, saleOrderTotal: 1000, itemSessionCount: null,
    })).toBeNull()
    expect(computePaidSessionsForItem({
      saleOrderReceived: 500, saleOrderTotal: 1000, itemSessionCount: null,
    })).toBeNull()
  })

  test('D4=A 越界保护：ratio > 1 时不超 session_count', () => {
    // 受字符串入参影响，settled 大于 total 时仍 clamp 到 session_count
    expect(computePaidSessionsForItem({
      saleOrderReceived: 2000, saleOrderTotal: 1000, itemSessionCount: 10,
    })).toBe(10)
  })

  test('字符串入参（pg numeric 返回 string）正常处理', () => {
    expect(computePaidSessionsForItem({
      saleOrderReceived: '500.00', saleOrderTotal: '1000.00', itemSessionCount: 10,
    })).toBe(5)
    expect(computePaidSessionsForItem({
      saleOrderReceived: '999.50', saleOrderRefunded: '0.00', saleOrderTotal: '1000.00', itemSessionCount: 10,
    })).toBe(9)
  })

  test('D8=A 各行独立 floor：多行尾差不汇总', () => {
    // 同订单 total=300，received=100，session_count=[10, 20]
    // 比例 1/3，两行分别 floor(10/3)=3, floor(20/3)=6，总和 9 < 10/3 × 30 = 10
    // 各行独立 floor 后总和可能 < 整数比例乘积，符合 D8=A 语义
    const ratio = 100 / 300
    expect(computePaidSessionsForItem({
      saleOrderReceived: 100, saleOrderTotal: 300, itemSessionCount: 10,
    })).toBe(Math.floor(ratio * 10))  // 3
    expect(computePaidSessionsForItem({
      saleOrderReceived: 100, saleOrderTotal: 300, itemSessionCount: 20,
    })).toBe(Math.floor(ratio * 20))  // 6
  })
})

describe('PAID_SESSIONS_RECALC_SQL 模板字面量守护', () => {
  test('必须包含 GREATEST(0, received - COALESCE(refunded_amount, 0)) 公式', () => {
    expect(PAID_SESSIONS_RECALC_SQL).toMatch(/GREATEST\(0,\s*received\s*-\s*COALESCE\(refunded_amount,\s*0\)\)/)
  })

  test('必须用 FLOOR 取整（D1=A）', () => {
    expect(PAID_SESSIONS_RECALC_SQL).toContain('FLOOR(')
    expect(PAID_SESSIONS_RECALC_SQL).not.toMatch(/\bROUND\(/i)
    expect(PAID_SESSIONS_RECALC_SQL).not.toMatch(/\bCEIL\(/i)
  })

  test('必须用 LEAST(session_count, ...) 防越界（D4=A）', () => {
    expect(PAID_SESSIONS_RECALC_SQL).toMatch(/LEAST\(sale_items\.session_count,/i)
  })

  test('必须有 total_amount <= 0 → session_count 兜底（免单/寄存）', () => {
    expect(PAID_SESSIONS_RECALC_SQL).toMatch(/op\.total_amount\s*<=\s*0\s+THEN\s+sale_items\.session_count/i)
  })

  test('session_count IS NULL 时 → NULL（D5=A 非次数卡）', () => {
    expect(PAID_SESSIONS_RECALC_SQL).toMatch(/sale_items\.session_count\s+IS\s+NULL\s+THEN\s+NULL/i)
  })
})
