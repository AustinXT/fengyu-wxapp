/**
 * runDailyJobs — 串行执行 6 个 STEP，每个 STEP 独立 try/catch
 *
 * 与原 cronTask 入口的关键差异：
 *   - 原入口的整体 try 单点：任一 STEP 抛异常 → 后续 STEP 全部跳过
 *   - 此处改为 STEP 级隔离：单 STEP 失败仅记 errorStepCount + console.error，不影响下一 STEP
 *
 * STEP 间存在 happens-before 关系（STEP 2 升级后，STEP 3/4 应读到新等级），
 * 因此必须串行而非并发。STEP 5/6 是只读审计，独立于前 4 个 STEP，放在末尾。
 */

import { db } from '@/db'
import { refreshCustomerStatus } from './steps/refresh-customer-status'
import { refreshMemberLevels } from './steps/refresh-member-levels'
import { grantBirthdayBenefits } from './steps/grant-birthday-benefits'
import { grantThanksgivingBenefits } from './steps/grant-thanksgiving-benefits'
import { auditPointsBalance } from './steps/audit-points-balance'
import { auditRoleTypeNulls } from './steps/audit-role-type-nulls'

export type Db = typeof db

export interface DailyJobsResult {
  ok: boolean
  errorStepCount: number
  summary: Record<string, unknown>
}

const STEPS: ReadonlyArray<readonly [string, (db: Db) => Promise<unknown>]> = [
  ['customerStatus', refreshCustomerStatus],
  ['memberLevels', refreshMemberLevels],
  ['birthday', grantBirthdayBenefits],
  ['thanksgiving', grantThanksgivingBenefits],
  ['pointsAudit', auditPointsBalance],
  ['roleTypeNullsAudit', auditRoleTypeNulls],
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
