/**
 * STEP 7 — auditPaymentInvariants（5 项资金不变量守护）
 *
 * 关键场景：
 *   A 全部不变量通过 → violations=0，零 INSERT
 *   B 任一不变量违反 → 单条 INSERT operation_logs(action='cron.audit_invariants') + notifyOps
 *   C 永不修补（无 UPDATE 调用）
 *   D 5 项 SELECT 都按预期顺序执行（保证后续日志聚合一致）
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

import { auditPaymentInvariants } from '../steps/audit-payment-invariants'

describe('cron-worker STEP 7 — auditPaymentInvariants', () => {
  beforeEach(() => {
    mockExecute.mockReset()
    mockDb.transaction.mockClear()
    notifyOpsMock.mockClear()
  })

  it('A. 全部不变量通过 → violations=0，零写入', async () => {
    // 5 次 SELECT 均返回空（无违规）
    for (let i = 0; i < 5; i++) mockExecute.mockResolvedValueOnce([])

    const result = await auditPaymentInvariants(mockDb as never)

    expect(result.violations).toBe(0)
    expect(result.details).toEqual([])
    // 无 INSERT 调用、无 webhook
    expect(mockExecute).toHaveBeenCalledTimes(5)
    expect(notifyOpsMock).not.toHaveBeenCalled()
    expect(mockDb.transaction).not.toHaveBeenCalled()
  })

  it('B. I1 违反 → 写一条聚合 operation_logs + notifyOps 一次', async () => {
    mockExecute.mockResolvedValueOnce([
      { sale_order_id: 'o1', received: 100, computed: 80 },
    ]) // I1 violation
    mockExecute.mockResolvedValueOnce([]) // I2
    mockExecute.mockResolvedValueOnce([]) // I3
    mockExecute.mockResolvedValueOnce([]) // I4
    mockExecute.mockResolvedValueOnce([]) // I5
    mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

    const result = await auditPaymentInvariants(mockDb as never)

    expect(result.violations).toBe(1)
    expect(result.details[0].invariant).toBe('received_eq_sum_payments')
    expect(result.details[0].count).toBe(1)

    // 单条聚合 INSERT
    const logCalls = mockExecute.mock.calls.filter((c) =>
      sqlTextOf(c[0]).includes('cron.audit_invariants'),
    )
    expect(logCalls.length).toBe(1)
    // detail 参数含 invariant 名称
    const params = paramsOf(logCalls[0][0])
    const jsonParam = params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('{'),
    )
    expect(jsonParam).toContain('received_eq_sum_payments')

    // notifyOps 调用 1 次
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
    const msg = notifyOpsMock.mock.calls[0][0] as string
    expect(msg).toContain('cron.audit_invariants')
    expect(msg).toContain('received_eq_sum_payments')
  })

  it('C. 永不修补：不发出任何 UPDATE / DELETE', async () => {
    mockExecute.mockResolvedValueOnce([
      { sale_order_id: 'o1', received: 100, computed: 0 },
    ])
    for (let i = 0; i < 4; i++) mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([])

    await auditPaymentInvariants(mockDb as never)

    const writeCalls = mockExecute.mock.calls.filter((c) => {
      const s = sqlTextOf(c[0])
      return /\bUPDATE\s+|\bDELETE\s+FROM\b/.test(s)
    })
    expect(writeCalls.length).toBe(0)
  })

  it('D. 5 项不变量按预期 SQL 模板出现', async () => {
    for (let i = 0; i < 5; i++) mockExecute.mockResolvedValueOnce([])

    await auditPaymentInvariants(mockDb as never)

    const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
    // I1 received  / I2 refunded_amount / I3 points_balance / I4 prepaid balance / I5 payable
    expect(sqlTexts.some((s) => s.includes('so.received') && s.includes('change_type IN'))).toBe(true)
    expect(sqlTexts.some((s) => s.includes('refunded_amount') && s.includes("change_type = '退款'"))).toBe(true)
    expect(sqlTexts.some((s) => s.includes('points_balance') && s.includes('point_transactions'))).toBe(true)
    expect(sqlTexts.some((s) => s.includes('prepaid_cards') && s.includes('card_transactions'))).toBe(true)
    expect(sqlTexts.some((s) => s.includes('payable_amount') && s.includes('total_amount'))).toBe(true)
  })

  it('E. 多个不变量同时违反 → details 累积，notifyOps 仅一次', async () => {
    mockExecute.mockResolvedValueOnce([
      { sale_order_id: 'o1', received: 100, computed: 0 },
    ])
    mockExecute.mockResolvedValueOnce([
      { sale_order_id: 'o2', refunded_amount: 50, computed: 0 },
    ])
    mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([])

    const result = await auditPaymentInvariants(mockDb as never)

    expect(result.violations).toBe(2)
    expect(result.details.map((d) => d.invariant)).toEqual([
      'received_eq_sum_payments',
      'refunded_amount_eq_neg_sum_refund_payments',
    ])
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
  })
})
