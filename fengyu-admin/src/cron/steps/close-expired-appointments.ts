/**
 * STEP 8 — 关闭超期未到店的预约（D-Q4-2026-04-26 / audit-06 P0-06-04）
 *
 * 决议：每日凌晨扫描"预约日期已过且未签到"的预约，置为 '已关闭'。
 * 顾客取消走 '已取消' 路径；'已完成' 走核销流程；本 STEP 仅清扫"约了不来"的尾巴。
 *
 * 状态流转（参考 db/schema/appointment.ts）：
 *   待确认/已确认 → 已关闭（预约日期已过且未签到，次日凌晨 03:00 扫描）
 *
 * 业务口径：
 *   - 仅关闭 status IN ('待确认','已确认') 且 checkin_at IS NULL（未签到）
 *     且 appointment_time < date_trunc('day', NOW())（预约日期早于今天）
 *   - 按"预约日期"判定而非"满 24 小时"：cron 在 03:00 跑，预约日期次日必被扫到，
 *     精确对齐"未在指定日期签到则次日 3 点作废"的产品口径
 *   - checkin_at IS NULL：已签到的预约不关闭（已到店，由核销流程流转为 '已完成'）
 *   - '待确认' 也纳入：员工没确认 + 顾客没到 = 同样应关闭（避免无穷"待确认"积压；其从无 checkin）
 *   - 不发短信 / 不写消息：当前未对接短信通道，且超期未到本身不影响顾客权益
 *     （后续如需顾客通知，应在 audit-06 单独 ticket 接入 messages 表）
 *
 * 告警：仅在关闭行数 > 0 时写 operation_logs（非异常情况，正常归档）。
 *   不调 notifyOps —— 这是常规清扫，不是数据完整性告警。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { type CronContext, nowSqlOf, dateStampOf } from '../lib/cron-context'

export interface CloseExpiredAppointmentsResult {
  closed: number
  ids: string[]
}

const ID_LOG_LIMIT = 100

export async function closeExpiredAppointments(
  db: Db,
  ctx?: CronContext,
): Promise<CloseExpiredAppointmentsResult> {
  const nowSql = nowSqlOf(ctx)
  const rows = (await db.execute(sql`
    UPDATE appointments
       SET status = '已关闭',
           updated_at = ${nowSql}
     WHERE status IN ('待确认', '已确认')
       AND checkin_at IS NULL
       AND appointment_time < date_trunc('day', ${nowSql})
    RETURNING appointment_id
  `)) as Array<{ appointment_id: string }>

  const ids = rows.map((r) => r.appointment_id)

  if (ids.length > 0) {
    const detail = JSON.stringify({
      _v: 1,
      _t: 'close_expired',
      count: ids.length,
      ids: ids.slice(0, ID_LOG_LIMIT),
    })
    // operation_logs.target_type 用 'appointment'（与原 admin appointment action 日志一致），
    // target_id 写当日日期戳（便于按日期检索"今日批处理"）；逐条写 N 行成本过高，聚合一行。
    const dateStamp = dateStampOf(ctx)
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.close_expired_appointments', 'appointment', ${dateStamp}, ${detail}::jsonb, 'cronTask', ${nowSql})
    `)
  }

  return { closed: ids.length, ids }
}
