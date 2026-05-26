/**
 * cron-08：STEP 8 auditPaymentInvariants 端到端
 *
 * 5 项资金不变量（src/cron/steps/audit-payment-invariants.ts L13-17）：
 *   I1: sale_orders.received = Σ sop[已支付, 首次支付/回款/储值卡抵扣].amount
 *   I2: sale_orders.refunded_amount = -Σ sop[已支付, 退款].amount
 *   I3: client_wechat_users.points_balance = Σ point_transactions.amount
 *   I4: prepaid_cards.balance = Σ card_transactions.amount
 *   I5: sale_orders.payable_amount = total_amount - prepaid_card_amount
 *
 * 容差：金额 0.01 / 积分严格相等。只读，不修复。
 *
 * 这是一个全表扫描的只读 STEP，跟具体测试夹具关系不大；我们验证返回结构 + 现有 PG 状态。
 * 注：单元测试已用 mock 数据精确验证 5 项 SQL 形态，e2e 此处仅做"形态 + 当前 PG 不变量状态"断言。
 */

import { test, expect } from '@playwright/test'
import { runCronStep, parseStepSummary, psql } from './_helpers/cron-runner'
import { upsertClient, cleanupCronE2E, PREFIX } from './_helpers/cron-fixtures'

interface InvariantsResult {
  violations: number
  details: Array<{
    invariant: string
    count: number
    samples: Array<Record<string, unknown>>
  }>
}

function runAudit(): InvariantsResult {
  const out = runCronStep('paymentInvariants')
  const summary = parseStepSummary<InvariantsResult>(out, 'paymentInvariants')
  if (!summary) throw new Error(`paymentInvariants summary 解析失败:\n${out}`)
  return summary
}

test.describe.serial('cron-08 auditPaymentInvariants', () => {
  test.beforeAll(() => cleanupCronE2E())
  test.afterAll(() => cleanupCronE2E())

  test('8.1 返回结构：violations 整数（=违反 invariant 项数）+ details 数组', () => {
    const r = runAudit()
    expect(typeof r.violations).toBe('number')
    expect(Array.isArray(r.details)).toBe(true)
    // violations 是"有违反的 invariant 项数"（≤ 5），而非"违反行总数"
    expect(r.violations).toBe(r.details.length)
    expect(r.violations).toBeLessThanOrEqual(5)
  })

  test('8.2 details 仅出现合法的 5 个 invariant 名（白名单）', () => {
    const r = runAudit()
    const allowedInvariants = [
      'received_eq_sum_payments',
      'refunded_amount_eq_neg_sum_refund_payments',
      'points_balance_eq_sum_txns',
      'prepaid_balance_eq_sum_card_txns',
      'payable_eq_total_minus_prepaid',
    ]
    for (const d of r.details) {
      expect(allowedInvariants).toContain(d.invariant)
    }
  })

  test('8.3 I3 不变量：构造 points_balance 不一致 → 出现在 details', () => {
    // 构造一个新用户：balance=99，无任何 point_transactions → SUM=0，差额 99
    const uid = upsertClient('PI_83', { customerType: '会员客', pointsBalance: 99 })
    const r = runAudit()
    const i3 = r.details.find((d) => d.invariant === 'points_balance_eq_sum_txns')
    expect(i3).toBeDefined()
    expect(i3!.count).toBeGreaterThanOrEqual(1)
    // 我们构造的 user_id 应该在 samples 里（限制 SAMPLE_LIMIT=100，但只要 < 100 条不一致行就一定在）
    if (i3!.count <= 100) {
      const found = i3!.samples.some((s) => s.user_id === uid)
      expect(found).toBe(true)
    }
  })

  test('8.4 修复 I3 后：该用户不再出现在 violations', () => {
    const uid = `${PREFIX.CLIENT}PI_83`
    // 把 points_balance 改成 0（与无流水的 SUM=0 一致）
    psql(`UPDATE client_wechat_users SET points_balance = 0 WHERE user_id = '${uid}'`)
    const r = runAudit()
    const i3 = r.details.find((d) => d.invariant === 'points_balance_eq_sum_txns')
    if (i3) {
      const stillIn = i3.samples.some((s) => s.user_id === uid)
      expect(stillIn).toBe(false)
    }
  })

  test('cleanup', () => {
    cleanupCronE2E()
    expect(Number(psql(`SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}PI_%'`))).toBe(0)
  })
})
