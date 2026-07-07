

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
    
    
    const dateStamp = dateStampOf(ctx)
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.close_expired_appointments', 'appointment', ${dateStamp}, ${detail}::jsonb, 'cronTask', ${nowSql})
    `)
  }

  return { closed: ids.length, ids }
}
