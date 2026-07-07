

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import type { CronContext } from '../lib/cron-context'

export const RESET_MONTHLY_ACTIVITY_SQL = `
UPDATE client_wechat_users
   SET monthly_activity = NULL, updated_at = NOW()
 WHERE monthly_activity IS NOT NULL
`


export const UPDATE_MONTHLY_ACTIVITY_SQL = `
WITH visit_days AS (
  SELECT so.client_user_id,
         COUNT(DISTINCT so.service_date) AS days
    FROM service_orders so
   WHERE so.status = '已完成'
     AND so.client_user_id IS NOT NULL
     AND so.service_date >= date_trunc('month', CURRENT_DATE)::date
     AND so.service_date < (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date
   GROUP BY so.client_user_id
)
UPDATE client_wechat_users u
   SET monthly_activity = (CASE
         WHEN vd.days >= 2 THEN '二次客活'
         ELSE '一次客活'
       END)::monthly_activity,
       updated_at = NOW()
  FROM visit_days vd
 WHERE u.user_id = vd.client_user_id
`

export const SET_ZERO_ACTIVITY_SQL = `
UPDATE client_wechat_users
   SET monthly_activity = '0次客活'::monthly_activity, updated_at = NOW()
 WHERE customer_type = '会员客'
   AND monthly_activity IS NULL
`


function buildUpdateMonthlyActivitySql(ctx?: CronContext): string {
  if (!ctx?.referenceDate) return UPDATE_MONTHLY_ACTIVITY_SQL
  const dateStr = formatYmd(ctx.referenceDate)
  return UPDATE_MONTHLY_ACTIVITY_SQL.replace(/CURRENT_DATE/g, `('${dateStr}'::date)`)
}

function formatYmd(d: Date): string {
  
  const shanghaiMs = d.getTime() + 8 * 60 * 60 * 1000
  return new Date(shanghaiMs).toISOString().slice(0, 10)
}

export interface MonthlyActivityResult {
  cleared: number
  updatedVisited: number
  setZero: number
  stats: Array<{ monthly_activity: string | null; cnt: number }>
}

export async function refreshMonthlyActivity(
  db: Db,
  ctx?: CronContext,
): Promise<MonthlyActivityResult> {
  const updateSql = buildUpdateMonthlyActivitySql(ctx)

  return await db.transaction(async (tx) => {
    const cleared = (await tx.execute(sql.raw(RESET_MONTHLY_ACTIVITY_SQL))) as unknown as {
      count?: number
    }
    const updated = (await tx.execute(sql.raw(updateSql))) as unknown as { count?: number }
    const zero = (await tx.execute(sql.raw(SET_ZERO_ACTIVITY_SQL))) as unknown as { count?: number }

    const stats = (await tx.execute(sql`
      SELECT monthly_activity, COUNT(*)::int AS cnt
      FROM client_wechat_users
      GROUP BY monthly_activity
      ORDER BY monthly_activity
    `)) as Array<{ monthly_activity: string | null; cnt: number }>

    return {
      cleared: cleared.count ?? 0,
      updatedVisited: updated.count ?? 0,
      setZero: zero.count ?? 0,
      stats,
    }
  })
}
