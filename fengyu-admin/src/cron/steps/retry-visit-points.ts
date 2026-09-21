/**
 * 重试会员到店积分失败事件。
 *
 * 仅消费三端 finalize 写入的 points.visitGrantFailed；不会扫描已完成服务单，
 * 因而不会给上线前历史记录补发。external_ref 唯一索引保证重复 cron/并发重试幂等。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import {
  buildVisitPointsExternalRef,
  grantVisitPointsEntry,
  loadVisitPointsReward,
  markVisitPointsFailureRecovered,
  normalizeServiceDate,
  type VisitPointsFailureDetail,
} from '@/lib/visit-points'

const RETRY_BATCH_SIZE = 100

/**
 * 补发流水的时间锚点 = **原服务日**的北京零点（业务口径，2026-09-22 拍板）。
 *
 * 此前这里传 `new Date()`，流水会落在补发当天：顾客积分明细里 8 月的到店会显示成 9 月到账，
 * 365 天有效期也跟着顺延。因为 admin 侧发放自 2026-08-14 起 100% 失败（#253），
 * 这条路径从未成功执行过，所以改成按服务日回填不影响任何已落库数据。
 *
 * 取零点而非某个"像样"的时点，是为了不编造并不知道的钟点；`serviceDate` 已由
 * `parseFailureDetail` 校验过 `YYYY-MM-DD` 形态，显式带 `+08:00` 偏移，与进程 TZ 解耦。
 * 幂等仍由 `external_ref`（含 serviceDate）保证，与锚点取值无关。
 */
function serviceDateAnchor(serviceDate: string): Date {
  return new Date(`${serviceDate}T00:00:00+08:00`)
}

interface FailedVisitPointsRow {
  id: number | string
  target_id: string
  detail: VisitPointsFailureDetail | string | null
}

export interface RetryVisitPointsResult {
  candidateCount: number
  recoveredCount: number
  errorCount: number
  paused: boolean
}

function parseFailureDetail(value: FailedVisitPointsRow['detail']): VisitPointsFailureDetail | null {
  try {
    const detail = typeof value === 'string' ? JSON.parse(value) : value
    if (!detail || typeof detail !== 'object') return null
    const rewardAmount = Number(detail.rewardAmount)
    const userId = String(detail.userId || '')
    const serviceDate = normalizeServiceDate(detail.serviceDate)
    if (!Number.isSafeInteger(rewardAmount) || rewardAmount <= 0 || !userId || !serviceDate) return null
    return {
      rewardAmount,
      userId,
      serviceDate,
      externalRef: buildVisitPointsExternalRef(userId, serviceDate),
      error: typeof detail.error === 'string' ? detail.error : undefined,
    }
  } catch {
    return null
  }
}

export async function retryVisitPoints(db: Db): Promise<RetryVisitPointsResult> {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false') {
    return { candidateCount: 0, recoveredCount: 0, errorCount: 0, paused: true }
  }

  const configuredAmount = await loadVisitPointsReward(db)
  if (configuredAmount <= 0) {
    return { candidateCount: 0, recoveredCount: 0, errorCount: 0, paused: true }
  }

  const failures = (await db.execute(sql`
    SELECT f.id, f.target_id, f.detail
      FROM operation_logs f
     WHERE f.action = 'points.visitGrantFailed'
       AND f.target_type = 'service_order'
       AND NOT EXISTS (
         SELECT 1
           FROM operation_logs r
          WHERE r.action = 'points.visitGrantRecovered'
            AND r.detail->>'failureLogId' = f.id::text
       )
     ORDER BY f.created_at, f.id
     LIMIT ${RETRY_BATCH_SIZE}
  `)) as unknown as FailedVisitPointsRow[]

  let recoveredCount = 0
  let errorCount = 0

  for (const failure of failures) {
    const detail = parseFailureDetail(failure.detail)
    if (!detail) {
      errorCount++
      continue
    }

    try {
      await db.transaction(async (tx) => {
        const result = await grantVisitPointsEntry(
          tx,
          detail.userId,
          detail.serviceDate,
          detail.rewardAmount,
          serviceDateAnchor(detail.serviceDate),
        )
        await markVisitPointsFailureRecovered(tx, Number(failure.id), failure.target_id, result)
      })
      recoveredCount++
    } catch (err) {
      errorCount++
      console.error(`[visit-points] retry failed for log ${failure.id}:`, err)
    }
  }

  return {
    candidateCount: failures.length,
    recoveredCount,
    errorCount,
    paused: false,
  }
}
