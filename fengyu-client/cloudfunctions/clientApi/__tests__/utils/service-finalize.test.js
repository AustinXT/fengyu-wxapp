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
