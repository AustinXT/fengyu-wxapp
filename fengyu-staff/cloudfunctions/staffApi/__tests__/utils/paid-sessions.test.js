/**
 * paid_sessions 计算函数单元测试（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 行级公式：paid_sessions = floor(min(1, (item.received - item_refund_share) / item.sale_amount) × session_count)
 *   item_refund_share = order.refunded × item.sale_amount / order.total
 *
 * 覆盖 computePaidSessionsForItem 全部边界：
 *   - 全付 / 部分付 / 零付 / 退款扣减 / 免单兜底 / 非次数卡 / 越界保护
 */

const {
  computePaidSessionsForItem,
  PAID_SESSIONS_RECALC_SQL,
  FULL_REFUND_ZERO_AMOUNT_PAID_SESSIONS_SQL,
} = require('../../utils/paid-sessions')

describe('computePaidSessionsForItem 公式边界（行级）', () => {
  test('全额支付：paid_sessions = session_count', () => {
    expect(computePaidSessionsForItem({
      itemReceived: 1000, itemSaleAmount: 1000, itemSessionCount: 10,
      orderTotal: 1000, orderRefunded: 0,
    })).toBe(10)
  })

  test('部分支付：floor(ratio × session_count)', () => {
    // 50% 已付 × 10 次 = 5 次
    expect(computePaidSessionsForItem({
      itemReceived: 500, itemSaleAmount: 1000, itemSessionCount: 10,
      orderTotal: 1000, orderRefunded: 0,
    })).toBe(5)
    // 30% 已付 × 10 次 = floor(3) = 3 次（D1=A floor，不四舍五入）
    expect(computePaidSessionsForItem({
      itemReceived: 300, itemSaleAmount: 1000, itemSessionCount: 10,
      orderTotal: 1000, orderRefunded: 0,
    })).toBe(3)
    // 35% × 10 = floor(3.5) = 3（D1=A floor，不向上取整）
    expect(computePaidSessionsForItem({
      itemReceived: 350, itemSaleAmount: 1000, itemSessionCount: 10,
      orderTotal: 1000, orderRefunded: 0,
    })).toBe(3)
    // 99% × 10 = floor(9.9) = 9（关键边界：99% 不算全付）
    expect(computePaidSessionsForItem({
      itemReceived: 990, itemSaleAmount: 1000, itemSessionCount: 10,
      orderTotal: 1000, orderRefunded: 0,
    })).toBe(9)
  })

  test('零付：paid_sessions = 0', () => {
    expect(computePaidSessionsForItem({
      itemReceived: 0, itemSaleAmount: 1000, itemSessionCount: 10,
      orderTotal: 1000, orderRefunded: 0,
    })).toBe(0)
  })

  test('整数精度（先乘后除）：received=3000 refunded=2600 total=3000 sa=3000 sc=15 → 400×15/3000=2（旧先除得 1.9999… 误舍成 1）', () => {
    // 退款单 #18 实测形态：15 次卡退 13 次（净 ¥400=2 次），不得误算成 1 触发 PAID_SESSIONS_UNDERFLOW
    expect(computePaidSessionsForItem({
      itemReceived: 3000, itemSaleAmount: 3000, itemSessionCount: 15,
      orderTotal: 3000, orderRefunded: 2600,
    })).toBe(2)
  })

  test('D3=A 退款扣减：order.refunded 按 sale_amount 比例下分到行 → paid_sessions 单调下降', () => {
    // 单行订单：行 sale_amount = order total，所以 refund 全分到这一行
    // received=1000, refunded=300 → item_settled = 1000 - 300×1000/1000 = 700 → 70% × 10 = 7
    expect(computePaidSessionsForItem({
      itemReceived: 1000, itemSaleAmount: 1000, itemSessionCount: 10,
      orderTotal: 1000, orderRefunded: 300,
    })).toBe(7)
    // 单行订单，退款超 received → settled = max(0, negative) = 0
    expect(computePaidSessionsForItem({
      itemReceived: 100, itemSaleAmount: 1000, itemSessionCount: 10,
      orderTotal: 1000, orderRefunded: 500,
    })).toBe(0)
  })

  test('行级 sale_amount=0 兜底（免单/寄存行）→ 全付', () => {
    expect(computePaidSessionsForItem({
      itemReceived: 0, itemSaleAmount: 0, itemSessionCount: 10,
      orderTotal: 0, orderRefunded: 0,
    })).toBe(10)
    // 即使 received 也为 0，sale_amount=0 也兜底全付
    expect(computePaidSessionsForItem({
      itemReceived: 0, itemSaleAmount: 0, itemSessionCount: 5,
      orderTotal: 100, orderRefunded: 0,
    })).toBe(5)
  })

  test('D5=A NULL session_count（非次数卡）→ paid_sessions = NULL', () => {
    expect(computePaidSessionsForItem({
      itemReceived: 1000, itemSaleAmount: 1000, itemSessionCount: null,
      orderTotal: 1000, orderRefunded: 0,
    })).toBeNull()
    expect(computePaidSessionsForItem({
      itemReceived: 500, itemSaleAmount: 1000, itemSessionCount: null,
      orderTotal: 1000, orderRefunded: 0,
    })).toBeNull()
  })

  test('D4=A 越界保护：item received > sale_amount 时不超 session_count', () => {
    // 受字符串入参影响，item_settled 大于 sale_amount 时仍 clamp 到 session_count
    expect(computePaidSessionsForItem({
      itemReceived: 2000, itemSaleAmount: 1000, itemSessionCount: 10,
      orderTotal: 1000, orderRefunded: 0,
    })).toBe(10)
  })

  test('字符串入参（pg numeric 返回 string）正常处理', () => {
    expect(computePaidSessionsForItem({
      itemReceived: '500.00', itemSaleAmount: '1000.00', itemSessionCount: 10,
      orderTotal: '1000.00', orderRefunded: '0.00',
    })).toBe(5)
    expect(computePaidSessionsForItem({
      itemReceived: '999.50', itemSaleAmount: '1000.00', itemSessionCount: 10,
      orderTotal: '1000.00', orderRefunded: '0.00',
    })).toBe(9)
  })

  test('D8=A 各行独立 floor：多行尾差不汇总', () => {
    // 同订单 total=300（两行 sale_amount=100/200），received 按行分摊（行级 33%/33%）
    // 第一行 received=33.33 → 33.33/100 = 33% × 10 = floor(3.33) = 3
    // 第二行 received=66.67 → 66.67/200 = 33% × 20 = floor(6.67) = 6
    expect(computePaidSessionsForItem({
      itemReceived: 33.33, itemSaleAmount: 100, itemSessionCount: 10,
      orderTotal: 300, orderRefunded: 0,
    })).toBe(3)
    expect(computePaidSessionsForItem({
      itemReceived: 66.67, itemSaleAmount: 200, itemSessionCount: 20,
      orderTotal: 300, orderRefunded: 0,
    })).toBe(6)
  })

  test('多行订单退款按 sale_amount 比例下分到行', () => {
    // 订单 total=300，两行 sale_amount=100/200，已全付（行 received=sale_amount），退款 60
    // 行1 refund_share = 60 × 100/300 = 20 → item_settled = 100 - 20 = 80 → 80% × 10 = 8
    // 行2 refund_share = 60 × 200/300 = 40 → item_settled = 200 - 40 = 160 → 80% × 20 = 16
    expect(computePaidSessionsForItem({
      itemReceived: 100, itemSaleAmount: 100, itemSessionCount: 10,
      orderTotal: 300, orderRefunded: 60,
    })).toBe(8)
    expect(computePaidSessionsForItem({
      itemReceived: 200, itemSaleAmount: 200, itemSessionCount: 20,
      orderTotal: 300, orderRefunded: 60,
    })).toBe(16)
  })
})

describe('PAID_SESSIONS_RECALC_SQL 模板字面量守护', () => {
  test('行级公式必须为 received × session_count / sale_amount（session_count 参与，先乘后除保整数精度）', () => {
    // 2026-06-28 重构：received 已由 STEP1（spai/瀑布）+ STEP1.5（逐项退款净额）前置算好，
    // 本 SQL 不再下分订单级 refund，直接用净 received × session_count / sale_amount。
    expect(PAID_SESSIONS_RECALC_SQL).toMatch(/LEAST\(sale_items\.session_count,\s*FLOOR\(sale_items\.received::numeric\s*\*\s*sale_items\.session_count\s*\/\s*sale_items\.sale_amount::numeric\)/)
  })

  test('必须用 FLOOR 取整（D1=A）', () => {
    expect(PAID_SESSIONS_RECALC_SQL).toContain('FLOOR(')
    expect(PAID_SESSIONS_RECALC_SQL).not.toMatch(/\bROUND\(/i)
    expect(PAID_SESSIONS_RECALC_SQL).not.toMatch(/\bCEIL\(/i)
  })

  test('必须用 LEAST(session_count, ...) 防越界（D4=A）', () => {
    expect(PAID_SESSIONS_RECALC_SQL).toMatch(/LEAST\(sale_items\.session_count,/i)
  })

  test('必须有 sale_items.sale_amount <= 0 → session_count 兜底（免单/寄存行）', () => {
    expect(PAID_SESSIONS_RECALC_SQL).toMatch(/sale_items\.sale_amount\s*<=\s*0\s+THEN\s+sale_items\.session_count/i)
  })

  test('session_count IS NULL 时 → NULL（D5=A 非次数卡）', () => {
    expect(PAID_SESSIONS_RECALC_SQL).toMatch(/sale_items\.session_count\s+IS\s+NULL\s+THEN\s+NULL/i)
  })

  test('必须用 op.total_amount <= 0 分支防 total=0 时除零（分支式守护，替代旧 NULLIF）', () => {
    // 2026-06-28 重构：除零保护从 NULLIF(op.total_amount, 0) 改为 CASE 分支
    // WHEN op.total_amount <= 0 THEN sale_items.session_count（全付兜底）
    expect(PAID_SESSIONS_RECALC_SQL).toMatch(/op\.total_amount\s*<=\s*0\s+THEN\s+sale_items\.session_count/i)
    // 旧 NULLIF 形态不应残留
    expect(PAID_SESSIONS_RECALC_SQL).not.toMatch(/NULLIF\(op\.total_amount::numeric,\s*0\)/i)
  })

  test('0 元 item 若退款明细标记全退，必须后置覆盖 paid_sessions=0', () => {
    expect(FULL_REFUND_ZERO_AMOUNT_PAID_SESSIONS_SQL).toMatch(/sale_amount\s*<=\s*0/i)
    expect(FULL_REFUND_ZERO_AMOUNT_PAID_SESSIONS_SQL).toMatch(/LOWER\(COALESCE\(elem ->> 'isFullItemRefund', 'false'\)\) = 'true'/)
    expect(FULL_REFUND_ZERO_AMOUNT_PAID_SESSIONS_SQL).toMatch(/SET paid_sessions = 0/i)
  })
})
