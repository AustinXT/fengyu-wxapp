/**
 * STEP 7 — auditPaymentInvariants（6 项资金不变量守护）
 *
 * 关键场景：
 *   A 全部不变量通过 → violations=0，零 INSERT
 *   B 任一不变量违反 → 单条 INSERT operation_logs(action='cron.audit_invariants') + notifyOps
 *   C 永不修补（无 UPDATE 调用）
 *   D 8 条 SELECT（I1/I2/I2b/I3/I4/I5/I6/I6b）都按预期模板出现（保证后续日志聚合一致）
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
    // 8 次 SELECT 均返回空（无违规）：I1 received / I2 refunded_amount / I2b refunded_le_received /
    // I3 points_balance / I4 prepaid_balance / I5 payable_eq_total_minus_prepaid /
    // I6 first_payment_attribution_eq_order / I6b card_attribution_eq_paired_primary
    for (let i = 0; i < 8; i++) mockExecute.mockResolvedValueOnce([])

    const result = await auditPaymentInvariants(mockDb as never)

    expect(result.violations).toBe(0)
    expect(result.details).toEqual([])
    // 无 INSERT 调用、无 webhook
    expect(mockExecute).toHaveBeenCalledTimes(8)
    expect(notifyOpsMock).not.toHaveBeenCalled()
    expect(mockDb.transaction).not.toHaveBeenCalled()
  })

  it('B. I1 违反 → 写一条聚合 operation_logs + notifyOps 一次', async () => {
    mockExecute.mockResolvedValueOnce([
      { sale_order_id: 'o1', received: 100, computed: 80 },
    ]) // I1 violation
    mockExecute.mockResolvedValueOnce([]) // I2
    mockExecute.mockResolvedValueOnce([]) // I2b
    mockExecute.mockResolvedValueOnce([]) // I3
    mockExecute.mockResolvedValueOnce([]) // I4
    mockExecute.mockResolvedValueOnce([]) // I5
    mockExecute.mockResolvedValueOnce([]) // I6
    mockExecute.mockResolvedValueOnce([]) // I6b
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
    for (let i = 0; i < 7; i++) mockExecute.mockResolvedValueOnce([])
    mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

    await auditPaymentInvariants(mockDb as never)

    const writeCalls = mockExecute.mock.calls.filter((c) => {
      const s = sqlTextOf(c[0])
      return /\bUPDATE\s+|\bDELETE\s+FROM\b/.test(s)
    })
    expect(writeCalls.length).toBe(0)
  })

  it('D. 6 项不变量按预期 SQL 模板出现', async () => {
    for (let i = 0; i < 8; i++) mockExecute.mockResolvedValueOnce([])

    await auditPaymentInvariants(mockDb as never)

    const sqlTexts = mockExecute.mock.calls.map((c) => sqlTextOf(c[0]))
    // I1 received  / I2 refunded_amount / I3 point_batches balance / I4 prepaid balance / I5 payable
    expect(sqlTexts.some((s) => s.includes('so.received') && s.includes('change_type IN'))).toBe(true)
    // I1 必须豁免历史单（legacy_source='workfine'）：历史单 received 为旧系统平移值、无支付流水
    const i1 = sqlTexts.find((s) => s.includes('so.received') && s.includes('change_type IN'))!
    expect(i1).toContain("legacy_source IS DISTINCT FROM 'workfine'")
    // ⚠ 该 WHERE 必须排在 LEFT JOIN 之后 —— 2026-07-20 加豁免时插到了 JOIN 前面，
    // 那是 PG 语法错误，r1 一抛整个 STEP 就退出，I1~I5 静默停摆近两个月（issue #137 修复）。
    // 单测 mock 掉了 db.execute，只能靠这条结构断言守住；真实语法由 e2e-chains cron-08 把关。
    expect(i1).toContain('LEFT JOIN')
    expect(i1.indexOf('LEFT JOIN')).toBeLessThan(i1.indexOf('WHERE'))
    expect(sqlTexts.some((s) => s.includes('refunded_amount') && s.includes("change_type = '退款'"))).toBe(true)
    expect(sqlTexts.some((s) => s.includes('refunded_amount::numeric > so.received'))).toBe(true) // I2b refunded_le_received
    expect(sqlTexts.some((s) => s.includes('points_balance') && s.includes('point_batches'))).toBe(true)
    expect(sqlTexts.some((s) => s.includes('prepaid_cards') && s.includes('card_transactions'))).toBe(true)
    expect(sqlTexts.some((s) => s.includes('payable_amount') && s.includes('total_amount'))).toBe(true)
    // I5 必须只校验正向销售链（销售单/内部单/转换单/寄存单），充值单的「面额-实付」差是赠送差，业务正确
    const i5 = sqlTexts.find((s) => s.includes('payable_amount') && s.includes('total_amount'))!
    expect(i5).toContain('销售单')
    expect(i5).toContain('寄存单')
    expect(i5).not.toContain('充值单')
    // I6 首次支付归属日期 = 订单级（issue #137：查询侧直读列后，镜像脱拍会让业绩落错日子）
    const i6 = sqlTexts.find((s) => s.includes("p.change_type = '首次支付'"))!
    expect(i6).toBeDefined()
    expect(i6).toContain('IS DISTINCT FROM so.performance_attribution_date')
    // I6b 同次卡行 = 配对主流水（谓词必须与 trigger / 迁移自检的配对条件一致）
    const i6b = sqlTexts.find((s) => s.includes("card.change_type = '储值卡抵扣'"))!
    expect(i6b).toBeDefined()
    expect(i6b).toContain('p.paid_at IS NOT DISTINCT FROM card.paid_at')
    expect(i6b).toContain("card.status = '已支付'")
  })

  it('E. 多个不变量同时违反 → details 累积，notifyOps 仅一次', async () => {
    mockExecute.mockResolvedValueOnce([
      { sale_order_id: 'o1', received: 100, computed: 0 },
    ])
    mockExecute.mockResolvedValueOnce([
      { sale_order_id: 'o2', refunded_amount: 50, computed: 0 },
    ])
    for (let i = 0; i < 6; i++) mockExecute.mockResolvedValueOnce([]) // I2b/I3/I4/I5/I6/I6b
    mockExecute.mockResolvedValueOnce([]) // INSERT operation_logs

    const result = await auditPaymentInvariants(mockDb as never)

    expect(result.violations).toBe(2)
    expect(result.details.map((d) => d.invariant)).toEqual([
      'received_eq_sum_payments',
      'refunded_amount_eq_neg_sum_refund_payments',
    ])
    expect(notifyOpsMock).toHaveBeenCalledTimes(1)
  })
})
