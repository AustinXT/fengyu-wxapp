/**
 * 重试会员到店积分失败事件。
 *
 * 仅消费三端 finalize 写入的 points.visitGrantFailed；不会扫描已完成服务单，
 * 因而不会给上线前历史记录补发。external_ref 唯一索引保证重复 cron/并发重试幂等。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { nowOf, type CronContext } from '../lib/cron-context'
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
 * 到店积分有效期天数。**必须与 `lib/visit-points.ts` 发放 SQL 里的 `INTERVAL '365 days'`
 * 字面量一致**（那条 SQL 受跨端 snapshot 守护、不能把常量插进去，只能在这里镜像一份）。
 * 由 `__tests__/retry-visit-points.test.ts` 的守护断言防漂移。
 */
const VISIT_POINTS_VALID_DAYS = 365

/**
 * 补发流水的时间锚点 = **原服务日**的北京零点（业务口径，2026-09-22 拍板）。
 *
 * 此前这里传 `new Date()`，流水会落在补发当天：顾客积分明细里 8 月的到店会显示成 9 月到账，
 * 365 天有效期也跟着顺延。因为 admin 侧发放自 2026-08-14 起 100% 失败（#253），
 * 这条路径从未成功执行过，所以改成按服务日回填不影响任何已落库数据。
 *
 * 取零点而非某个"像样"的时点，是为了不编造并不知道的钟点；显式带 `+08:00` 偏移，与进程 TZ 解耦。
 * 幂等仍由 `external_ref`（含 serviceDate）保证，与锚点取值无关。
 *
 * ⚠ 返回 `null` 表示 serviceDate **日历非法**：`normalizeServiceDate` 只校验 `YYYY-MM-DD` 形态，
 * 而 JS 会把 `2026-02-31` 静默归一成 3 月 3 日 —— 那样写进库的日期会与 `external_ref` 里的
 * 幂等键自相矛盾。这里用 `Date.UTC` 回读做纯日历校验（不掺时区，也不依赖
 * `normalizeServiceDate`，后者是跨端副本函数）。数据源是失败日志的 JSON detail
 * （不是 PG `date` 列），所以脏值在理论上可达。
 */
function serviceDateAnchor(serviceDate: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(serviceDate)
  if (!parts) return null
  const [, y, mo, d] = parts.map(Number)
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null
  }
  const anchor = new Date(`${serviceDate}T00:00:00+08:00`)
  return Number.isNaN(anchor.getTime()) ? null : anchor
}

interface FailedVisitPointsRow {
  id: number | string
  target_id: string
  detail: VisitPointsFailureDetail | string | null
}

export interface RetryVisitPointsResult {
  candidateCount: number
  recoveredCount: number
  /** 服务日已超出有效期、判定为不补发并摘出队列的条数（详见循环体注释）。 */
  expiredCount: number
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

export async function retryVisitPoints(
  db: Db,
  // ⚠ 必须吃 ctx：前一个 STEP `pointsExpiry` 用的是注入时刻（CRON_REFERENCE_DATE），
  // 本步若拿宿主机 `Date.now()` 判有效期，两步在演练/CI 下会对同一批数据得出相反结论 ——
  // 参考日期下已过期的却被补发，或反过来被提前写成 expired。生产不设该 env，nowOf 退化为 new Date()。
  ctx?: CronContext,
): Promise<RetryVisitPointsResult> {
  if (process.env.POINTS_ACCRUAL_ENABLED === 'false') {
    return { candidateCount: 0, recoveredCount: 0, expiredCount: 0, errorCount: 0, paused: true }
  }

  const now = nowOf(ctx)
  const configuredAmount = await loadVisitPointsReward(db)
  if (configuredAmount <= 0) {
    return { candidateCount: 0, recoveredCount: 0, expiredCount: 0, errorCount: 0, paused: true }
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
  let expiredCount = 0
  let errorCount = 0

  for (const failure of failures) {
    const detail = parseFailureDetail(failure.detail)
    const anchor = detail ? serviceDateAnchor(detail.serviceDate) : null
    if (!detail || !anchor) {
      // 这两类都不会自愈（detail 解析不出 / serviceDate 日历非法），每轮都会被重新扫到。
      // 目前**故意不写 tombstone**：脏值一旦被人工修好就该恢复补发，不该永久摘除。
      // 代价是它们会一直占候选名额，攒到 RETRY_BATCH_SIZE 就会饿死队列 —— 所以必须打日志，
      // 让 errorCount 可归因（跟进见 #253 的 follow-up）。
      errorCount++
      console.error(
        `[visit-points] retry skipped log ${failure.id}:`,
        detail ? `invalid serviceDate ${detail.serviceDate}` : 'unparsable detail',
      )
      continue
    }

    // 按服务日回填带来的新边界：服务日已超过有效期时，补发出来的批次 expire_at 落在过去，
    // 而 points_balance 照加 —— 当轮 cron 的过期处理（STEP 顺序在本步之前）已经错过它，
    // 紧接着的积分审计就会报 `points_balance > Σ 未过期批次`（I2/I3 被撕开），
    // 且顾客拿到的是一笔当场就不可用的积分。这类候选直接判定为"已过期、不补发"，
    // 写一条 outcome='expired' 的处理记录把它从待重试集合里摘掉（否则每轮重扫，
    // 积压到 RETRY_BATCH_SIZE 就会把整个队列饿死）。
    if (anchor.getTime() + VISIT_POINTS_VALID_DAYS * 86_400_000 <= now.getTime()) {
      try {
        await db.transaction(async (tx) => {
          await markVisitPointsFailureRecovered(tx, Number(failure.id), failure.target_id, {
            granted: false,
            skipped: 'expired',
            amount: detail.rewardAmount,
            externalRef: detail.externalRef,
          })
        })
        expiredCount++
      } catch (err) {
        errorCount++
        console.error(`[visit-points] mark expired failed for log ${failure.id}:`, err)
      }
      continue
    }

    try {
      await db.transaction(async (tx) => {
        const result = await grantVisitPointsEntry(
          tx,
          detail.userId,
          detail.serviceDate,
          detail.rewardAmount,
          anchor,
          // 余额变更时间恒为**当下**（演练下是注入时刻），不能跟着补发锚点回到历史时刻
          // ——否则按 points_updated_at 做增量同步/对账的下游会漏掉这次真实的余额变更。
          now,
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
    expiredCount,
    errorCount,
    paused: false,
  }
}
