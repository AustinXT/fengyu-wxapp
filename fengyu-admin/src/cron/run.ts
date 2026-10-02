/**
 * runDailyJobs — 串行执行 15 个 STEP，每个 STEP 独立 try/catch
 *
 * 与原 cronTask 入口的关键差异：
 *   - 原入口的整体 try 单点：任一 STEP 抛异常 → 后续 STEP 全部跳过
 *   - 此处改为 STEP 级隔离：单 STEP 失败仅记 errorStepCount + console.error，不影响下一 STEP
 *
 * STEP 间存在 happens-before 关系（STEP 2 升级后，STEP 3/4 应读到新等级），
 * 因此必须串行而非并发。
 *
 * STEP 顺序（2026-04-26 sale-order-domain-refactor 后）：
 *   1. closeExpiredAppointments — 业务清扫，先关掉超期预约（与后续重算无依赖）
 *   2. customerStatus           — 重算 client_wechat_users.customer_status
 *   3. monthlyActivity          — 重算 monthly_activity 月度客活（依赖 customer_type，不依赖等级）
 *   4. memberLevels             — 重算会员等级 + 升降级权益（依赖最新 sale_orders）
 *   5. spendingTier             — 重算 spending_tier 终身消费档位（依赖 sale_orders）
 *   6. birthday                 — 当日生日权益（依赖 member_level）
 *   7. thanksgiving             — 月度感恩权益（仅 20 号；依赖 member_level）
 *   8. resetCrossStoreFlags     — 重置顾客临时跨店标记（写入清扫；员工出差已改为长期保留，2026-07-13）
 *   9. pointsExpiry             — 积分批次过期扣减 + 60/30/7 天到期提醒
 *  10. visitPointsRetry         — 重试服务完成时失败的到店积分（仅失败日志，不扫历史）
 *  11. pointsAudit              — 积分余额一致性校验（只读告警）
 *  12. roleTypeNullsAudit       — sa/sc role_type NULL 监控（只读告警）
 *  13. paymentInvariants        — 6 项资金不变量守护（只读告警；新增 2026-04-26）
 *  14. refundCascadeCoverage    — 退款 5 通道级联巡检（只读告警；新增 2026-05-18）
 *  15. storeUnbindOrphans       — store_unbind_requests 孤儿巡检（只读告警；新增 2026-05-18）
 *
 *  客活/消费档位（STEP 3/5）2026-05-26 从 db/scripts/ 游离脚本纳入 cron-worker，根治筛选空。
 */

import { db } from '@/db'
import type { CronContext } from './lib/cron-context'
import { refreshCustomerStatus } from './steps/refresh-customer-status'
import { refreshMonthlyActivity } from './steps/refresh-monthly-activity'
import { refreshMemberLevels } from './steps/refresh-member-levels'
import { refreshSpendingTier } from './steps/refresh-spending-tier'
import { grantBirthdayBenefits } from './steps/grant-birthday-benefits'
import { grantThanksgivingBenefits } from './steps/grant-thanksgiving-benefits'
import { processPointsExpiry } from './steps/process-points-expiry'
import { auditPointsBalance } from './steps/audit-points-balance'
import { auditRoleTypeNulls } from './steps/audit-role-type-nulls'
import { auditPaymentInvariants } from './steps/audit-payment-invariants'
import { auditRefundCascadeCoverage } from './steps/audit-refund-cascade-coverage'
import { auditStoreUnbindOrphans } from './steps/audit-store-unbind-orphans'
import { auditActiveAdminCount } from './steps/audit-active-admin-count'
import { closeExpiredAppointments } from './steps/close-expired-appointments'
import { resetCrossStoreFlags } from './steps/reset-cross-store-flags'
import { retryVisitPoints } from './steps/retry-visit-points'

export type Db = typeof db

export interface DailyJobsResult {
  ok: boolean
  errorStepCount: number
  summary: Record<string, unknown>
}

/**
 * STEP 函数签名：
 *   - 写入类 STEP（前 5 个）：(db, ctx?) 支持时间注入
 *   - 审计类 STEP（后 5 个，只读）：(db) 不依赖时间窗口，签名兼容（额外 ctx 参数忽略）
 *
 * TypeScript 上声明为统一类型，运行时审计 STEP 忽略 ctx。
 */
type StepFn = (db: Db, ctx?: CronContext) => Promise<unknown>

const STEPS: ReadonlyArray<readonly [string, StepFn]> = [
  // —— 业务清扫（写入）——
  ['closeExpiredAppointments', closeExpiredAppointments],
  // —— 状态/等级重算 ——
  ['customerStatus', refreshCustomerStatus],
  ['monthlyActivity', refreshMonthlyActivity],
  ['memberLevels', refreshMemberLevels],
  ['spendingTier', refreshSpendingTier],
  // —— 权益发放 ——
  ['birthday', grantBirthdayBenefits],
  ['thanksgiving', grantThanksgivingBenefits],
  // —— 顾客临时跨店标记重置（写入清扫；员工出差已改为长期保留，不感知 ctx）——
  ['resetCrossStoreFlags', resetCrossStoreFlags as StepFn],
  // —— 积分批次到期处理与顾客提醒 ——
  ['pointsExpiry', processPointsExpiry],
  // —— 积分失败补偿（写入；必须在余额审计前）——
  ['visitPointsRetry', retryVisitPoints],
  // —— 数据完整性审计（只读，放在末尾，不感知 ctx）——
  ['pointsAudit', auditPointsBalance as StepFn],
  ['roleTypeNullsAudit', auditRoleTypeNulls as StepFn],
  ['paymentInvariants', auditPaymentInvariants as StepFn],
  ['refundCascadeCoverage', auditRefundCascadeCoverage as StepFn],
  ['storeUnbindOrphans', auditStoreUnbindOrphans as StepFn],
  ['activeAdminCount', auditActiveAdminCount as StepFn],
] as const

export interface RunOptions {
  /** 只跑指定 STEP（CI/e2e 用）。生产留空跑全套 */
  only?: string
}

/**
 * 解析 env CRON_REFERENCE_DATE 为 Date（Asia/Shanghai 03:00 锚点）。
 * 仅测试链路设置此 env；生产不设。
 */
function parseReferenceDate(): Date | undefined {
  const raw = process.env.CRON_REFERENCE_DATE
  if (!raw) return undefined
  // 接受 'YYYY-MM-DD' 或完整 ISO 字符串；前者锚定到当日 03:00 +0800
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(raw + 'T03:00:00+08:00')
    : new Date(raw)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`CRON_REFERENCE_DATE 解析失败: ${raw}`)
  }
  return d
}

export async function runDailyJobs(opts?: RunOptions): Promise<DailyJobsResult> {
  console.log('[cron-worker] start daily jobs at', new Date().toISOString())
  const summary: Record<string, unknown> = {}
  let errorStepCount = 0

  const referenceDate = parseReferenceDate()
  const ctx: CronContext | undefined = referenceDate ? { referenceDate } : undefined
  if (ctx) {
    console.log(`[cron-worker] CRON_REFERENCE_DATE=${ctx.referenceDate?.toISOString()}`)
  }

  const targetSteps = opts?.only ? STEPS.filter(([n]) => n === opts.only) : STEPS
  if (opts?.only && targetSteps.length === 0) {
    throw new Error(
      `--only=${opts.only} 未匹配任何 STEP。可用：${STEPS.map(([n]) => n).join(', ')}`,
    )
  }

  for (const [name, fn] of targetSteps) {
    const startedAt = Date.now()
    try {
      summary[name] = await fn(db, ctx)
      console.log(
        `[cron-worker] ${name}: ${JSON.stringify(summary[name])} (${Date.now() - startedAt}ms)`,
      )
    } catch (err) {
      errorStepCount++
      summary[name] = { error: (err as Error).message }
      console.error(`[cron-worker] ${name} failed:`, err)
    }
  }

  return { ok: errorStepCount === 0, errorStepCount, summary }
}
