/**
 * STEP 8 — 关闭超期未到店的预约（D-Q4-2026-04-26 / audit-06 P0-06-04）
 *
 * 决议：每日凌晨扫描"已确认且 appointment_time 已超过 1 天"的预约，置为 '已关闭'。
 * 顾客取消走 '已取消' 路径；'已完成' 走核销流程；本 STEP 仅清扫"约了不来"的尾巴。
 *
 * 状态流转（参考 db/schema/appointment.ts）：
 *   待确认/已确认 → 已关闭（超过预约时间一天未到店）
 *
 * 业务口径：
 *   - 仅关闭 status IN ('待确认','已确认') 且 appointment_time < NOW() - INTERVAL '1 day'
 *   - '待确认' 也纳入：员工没确认 + 顾客没到 = 同样应关闭（避免无穷"待确认"积压）
 *   - 不发短信 / 不写消息：当前未对接短信通道，且超期未到本身不影响顾客权益
 *     （后续如需顾客通知，应在 audit-06 单独 ticket 接入 messages 表）
 *
 * 告警：仅在关闭行数 > 0 时写 operation_logs（非异常情况，正常归档）。
 *   不调 notifyOps —— 这是常规清扫，不是数据完整性告警。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'

export interface CloseExpiredAppointmentsResult {
  closed: number
  ids: string[]
}

const ID_LOG_LIMIT = 100

export async function closeExpiredAppointments(db: Db): Promise<CloseExpiredAppointmentsResult> {
  const rows = (await db.execute(sql`
    UPDATE appointments
       SET status = '已关闭',
           updated_at = NOW()
     WHERE status IN ('待确认', '已确认')
       AND appointment_time < NOW() - INTERVAL '1 day'
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
    const dateStamp = new Date().toISOString().slice(0, 10)
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.close_expired_appointments', 'appointment', ${dateStamp}, ${detail}::jsonb, 'cronTask', NOW())
    `)
  }

  return { closed: ids.length, ids }
}
