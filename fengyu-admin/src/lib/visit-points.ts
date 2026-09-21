/**
 * 会员到店积分 — admin 独立副本。
 *
 * 与 staffApi/clientApi 的 visit-points.js 保持同一业务口径，禁止抽取跨端共享代码；
 * 字面常量与核心 SQL 由 cross-end-sql-snapshot.test.js 守护。
 */

import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { DEPOSIT_REFUND_REMARK } from '@/lib/service-remark'

type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type SqlExecutor = Pick<typeof db, 'execute'> | AdminTx

export const VISIT_POINTS_CONFIG_KEY = 'visit_points_reward'
export const DEFAULT_VISIT_POINTS_REWARD = 20
export const VISIT_POINTS_TYPE = '到店赠送'
export const VISIT_POINTS_EXTERNAL_REF_PREFIX = 'visit-points'

export interface VisitPointsServiceSnapshot {
  serviceOrderId: string
  serviceOrderType: string | null | undefined
  serviceDate: string | null | undefined
  clientUserId: string | null | undefined
  remark: string | null | undefined
  hasPositiveItem: boolean | null | undefined
}

export interface VisitPointsResult {
  granted: boolean
  skipped?: string | null
  amount?: number
  externalRef?: string
  error?: string
}

export interface VisitPointsFailureDetail {
  rewardAmount: number
  externalRef: string
  userId: string
  serviceDate: string
  error?: string
}

export function parseVisitPointsReward(value: unknown): number {
  if (value === null || value === undefined || String(value).trim() === '') {
    return DEFAULT_VISIT_POINTS_REWARD
  }
  const normalized = String(value).trim()
  if (!/^\d+$/.test(normalized)) return 0
  const amount = Number(normalized)
  return Number.isSafeInteger(amount) ? amount : 0
}

export function normalizeServiceDate(value: unknown): string {
  if (value instanceof Date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(value)
    const pick = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? ''
    return `${pick('year')}-${pick('month')}-${pick('day')}`
  }
  const normalized = String(value || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : ''
}

export function buildVisitPointsExternalRef(userId: string, serviceDate: string): string {
  return `${VISIT_POINTS_EXTERNAL_REF_PREFIX}:${userId}:${serviceDate}`
}

export function isVisitPointsEligible(snapshot: VisitPointsServiceSnapshot): boolean {
  return Boolean(
    snapshot.serviceOrderType === '售后' &&
    snapshot.clientUserId &&
    normalizeServiceDate(snapshot.serviceDate) &&
    snapshot.remark !== DEPOSIT_REFUND_REMARK &&
    snapshot.hasPositiveItem
  )
}

export async function loadVisitPointsReward(executor: SqlExecutor): Promise<number> {
  const rows = (await executor.execute(sql`
    SELECT value FROM system_configs WHERE key = ${VISIT_POINTS_CONFIG_KEY} LIMIT 1
  `)) as unknown as Array<{ value: string }>
  return parseVisitPointsReward(rows[0]?.value)
}

export async function grantVisitPointsEntry(
  executor: SqlExecutor,
  userId: string,
  serviceDate: string,
  amount: number,
  now: Date,
): Promise<VisitPointsResult> {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false' || amount <= 0) {
    return { granted: false, skipped: 'disabled' }
  }

  const externalRef = buildVisitPointsExternalRef(userId, serviceDate)
  const result = (await executor.execute(sql`
    WITH inserted AS (
      INSERT INTO point_transactions
        (user_id, type, amount, ref_order_id, external_ref, created_at)
      VALUES (${userId}, '到店赠送', ${amount}, NULL, ${externalRef}, ${now})
      ON CONFLICT DO NOTHING
      RETURNING id, amount, created_at
    ),
    granted_batch AS (
      INSERT INTO point_batches
        (user_id, source_transaction_id, source_type, ref_order_id,
         original_amount, remaining_amount, earned_at, expire_at, created_at, updated_at)
      SELECT ${userId}, i.id, '到店赠送', NULL,
             i.amount, i.amount, i.created_at,
             i.created_at + INTERVAL '365 days', NOW(), NOW()
        FROM inserted i
    )
    UPDATE client_wechat_users
       SET points_balance = COALESCE(points_balance, 0) + (SELECT amount FROM inserted),
           points_updated_at = ${now}
     WHERE user_id = ${userId}
       AND EXISTS (SELECT 1 FROM inserted)
    RETURNING points_balance
  `)) as unknown as Array<{ points_balance: number | string }>

  return {
    granted: result.length > 0,
    skipped: result.length > 0 ? null : 'duplicate',
    amount,
    externalRef,
  }
}

async function insertVisitPointsFailure(
  executor: SqlExecutor,
  snapshot: VisitPointsServiceSnapshot,
  source: string,
  detail: VisitPointsFailureDetail,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO operation_logs
      (action, target_type, target_id, detail, source, created_at)
    VALUES (
      'points.visitGrantFailed',
      'service_order',
      ${snapshot.serviceOrderId},
      ${JSON.stringify(detail)}::jsonb,
      ${source},
      NOW()
    )
  `)
}

export async function grantVisitPointsSafe(
  tx: AdminTx,
  snapshot: VisitPointsServiceSnapshot,
  source: string,
  now: Date = new Date(),
): Promise<VisitPointsResult> {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false' || !isVisitPointsEligible(snapshot)) {
    return { granted: false, skipped: 'ineligible-or-disabled' }
  }

  const userId = snapshot.clientUserId as string
  const serviceDate = normalizeServiceDate(snapshot.serviceDate)
  const externalRef = buildVisitPointsExternalRef(userId, serviceDate)
  let rewardAmount = DEFAULT_VISIT_POINTS_REWARD

  try {
    return await tx.transaction(async (sp) => {
      rewardAmount = await loadVisitPointsReward(sp)
      return grantVisitPointsEntry(sp, userId, serviceDate, rewardAmount, now)
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const detail: VisitPointsFailureDetail = {
      rewardAmount,
      externalRef,
      userId,
      serviceDate,
      error: error.slice(0, 500),
    }
    try {
      await tx.transaction(async (sp) => insertVisitPointsFailure(sp, snapshot, source, detail))
    } catch (logErr) {
      console.error('[visit-points] failure log failed:', logErr)
    }
    return { granted: false, skipped: 'failed', amount: rewardAmount, externalRef, error }
  }
}

export async function markVisitPointsFailureRecovered(
  executor: SqlExecutor,
  failureLogId: number,
  serviceOrderId: string,
  result: VisitPointsResult,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO operation_logs
      (action, target_type, target_id, detail, source, created_at)
    VALUES (
      'points.visitGrantRecovered',
      'service_order',
      ${serviceOrderId},
      ${JSON.stringify({
        failureLogId,
        externalRef: result.externalRef,
        outcome: result.granted ? 'granted' : result.skipped,
      })}::jsonb,
      'cronTask',
      NOW()
    )
  `)
}
