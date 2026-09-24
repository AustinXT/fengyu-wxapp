/**
 * cron-08：STEP 8 auditPaymentInvariants 端到端
 *
 * 6 项资金不变量 + I2b/I6b 监控项，共 8 条 SELECT（src/cron/steps/audit-payment-invariants.ts L11-22）：
 *   I1 : sale_orders.received = Σ sop[已支付, 首次支付/回款/储值卡抵扣].amount（豁免 workfine 历史单）
 *   I2 : sale_orders.refunded_amount = -Σ sop[已支付, 退款].amount
 *   I2b: refunded_amount ≤ received（超额退款资损监控）
 *   I3 : client_wechat_users.points_balance = Σ 未过期 point_batches.remaining_amount
 *   I4 : prepaid_cards.balance = Σ card_transactions.amount
 *   I5 : sale_orders.payable_amount = total_amount - prepaid_card_amount
 *   I6 : sop[首次支付].performance_attribution_date = sale_orders.performance_attribution_date（issue #137）
 *   I6b: sop[已支付,储值卡抵扣].performance_attribution_date = 同次配对主流水的归属日期（issue #137）
 *
 * 容差：金额 0.01 / 积分与归属日期严格相等。只读，不修复。
 *
 * 这是一个全表扫描的只读 STEP，跟具体测试夹具关系不大；我们验证返回结构 + 现有 PG 状态。
 * 注：单元测试用 mock 精确验证 SQL 形态，但 mock 掉了 db.execute —— **真实 SQL 语法只有这里能验**。
 * （2026-07-20~2026-09-14 期间 I1 的 WHERE/LEFT JOIN 顺序写反，整个 STEP 每天抛异常被吞掉，
 *   本套件因 summary 解析失败一直是红的，白名单也随之长期脱拍未被发现。）
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
    // violations 是"有违反的 invariant 项数"（≤ 8 条 SELECT），而非"违反行总数"
    expect(r.violations).toBe(r.details.length)
    expect(r.violations).toBeLessThanOrEqual(8)
  })

  test('8.2 details 仅出现合法的 invariant 名（白名单）', () => {
    const r = runAudit()
    // 与 audit-payment-invariants.ts 的 details.push 逐一对应；漏一个名字这里就会红。
    const allowedInvariants = [
      'received_eq_sum_payments',
      'refunded_amount_eq_neg_sum_refund_payments',
      'refunded_le_received',
      'points_balance_eq_unexpired_batches',
      'prepaid_balance_eq_sum_card_txns',
      'payable_eq_total_minus_prepaid',
      'first_payment_attribution_eq_order',
      'card_attribution_eq_paired_primary',
    ]
    for (const d of r.details) {
      expect(allowedInvariants).toContain(d.invariant)
    }
  })

  test('8.3 I3 不变量：构造 points_balance 不一致 → 出现在 details', () => {
    // 构造一个新用户：balance=99，无任何 point_transactions → SUM=0，差额 99
    const uid = upsertClient('PI_83', { customerType: '会员客', pointsBalance: 99 })
    const r = runAudit()
    const i3 = r.details.find((d) => d.invariant === 'points_balance_eq_unexpired_batches')
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
    const i3 = r.details.find((d) => d.invariant === 'points_balance_eq_unexpired_batches')
    if (i3) {
      const stillIn = i3.samples.some((s) => s.user_id === uid)
      expect(stillIn).toBe(false)
    }
  })

  // 这里**不**再造 I6/I6b 的违规样本：要造就得 DISABLE 核心 trigger，而本套件连的是
  // 真实 dev 业务库（`_helpers/cron-runner.ts`），DDL 会取表级强锁、阻塞并发款项写入，
  // 跑真 cron 还会写 operation_logs、可能触发企微告警。代价远大于收益。
  // I6/I6b 的谓词正确性由 `src/cron/__tests__/audit-payment-invariants.test.ts` 的结构断言
  // 与 `db/scripts/__tests__/attribution-trigger.pg.test.js`（独立临时 PG）覆盖；
  // 这里只保留 8.1/8.2 的"形态 + 白名单"断言 —— 它们恰恰是发现 I1 语法错静默停摆的那一层。

  test('cleanup', () => {
    cleanupCronE2E()
    expect(Number(psql(`SELECT COUNT(*) FROM client_wechat_users WHERE user_id LIKE '${PREFIX.CLIENT}PI_%'`))).toBe(0)
  })
})
