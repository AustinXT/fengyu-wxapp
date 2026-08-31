/**
 * STEP 9 — auditRefundCascadeCoverage（退款 5 通道级联巡检 + receipt 入口兜底）
 *
 * 关键场景：
 *   A 全部 5 通道一致 → violations=0，零写入
 *   B 任一通道 mismatch → 单条聚合 INSERT operation_logs(action='cron.audit_refund_cascade') + notifyOps
 *   C 永不修补：无 UPDATE / DELETE
 *   D 6 项查询 SQL 模板按预期出现（含时点快照 / 范围收敛 / receipt 兜底）
 *   E 多通道同时违反 → details 累积，notifyOps 仅一次
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

  it('A. 全部 5 通道及 receipt 兜底一致 → violations=0，零写入', async () => {
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
    mockExecute.mockResolvedValueOnce([]) // C1 receipt 兜底
    mockExecute.mockResolvedValueOnce([]) // C2
    mockExecute.mockResolvedValueOnce([]) // C3
    mockExecute.mockResolvedValueOnce([]) // C4
    mockExecute.mockResolvedValueOnce([]) // C5
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
    for (let i = 0; i < 5; i++) mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([])

    await auditRefundCascadeCoverage(mockDb as never)

    const writeCalls = mockExecute.mock.calls.filter((c) => {
      const s = sqlTextOf(c[0])
      return /\bUPDATE\s+|\bDELETE\s+FROM\b/.test(s)
    })
    expect(writeCalls.length).toBe(0)
  })

  it('D. 6 项查询 SQL 模板按预期出现（含时点快照 / 范围收敛 / receipt 兜底）', async () => {
    for (let i = 0; i < 6; i++) mockExecute.mockResolvedValueOnce([])

    await auditRefundCascadeCoverage(mockDb as never)

    const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
    const c1Sql = sqlTexts.find((s) => s.includes('refund_replay')) ?? ''
    // C1 receipt 子分配
    expect(c1Sql).toContain('sale_payment_item_receipts')
    expect(c1Sql).toContain('sale_payment_item_allocations')
    expect(c1Sql).toContain('allocated_amount < 0')
    expect(c1Sql).toContain('role_type')
    expect(c1Sql).toContain('WITH RECURSIVE scoped AS')
    expect(c1Sql).toContain('remaining_receipt_cents')
    expect(c1Sql).toContain('remaining_pool_cents')
    expect(c1Sql).toContain('ORDER BY COALESCE(sop.paid_at, sop.created_at), sop.id, spir.id')
    expect(c1Sql).toContain('re.positive_receipt_cents - re.prior_refund_cents')
    expect(c1Sql).toContain('re.positive_allocated_cents - replay.cumulative_target_cents')
    expect(c1Sql).toContain('SUM(target_cents) AS expected_negative_cents')
    expect(c1Sql).toContain('expected_negative')
    expect(c1Sql).toContain('ABS(actual_negative_cents - expected_negative_cents) > 1')
    expect(c1Sql).toMatch(/refund_events AS \([\s\S]*?FROM scoped scope/)
    expect(c1Sql).toMatch(/receipt_totals AS \([\s\S]*?JOIN scoped scope/)
    expect(c1Sql).toMatch(/positive_pools AS \([\s\S]*?JOIN scoped scope/)
    // C1 receipt 入口兜底：只检负金额退款，并用 payment id 反查负数 receipt。
    expect(sqlTexts.some((s) =>
      s.includes('sop.amount < 0') &&
      s.includes('NOT EXISTS') &&
      s.includes('spir.sale_payment_id = sop.id') &&
      s.includes('spir.amount < 0'),
    )).toBe(true)
    // C2 service_commissions
    expect(sqlTexts.some((s) => s.includes('service_commissions') && s.includes('voided_at'))).toBe(true)
    // C3 user_coupons + paid_at（关键易错列名 — 不是 updated_at）
    expect(sqlTexts.some((s) => s.includes('user_coupons') && s.includes('paid_at'))).toBe(true)
    // C4 point_transactions + 消费冲销
    expect(sqlTexts.some((s) => s.includes('point_transactions') && s.includes('消费冲销'))).toBe(true)
    // C5 pickup_records.pickup_quantity（关键易错列名 — 不是 quantity 或 picked_quantity）
    expect(sqlTexts.some((s) => s.includes('pickup_records') && s.includes('pickup_quantity'))).toBe(true)
  })

  it('D2. 退款后回款不再误报：expected=300 不被当前 R:P 重算为 225', async () => {
    for (let i = 0; i < 6; i++) mockExecute.mockResolvedValueOnce([])

    await auditRefundCascadeCoverage(mockDb as never)

    const c1Sql = mockExecute.mock.calls
      .map((c) => sqlTextOf(c[0]))
      .find((s) => s.includes('refund_replay')) ?? ''
    // 正实收和角色池都只纳入严格早于当前退款事件键的 receipt。
    expect(c1Sql).toContain('COALESCE(sop.paid_at, sop.created_at) AS refund_at')
    expect(c1Sql).toContain(
      '(COALESCE(pos_sop.paid_at, pos_sop.created_at), pos_sop.id, pos_spir.id)',
    )
    expect(c1Sql).toContain(
      '< (re.refund_at, re.refund_payment_id, re.refund_receipt_id)',
    )
  })

  it('E. C2 + C5 同时违反 → details 累积，notifyOps 仅一次', async () => {
    mockExecute.mockResolvedValueOnce([]) // C1 ok
    mockExecute.mockResolvedValueOnce([]) // C1 receipt 兜底 ok
    mockExecute.mockResolvedValueOnce([
      { sop_id: 11, sale_order_id: 'oA', ref_sale_item_id: 'si-A' },
      { sop_id: 12, sale_order_id: 'oB', ref_sale_item_id: 'si-B' },
    ]) // C2 violation x2
    mockExecute.mockResolvedValueOnce([]) // C3 ok
    mockExecute.mockResolvedValueOnce([]) // C4 ok
    mockExecute.mockResolvedValueOnce([
      { sop_id: 13, sale_item_id: 'si-C', current_picked: 5, total_picked: 5 },
    ]) // C5 violation x1
    mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

    const result = await auditRefundCascadeCoverage(mockDb as never)

    expect(result.violations).toBe(2)
    expect(result.details.map((d) => d.channel)).toEqual([
      'sc_not_voided',
      'pickup_not_rolled_back',
    ])
    expect(result.details[0].count).toBe(2)
    expect(result.details[1].count).toBe(1)
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('sc_not_voided: 2 条 mismatch')
    expect(msg).toContain('pickup_not_rolled_back: 1 条 mismatch')
  })

  it('F. 有负金额退款 sop 但无 spir 负数行 → receipt 入口兜底告警', async () => {
    mockExecute.mockResolvedValueOnce([]) // C1 纯 receipt 回放无法看到该退款
    mockExecute.mockResolvedValueOnce([
      { sop_id: 21, sale_order_id: 'o-missing', ref_sale_item_id: 'si-missing', amount: '-3.00' },
    ]) // C1 receipt 入口兜底 violation
    mockExecute.mockResolvedValueOnce([]) // C2
    mockExecute.mockResolvedValueOnce([]) // C3
    mockExecute.mockResolvedValueOnce([]) // C4
    mockExecute.mockResolvedValueOnce([]) // C5
    mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

    const result = await auditRefundCascadeCoverage(mockDb as never)

    expect(result.violations).toBe(1)
    expect(result.details).toEqual([
      {
        channel: 'c1_receipt_missing',
        count: 1,
        samples: [
          { sop_id: 21, sale_order_id: 'o-missing', ref_sale_item_id: 'si-missing', amount: '-3.00' },
        ],
      },
    ])
    expect(mockExecute).toHaveBeenCalledTimes(7)
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    expect(notifyOpsMock.mock.calls[0][0]).toContain('c1_receipt_missing: 1 条 mismatch')
  })
})
