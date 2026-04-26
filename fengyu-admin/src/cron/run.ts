/**
 * runDailyJobs — 串行执行 8 个 STEP，每个 STEP 独立 try/catch
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
 *   3. memberLevels             — 重算会员等级 + 升降级权益（依赖最新 sale_orders）
 *   4. birthday                 — 当日生日权益（依赖 member_level）
 *   5. thanksgiving             — 月度感恩权益（仅 20 号；依赖 member_level）
 *   6. pointsAudit              — 积分余额一致性校验（只读告警）
 *   7. roleTypeNullsAudit       — sa/sc role_type NULL 监控（只读告警）
 *   8. paymentInvariants        — 5 项资金不变量守护（只读告警；新增 2026-04-26）
 */

import { db } from '@/db'
import { refreshCustomerStatus } from './steps/refresh-customer-status'
import { refreshMemberLevels } from './steps/refresh-member-levels'
import { grantBirthdayBenefits } from './steps/grant-birthday-benefits'
import { grantThanksgivingBenefits } from './steps/grant-thanksgiving-benefits'
import { auditPointsBalance } from './steps/audit-points-balance'
import { auditRoleTypeNulls } from './steps/audit-role-type-nulls'
import { auditPaymentInvariants } from './steps/audit-payment-invariants'
import { closeExpiredAppointments } from './steps/close-expired-appointments'

export type Db = typeof db

export interface DailyJobsResult {
  ok: boolean
  errorStepCount: number
  summary: Record<string, unknown>
}

const STEPS: ReadonlyArray<readonly [string, (db: Db) => Promise<unknown>]> = [
  // —— 业务清扫（写入）——
  ['closeExpiredAppointments', closeExpiredAppointments],
  // —— 状态/等级重算 ——
  ['customerStatus', refreshCustomerStatus],
  ['memberLevels', refreshMemberLevels],
  // —— 权益发放 ——
  ['birthday', grantBirthdayBenefits],
  ['thanksgiving', grantThanksgivingBenefits],
  // —— 数据完整性审计（只读，放在末尾）——
  ['pointsAudit', auditPointsBalance],
  ['roleTypeNullsAudit', auditRoleTypeNulls],
  ['paymentInvariants', auditPaymentInvariants],
] as const

export async function runDailyJobs(): Promise<DailyJobsResult> {
  console.log('[cron-worker] start daily jobs at', new Date().toISOString())
  const summary: Record<string, unknown> = {}
  let errorStepCount = 0

  for (const [name, fn] of STEPS) {
    const startedAt = Date.now()
    try {
      summary[name] = await fn(db)
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
