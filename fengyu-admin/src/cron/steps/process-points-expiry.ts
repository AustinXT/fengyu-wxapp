/**
 * STEP — 积分批次过期与到期提醒
 *
 * 口径：
 *   - 每次正向获得积分生成独立批次，有效期 365 天。
 *   - 到期批次自动扣减 remaining_amount，并写 point_transactions(type='过期扣减')。
 *   - 到期前 60/30/7 天按顾客聚合生成站内消息，幂等键防重跑重复提醒。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { type CronContext, nowSqlOf } from '../lib/cron-context'

const REMINDER_DAYS = [60, 30, 7] as const

export interface PointsExpiryResult {
  expiredBatches: number
  expiredPoints: number
  expiredUsers: number
  reminderMessages: number
  remindersByDays: Record<number, number>
}

export async function processPointsExpiry(
  db: Db,
  ctx?: CronContext,
): Promise<PointsExpiryResult> {
  const expired = await expirePointBatches(db, ctx)
  const remindersByDays: Record<number, number> = {}
  let reminderMessages = 0

  for (const days of REMINDER_DAYS) {
    const count = await sendExpiryReminders(db, days, ctx)
    remindersByDays[days] = count
    reminderMessages += count
  }

  return {
    ...expired,
    reminderMessages,
    remindersByDays,
  }
}

async function expirePointBatches(
  db: Db,
  ctx?: CronContext,
): Promise<Pick<PointsExpiryResult, 'expiredBatches' | 'expiredPoints' | 'expiredUsers'>> {
  const nowSql = nowSqlOf(ctx)
  const rows = (await db.execute(sql`
    WITH due AS MATERIALIZED (
      SELECT id, user_id, remaining_amount
      FROM point_batches
      WHERE remaining_amount > 0
        AND expire_at <= ${nowSql}
      FOR UPDATE
    ),
    inserted_txns AS (
      INSERT INTO point_transactions
        (user_id, type, amount, ref_order_id, external_ref, created_at)
      SELECT
        user_id,
        '过期扣减',
        -remaining_amount,
        NULL,
        'points-expire-' || id::text,
        ${nowSql}
      FROM due
      ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
      RETURNING id
    ),
    updated_batches AS (
      UPDATE point_batches pb
         SET remaining_amount = 0,
             expired_at = ${nowSql},
             updated_at = ${nowSql}
        FROM due
       WHERE pb.id = due.id
      RETURNING pb.user_id
    ),
    updated_users AS (
      UPDATE client_wechat_users c
         SET points_balance = COALESCE((
               SELECT SUM(pb.remaining_amount)
               FROM point_batches pb
               WHERE pb.user_id = c.user_id
                 AND pb.expire_at > ${nowSql}
             ), 0),
             points_updated_at = ${nowSql},
             updated_at = NOW()
       WHERE c.user_id IN (SELECT DISTINCT user_id FROM updated_batches)
      RETURNING c.user_id
    )
    SELECT
      (SELECT COUNT(*)::int FROM due) AS expired_batches,
      COALESCE((SELECT SUM(remaining_amount) FROM due), 0)::int AS expired_points,
      (SELECT COUNT(*)::int FROM updated_users) AS expired_users
  `)) as Array<{
    expired_batches: number | string
    expired_points: number | string
    expired_users: number | string
  }>

  const row = rows[0]
  return {
    expiredBatches: Number(row?.expired_batches ?? 0),
    expiredPoints: Number(row?.expired_points ?? 0),
    expiredUsers: Number(row?.expired_users ?? 0),
  }
}

async function sendExpiryReminders(
  db: Db,
  daysBefore: number,
  ctx?: CronContext,
): Promise<number> {
  const nowSql = nowSqlOf(ctx)
  const rows = (await db.execute(sql`
    WITH target AS (
      SELECT (((${nowSql}) AT TIME ZONE 'Asia/Shanghai')::date + (${daysBefore}::int * INTERVAL '1 day'))::date AS target_date
    ),
    expiring AS (
      SELECT
        pb.user_id,
        target.target_date,
        COALESCE(SUM(pb.remaining_amount), 0)::bigint AS expiring_points
      FROM point_batches pb
      CROSS JOIN target
      WHERE pb.remaining_amount > 0
        AND (pb.expire_at AT TIME ZONE 'Asia/Shanghai')::date = target.target_date
      GROUP BY pb.user_id, target.target_date
      HAVING COALESCE(SUM(pb.remaining_amount), 0) > 0
    )
    INSERT INTO messages (
      recipient_type,
      recipient_id,
      title,
      body,
      message_type,
      ref_entity_type,
      ref_entity_id,
      idempotency_key,
      created_at
    )
    SELECT
      '客户',
      user_id,
      '积分即将过期提醒',
      '您有 ' || expiring_points::text || ' 积分将在 ' || target_date::text || ' 到期，请及时使用。',
      'points',
      'point_expiry',
      target_date::text,
      'points-expiry-reminder-' || ${daysBefore}::text || '-' || target_date::text || '-' || user_id,
      ${nowSql}
    FROM expiring
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id
  `)) as Array<{ id: number }>

  return rows.length
}
