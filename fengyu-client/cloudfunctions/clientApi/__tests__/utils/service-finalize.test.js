const { finalizeServiceOrder } = require('../../utils/service-finalize')
const { DEPOSIT_REFUND_REMARK } = require('../../utils/deposit-refund-remark')

const now = new Date('2026-08-06T00:00:00.000Z')

function makeItem(saleItemId) {
  return {
    sale_item_id: saleItemId,
    session_used: 1,
    service_item_id: `svc-${saleItemId}`,
  }
}

describe('service-finalize', () => {
  test('locks sale items in stable order and leaves reservations intact when CAS loses', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
    const client = { query }

    const finalized = await finalizeServiceOrder(
      client,
      { service_order_id: 'SVC-001', remark: DEPOSIT_REFUND_REMARK },
      [makeItem('SI-B'), makeItem('SI-A'), makeItem('SI-B')],
      now,
    )

    expect(finalized).toBe(false)
    expect(query).toHaveBeenCalledTimes(2)

    const [lockSql, lockParams] = query.mock.calls[0]
    expect(lockSql).toContain('FOR UPDATE')
    expect(lockSql).toContain('ORDER BY sale_item_id')
    expect(lockParams).toEqual([['SI-A', 'SI-B']])
    expect(query.mock.calls[1][0]).toContain("status = '已完成'")
    expect(query.mock.calls.flatMap(([sql]) => sql.match(/reserved_at = NULL/g) || [])).toHaveLength(0)
  })

  test('releases reservations only after every sale item debit succeeds', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining_sessions: 2 }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining_sessions: 2 }] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
    const client = { query }

    const finalized = await finalizeServiceOrder(
      client,
      { service_order_id: 'SVC-002', remark: DEPOSIT_REFUND_REMARK },
      [makeItem('SI-B'), makeItem('SI-A')],
      now,
    )

    expect(finalized).toBe(true)
    const sqls = query.mock.calls.map(([sql]) => sql)
    const releaseIndex = sqls.findIndex((sql) => sql.includes('reserved_at = NULL'))
    const debitIndexes = sqls
      .map((sql, index) => (sql.includes('remaining_sessions = remaining_sessions - $1') ? index : -1))
      .filter((index) => index !== -1)

    expect(debitIndexes).toEqual([2, 4])
    expect(releaseIndex).toBe(6)
    expect(releaseIndex).toBeGreaterThan(Math.max(...debitIndexes))
  })

  test('rejects a missing locked sale item before changing the service order', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [] })
    const client = { query }

    await expect(finalizeServiceOrder(
      client,
      { service_order_id: 'SVC-003', remark: DEPOSIT_REFUND_REMARK },
      [makeItem('SI-A'), makeItem('SI-B')],
      now,
    )).rejects.toThrow('INVALID_PARAMS: 部分订单行不存在')

    expect(query).toHaveBeenCalledTimes(1)
  })
})

// #379 划卡单价阈值：单次实价低于命中行 price_threshold 时按阈值 × 比例计消耗提成；
// 选档仍用原始 consumeBase；手工费叠加；阈值 NULL（非自销/他销自耗行）不生效。
describe('#379 消耗提成阈值保底', () => {
  function runFinalize({ unitRealPrice, sessionUsed = 1, serviceFee = 0, rateRow }) {
    const query = vi.fn(async (sql) => {
      if (sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [] }
      if (sql.includes('SELECT remaining_sessions')) return { rowCount: 1, rows: [{ remaining_sessions: 3 }] }
      if (sql.includes('commission_rate_matrix')) return { rowCount: rateRow ? 1 : 0, rows: rateRow ? [rateRow] : [] }
      return { rowCount: 1, rows: [] }
    })
    const item = {
      sale_item_id: 'SI-A',
      service_item_id: 'svc-A',
      employee_id: 'E1',
      skills: ['美容师'],
      session_used: sessionUsed,
      unit_real_price: unitRealPrice,
      service_fee: serviceFee,
      sales_category: '自销自耗',
    }
    return finalizeServiceOrder(client(query), { service_order_id: 'SVC-379', remark: null }, [item], now)
      .then(() => {
        const rateCall = query.mock.calls.find(([sql]) => sql.includes('commission_rate_matrix'))
        const insertCall = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO service_commissions'))
        const [, , , rate, commissionAmount, fixedFee, consumeAmount] = insertCall[1]
        return { tierBase: rateCall[1][2], rate, commissionAmount, fixedFee, consumeAmount }
      })
  }
  const client = (query) => ({ query })
  const SELF = { commission_rate: 0.15, price_threshold: 100 }

  test.each([
    ['单价 80 < 阈值 100 → 100 × 次数 × 15%', { unitRealPrice: 80, sessionUsed: 2, rateRow: SELF }, { tierBase: 160, consumeAmount: 30 }],
    ['赠送单价 NULL → 按阈值', { unitRealPrice: null, rateRow: SELF }, { tierBase: 0, consumeAmount: 15 }],
    ['赠送单价 0 → 按阈值', { unitRealPrice: 0, rateRow: SELF }, { tierBase: 0, consumeAmount: 15 }],
    ['单价 = 阈值 → 正常相乘', { unitRealPrice: 100, rateRow: SELF }, { tierBase: 100, consumeAmount: 15 }],
    ['单价 > 阈值 → 与改动前一致', { unitRealPrice: 123.45, sessionUsed: 3, rateRow: SELF }, { tierBase: 370.35, consumeAmount: 55.55 }],
    ['阈值 NULL（他销他耗行）→ 不保底', { unitRealPrice: 80, rateRow: { commission_rate: 0.02, price_threshold: null } }, { tierBase: 80, consumeAmount: 1.6 }],
    ['查无矩阵行 → rate 0，不因阈值产生提成', { unitRealPrice: 80, rateRow: null }, { tierBase: 80, consumeAmount: 0 }],
  ])('%s', async (_name, input, expected) => {
    const r = await runFinalize(input)
    expect(r.tierBase).toBe(expected.tierBase)
    expect(r.consumeAmount).toBe(expected.consumeAmount)
    expect(r.commissionAmount).toBe(expected.consumeAmount)
  })

  test('手工费叠加：fixed_fee 不受阈值影响', async () => {
    const r = await runFinalize({ unitRealPrice: 80, serviceFee: 10, rateRow: SELF })
    expect(r.fixedFee).toBe(10)
    expect(r.consumeAmount).toBe(15)
    expect(r.commissionAmount).toBe(25)
  })
})
