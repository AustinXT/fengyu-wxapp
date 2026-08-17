/**
 * paid_sessions 计算函数单元测试（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 行级公式：paid_sessions = floor(min(1, (item.received - item_refund_share) / item.sale_amount) × session_count)
 *   item_refund_share = order.refunded × item.sale_amount / order.total
 *
 * 覆盖 computePaidSessionsForItem 全部边界：
 *   - 全付 / 部分付 / 零付 / 退款扣减 / 免单兜底 / 非次数卡 / 越界保护
 */

const staffPaidSessions = require('../../utils/paid-sessions')
const clientPaidSessions = require('../../../../../fengyu-client/cloudfunctions/clientApi/utils/paid-sessions')
const payNotifyPaidSessions = require('../../../../../fengyu-client/cloudfunctions/payNotify/paid-sessions')

const {
  computePaidSessionsForItem,
  ORDER_PREPAID_CARD_RECALC_SQL,
  CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL,
  SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL,
  PAID_SESSIONS_RECALC_SQL,
  FULL_REFUND_ZERO_AMOUNT_PAID_SESSIONS_SQL,
} = staffPaidSessions

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
  test('储值卡实付必须来自已支付抵扣与储值卡退款净额，现金退款不回冲', () => {
    expect(ORDER_PREPAID_CARD_RECALC_SQL).toContain("change_type = '储值卡抵扣'")
    expect(ORDER_PREPAID_CARD_RECALC_SQL).toContain("change_type = '退款' AND payment_method = '储值卡'")
    expect(ORDER_PREPAID_CARD_RECALC_SQL).toContain("status = '已支付'")
  })

  test('行级储值卡分摊必须用有符号 received 的累计边界差', () => {
    expect(SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL).toContain('SUM(si.received::numeric) OVER () AS received_total')
    expect(SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL).toMatch(
      /SUM\(si\.received::numeric\) OVER \(\s*ORDER BY si\.sale_item_id\s+ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\s*\) AS cumulative_received/,
    )
    expect(SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL).toContain('ROUND(prepaid_total * cumulative_received / received_total, 2)')
    expect(SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL).toContain(
      'ROUND(prepaid_total * (cumulative_received - item_received) / received_total, 2)',
    )
    expect(SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL).toContain('WHERE received_total <> 0 AND prepaid_total <> 0')
    expect(SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL).not.toContain('GREATEST(0, si.received')
    expect(SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL).not.toContain('item_count')
  })

  test('转换单转入行按旧卡价值 + 本单净到账分摊，且封顶转入总价', () => {
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toContain("conversion_order.sale_order_type = '转换单'")
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toContain("out_item.item_direction = '转出'")
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toContain("in_item.item_direction = '转入'")
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toContain('conversion_order.converted_value + conversion_order.net_received')
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toContain('LEAST(conversion_order.in_total,')
    expect(CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL).toMatch(/WHEN rn = item_count\s+THEN target_received -/)
  })

  test('行级公式必须为 received × session_count / sale_amount（session_count 参与，先乘后除保整数精度）', () => {
    // received 已由 STEP1（receipt/瀑布）+ STEP1.5（逐项退款净额）前置算好，
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

function allocateCentsByCumulativeBoundary(totalCents, signedWeights) {
  const totalWeight = signedWeights.reduce((sum, weight) => sum + weight, 0)
  if (totalCents === 0 || totalWeight === 0) return signedWeights.map(() => 0)
  let cumulativeWeight = 0
  return signedWeights.map((weight) => {
    const previousBoundary = Math.round(totalCents * cumulativeWeight / totalWeight)
    cumulativeWeight += weight
    const currentBoundary = Math.round(totalCents * cumulativeWeight / totalWeight)
    return currentBoundary - previousBoundary
  })
}

describe('储值卡累计边界分币', () => {
  test('2 分按四个等权正向品项分摊时非负且守恒', () => {
    const shares = allocateCentsByCumulativeBoundary(2, [1, 1, 1, 1])
    expect(shares).toEqual([1, 0, 1, 0])
    expect(shares.every((share) => share >= 0)).toBe(true)
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(2)
  })

  test('1 分按三个等权正向品项分摊时非负且守恒', () => {
    const shares = allocateCentsByCumulativeBoundary(1, [1, 1, 1])
    expect(shares.every((share) => share >= 0)).toBe(true)
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(1)
  })

  test('转换事件保留转出负号并让有符号卡款闭合', () => {
    expect(allocateCentsByCumulativeBoundary(5, [-80, 100])).toEqual([-20, 25])
  })
})

const PAID_SESSION_COPIES = [
  ['staffApi', staffPaidSessions],
  ['clientApi', clientPaidSessions],
  ['payNotify', payNotifyPaidSessions],
]

function makeRecalcFixture(copy, receiptPositiveTotal) {
  const calls = []
  const signedReceipts = [100, -40]
  const state = { received: 100, paidSessions: 10 }
  const client = {
    query: async (query) => {
      calls.push(query)
      if (typeof query === 'string' && query.includes('AS receipt_positive_total')) {
        return { rows: [{ receipt_positive_total: String(receiptPositiveTotal), order_received: '100' }] }
      }
      if (query === copy.SALE_ITEMS_RECEIVED_FROM_RECEIPTS_SQL) {
        state.received = signedReceipts.reduce((total, amount) => total + amount, 0)
      }
      if (query === copy.SALE_ITEMS_RECEIVED_ALLOC_SQL) {
        state.received = 100
      }
      if (query === copy.RECEIVED_REFUNDED_DEDUCT_SQL) {
        state.received = Math.max(0, state.received - 40)
      }
      if (query === copy.PAID_SESSIONS_RECALC_SQL) {
        state.paidSessions = copy.computePaidSessionsForItem({
          itemReceived: state.received,
          itemSaleAmount: 100,
          itemSessionCount: 10,
          orderTotal: 100,
          orderRefunded: 0,
        })
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return { client, calls, state }
}

describe('退款 receipt 覆盖分流', () => {
  test.each(PAID_SESSION_COPIES)('%s: +100/-40 应走 Branch A 并保留 60% 已付次数', async (_name, copy) => {
    const fixture = makeRecalcFixture(copy, 100)

    await copy.recalcPaidSessionsForOrder(fixture.client, 'order-refund-receipt')

    const coverageSql = fixture.calls.find((query) => typeof query === 'string' && query.includes('AS receipt_positive_total'))
    expect(fixture.calls[0]).toBe(copy.ORDER_PREPAID_CARD_RECALC_SQL)
    expect(coverageSql).toContain("sop.change_type IN ('首次支付','回款','储值卡抵扣')")
    expect(coverageSql).not.toContain("'退款'")
    expect(copy.SALE_ITEMS_RECEIVED_FROM_RECEIPTS_SQL).toContain("'退款'")
    expect(fixture.calls).toContain(copy.SALE_ITEMS_RECEIVED_FROM_RECEIPTS_SQL)
    expect(fixture.calls).not.toContain(copy.SALE_ITEMS_RECEIVED_ALLOC_SQL)
    expect(fixture.calls).not.toContain(copy.RECEIVED_REFUNDED_DEDUCT_SQL)
    expect(fixture.calls.indexOf(copy.CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL))
      .toBeLessThan(fixture.calls.indexOf(copy.SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL))
    expect(fixture.calls.indexOf(copy.SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL))
      .toBeLessThan(fixture.calls.indexOf(copy.PAID_SESSIONS_RECALC_SQL))
    expect(fixture.state).toEqual({ received: 60, paidSessions: 6 })
  })

  test.each(PAID_SESSION_COPIES)('%s: 不完整正向 receipt 时 Branch B 必须执行逐项退款扣减', async (_name, copy) => {
    const fixture = makeRecalcFixture(copy, 0)

    await copy.recalcPaidSessionsForOrder(fixture.client, 'order-refund-fallback')

    const allocationIndex = fixture.calls.indexOf(copy.SALE_ITEMS_RECEIVED_ALLOC_SQL)
    const deductIndex = fixture.calls.indexOf(copy.RECEIVED_REFUNDED_DEDUCT_SQL)
    const conversionIndex = fixture.calls.indexOf(copy.CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL)
    const channelIndex = fixture.calls.indexOf(copy.SALE_ITEMS_PAYMENT_CHANNEL_ALLOC_SQL)
    const recalcIndex = fixture.calls.indexOf(copy.PAID_SESSIONS_RECALC_SQL)
    expect(allocationIndex).toBeGreaterThan(-1)
    expect(deductIndex).toBeGreaterThan(allocationIndex)
    expect(conversionIndex).toBeGreaterThan(deductIndex)
    expect(channelIndex).toBeGreaterThan(conversionIndex)
    expect(recalcIndex).toBeGreaterThan(channelIndex)
    expect(fixture.state).toEqual({ received: 60, paidSessions: 6 })
  })
})

describe('转换单转入次数随实际到账解锁', () => {
  test.each(PAID_SESSION_COPIES)('%s: 旧卡3500转入5000，到账500只解锁80%，结清1500后解锁100%', async (_name, copy) => {
    async function recalcWithReceived(orderReceived) {
      const state = {
        orderReceived,
        outReceived: -3500,
        inItems: [
          { saleAmount: 2500, received: 2500, sessionCount: 5, paidSessions: 5 },
          { saleAmount: 2500, received: 2500, sessionCount: 5, paidSessions: 5 },
        ],
      }
      const client = {
        query: async (query) => {
          if (typeof query === 'string' && query.includes('AS receipt_positive_total')) {
            return { rows: [{ receipt_positive_total: String(orderReceived), order_received: String(orderReceived) }] }
          }
          if (query === copy.CONVERSION_IN_ITEMS_RECEIVED_RECALC_SQL) {
            const totalIn = state.inItems.reduce((sum, item) => sum + item.saleAmount, 0)
            const target = Math.min(totalIn, Math.abs(state.outReceived) + state.orderReceived)
            let allocated = 0
            state.inItems.forEach((item, index) => {
              item.received = index === state.inItems.length - 1
                ? Math.round((target - allocated) * 100) / 100
                : Math.round((target * item.saleAmount / totalIn) * 100) / 100
              allocated += item.received
            })
          }
          if (query === copy.PAID_SESSIONS_RECALC_SQL) {
            state.inItems.forEach((item) => {
              item.paidSessions = copy.computePaidSessionsForItem({
                itemReceived: item.received,
                itemSaleAmount: item.saleAmount,
                itemSessionCount: item.sessionCount,
                orderTotal: 1500,
                orderRefunded: 0,
              })
            })
          }
          return { rows: [], rowCount: 0 }
        },
      }
      await copy.recalcPaidSessionsForOrder(client, 'conversion-order')
      return state.inItems
    }

    const partial = await recalcWithReceived(500)
    expect(partial.map((item) => item.received)).toEqual([2000, 2000])
    expect(partial.map((item) => item.paidSessions)).toEqual([4, 4])

    const settled = await recalcWithReceived(1500)
    expect(settled.map((item) => item.received)).toEqual([2500, 2500])
    expect(settled.map((item) => item.paidSessions)).toEqual([5, 5])
  })
})
