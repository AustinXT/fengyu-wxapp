/**
 * STEP 9 — auditRefundCascadeCoverage（退款 5 通道级联巡检）
 *
 * 关键场景：
 *   A 全部通道一致 → violations=0，零写入
 *   B 任一通道 mismatch → 单条聚合 INSERT operation_logs(action='cron.audit_refund_cascade') + notifyOps
 *   C 永不修补：无 UPDATE / DELETE
 *   D 通道 SQL 模板按预期出现（含 paid_at / pickup_quantity 这两个易错列名）
 *   E 多通道同时违反 → details 累积，notifyOps 仅一次
 *
 * #154：C5 从「退款是否回滚 picked_up」改为「picked_up == SUM(pickup_records)」守恒，
 * 并新增 C5b「已结算三列之和不得超过 quantity」——故查询数由 5 条变成 6 条。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sqlTextOf, paramsOf } from './_helpers'

const mockExecute = vi.fn()
const mockDb = {
  execute: mockExecute,
  transaction: vi.fn(),
}

vi.mock('@/db', () => ({
  get db() {
    return mockDb
  },
}))

const notifyOpsMock = vi.fn<(msg: string) => Promise<void>>()
vi.mock('../lib/notify', () => ({
  notifyOps: (msg: string) => notifyOpsMock(msg),
}))

import { auditRefundCascadeCoverage } from '../steps/audit-refund-cascade-coverage'

describe('cron-worker STEP 9 — auditRefundCascadeCoverage', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
    notifyOpsMock.mockClear()
  })

  it('A. 全部通道一致 → violations=0，零写入', async () => {
    for (let i = 0; i < 6; i++) mockExecute.mockResolvedValueOnce([])

    const result = await auditRefundCascadeCoverage(mockDb as never)

    expect(result.violations).toBe(0)
    expect(result.details).toEqual([])
    expect(mockExecute).toHaveBeenCalledTimes(6)
    expect(notifyOpsMock).not.toHaveBeenCalled()
    expect(mockDb.transaction).not.toHaveBeenCalled()
  })

  it('B. C1 缺 1 → 单条聚合 INSERT operation_logs + notifyOps 一次', async () => {
    mockExecute.mockResolvedValueOnce([
      { sop_id: 1, sale_order_id: 'FY-XSD-WX-2604010001', ref_sale_item_id: 'si-1' },
    ]) // C1 violation
    mockExecute.mockResolvedValueOnce([]) // C2
    mockExecute.mockResolvedValueOnce([]) // C3
    mockExecute.mockResolvedValueOnce([]) // C4
    mockExecute.mockResolvedValueOnce([]) // C5
    mockExecute.mockResolvedValueOnce([]) // C5b
    mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

    const result = await auditRefundCascadeCoverage(mockDb as never)

    expect(result.violations).toBe(1)
    expect(result.details[0].channel).toBe('sa_not_reversed')
    expect(result.details[0].count).toBe(1)

    const logCalls = mockExecute.mock.calls.filter((c) =>
      sqlTextOf(c[0]).includes('cron.audit_refund_cascade'),
    )
    expect(logCalls.length).toBe(1)
    const params = paramsOf(logCalls[0][0])
    const jsonParam = params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('{'),
    )
    expect(jsonParam).toContain('sa_not_reversed')
    expect(jsonParam).toContain('refund_cascade_coverage')

    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('cron.audit_refund_cascade')
    expect(msg).toContain('sa_not_reversed')
  })

  it('C. 永不修补：不发出任何 UPDATE / DELETE', async () => {
    mockExecute.mockResolvedValueOnce([
      { sop_id: 1, sale_order_id: 'o1', ref_sale_item_id: null },
    ])
    for (let i = 0; i < 4; i++) mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([])

    await auditRefundCascadeCoverage(mockDb as never)

    const writeCalls = mockExecute.mock.calls.filter((c) => {
      const s = sqlTextOf(c[0])
      return /\bUPDATE\s+|\bDELETE\s+FROM\b/.test(s)
    })
    expect(writeCalls.length).toBe(0)
  })

  it('D. 通道 SQL 模板按预期出现（含 paid_at / pickup_quantity 易错列名）', async () => {
    for (let i = 0; i < 6; i++) mockExecute.mockResolvedValueOnce([])

    await auditRefundCascadeCoverage(mockDb as never)

    const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
    // C1 receipt 子分配
    expect(sqlTexts.some((s) =>
      s.includes('sale_payment_item_receipts') &&
      s.includes('sale_payment_item_allocations') &&
      s.includes('allocated_amount < 0') &&
      s.includes('role_type') &&
      s.includes('WITH RECURSIVE') &&
      s.includes('refund_replay') &&
      s.includes('remaining_receipt_cents') &&
      s.includes('remaining_pool_cents') &&
      s.includes('ORDER BY sop.paid_at NULLS LAST, sop.id, spir.id') &&
      s.includes('re.refund_cents::numeric * replay.remaining_pool_cents') &&
      s.includes('/ NULLIF(replay.remaining_receipt_cents, 0)') &&
      s.includes('SUM(target_cents) AS expected_negative_cents') &&
      s.includes('expected_negative') &&
      s.includes('ABS(actual_negative_cents - expected_negative_cents) > 1'),
    )).toBe(true)
    // C2 service_commissions
    expect(sqlTexts.some((s) => s.includes('service_commissions') && s.includes('voided_at'))).toBe(true)
    // C3 user_coupons + paid_at（关键易错列名 — 不是 updated_at）
    expect(sqlTexts.some((s) => s.includes('user_coupons') && s.includes('paid_at'))).toBe(true)
    // C4 point_transactions + 消费冲销
    expect(sqlTexts.some((s) => s.includes('point_transactions') && s.includes('消费冲销'))).toBe(true)
    // C5 pickup_records.pickup_quantity（关键易错列名 — 不是 quantity 或 picked_quantity）
    expect(sqlTexts.some((s) => s.includes('pickup_records') && s.includes('pickup_quantity'))).toBe(true)
    // #154：C5 判据必须与退款解耦——继续 JOIN 退款流水就会把「既提过货又退过款」的行恒判为
    // mismatch（2026-06-08 止血把退款数加进 picked_up 之后，旧判据 picked_up >= SUM 恒成立）。
    const c5 = sqlTexts.find((s) => s.includes('pickup_records') && s.includes('<>'))
    expect(c5, 'C5 未改成守恒判据').toBeDefined()
    expect(c5).not.toContain("change_type = '退款'")
    expect(c5).toContain("s.product_type = '家居产品'")
    // C5b 已结算三列之和不得超过 quantity（迁移 0043 未加 CHECK，这条巡检是它的替身）
    expect(sqlTexts.some((s) =>
      s.includes('COALESCE(s.picked_up_quantity, 0)') &&
      s.includes('COALESCE(s.refunded_quantity, 0)') &&
      s.includes('COALESCE(s.converted_quantity, 0)') &&
      s.includes('> s.quantity'),
    ), 'C5b settled_quantity_overflow 缺失').toBe(true)
  })

  it('E. C2 + C5 同时违反 → details 累积，notifyOps 仅一次', async () => {
    mockExecute.mockResolvedValueOnce([]) // C1 ok
    mockExecute.mockResolvedValueOnce([
      { sop_id: 11, sale_order_id: 'oA', ref_sale_item_id: 'si-A' },
      { sop_id: 12, sale_order_id: 'oB', ref_sale_item_id: 'si-B' },
    ]) // C2 violation x2
    mockExecute.mockResolvedValueOnce([]) // C3 ok
    mockExecute.mockResolvedValueOnce([]) // C4 ok
    mockExecute.mockResolvedValueOnce([
      { sale_item_id: 'si-C', current_picked: 5, total_picked: 3 },
    ]) // C5 violation x1
    mockExecute.mockResolvedValueOnce([]) // C5b ok
    mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

    const result = await auditRefundCascadeCoverage(mockDb as never)

    expect(result.violations).toBe(2)
    expect(result.details.map((d) => d.channel)).toEqual([
      'sc_not_voided',
      'pickup_quantity_mismatch',
    ])
    expect(result.details[0].count).toBe(2)
    expect(result.details[1].count).toBe(1)
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('sc_not_voided: 2 条 mismatch')
    expect(msg).toContain('pickup_quantity_mismatch: 1 条 mismatch')
  })
})
