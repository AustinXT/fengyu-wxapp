

import { db } from '@/db'
import type { CronContext } from './lib/cron-context'
import { refreshCustomerStatus } from './steps/refresh-customer-status'
import { refreshMonthlyActivity } from './steps/refresh-monthly-activity'
import { refreshMemberLevels } from './steps/refresh-member-levels'
import { refreshSpendingTier } from './steps/refresh-spending-tier'
import { grantBirthdayBenefits } from './steps/grant-birthday-benefits'
import { grantThanksgivingBenefits } from './steps/grant-thanksgiving-benefits'
import { auditPointsBalance } from './steps/audit-points-balance'
import { auditRoleTypeNulls } from './steps/audit-role-type-nulls'
import { auditPaymentInvariants } from './steps/audit-payment-invariants'
import { auditRefundCascadeCoverage } from './steps/audit-refund-cascade-coverage'
import { auditStoreUnbindOrphans } from './steps/audit-store-unbind-orphans'
import { closeExpiredAppointments } from './steps/close-expired-appointments'
import { resetCrossStoreFlags } from './steps/reset-cross-store-flags'

export type Db = typeof db

export interface DailyJobsResult {
  ok: boolean
  errorStepCount: number
  summary: Record<string, unknown>
}


type StepFn = (db: Db, ctx?: CronContext) => Promise<unknown>

const STEPS: ReadonlyArray<readonly [string, StepFn]> = [
  
  ['closeExpiredAppointments', closeExpiredAppointments],
  
  ['customerStatus', refreshCustomerStatus],
  ['monthlyActivity', refreshMonthlyActivity],
  ['memberLevels', refreshMemberLevels],
  ['spendingTier', refreshSpendingTier],
  
  ['birthday', grantBirthdayBenefits],
  ['thanksgiving', grantThanksgivingBenefits],
  
  ['resetCrossStoreFlags', resetCrossStoreFlags as StepFn],
  
  ['pointsAudit', auditPointsBalance as StepFn],
  ['roleTypeNullsAudit', auditRoleTypeNulls as StepFn],
  ['paymentInvariants', auditPaymentInvariants as StepFn],
  ['refundCascadeCoverage', auditRefundCascadeCoverage as StepFn],
  ['storeUnbindOrphans', auditStoreUnbindOrphans as StepFn],
] as const

export interface RunOptions {
  
  only?: string
}


function parseReferenceDate(): Date | undefined {
  const raw = process.env.CRON_REFERENCE_DATE
  if (!raw) return undefined
  
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
