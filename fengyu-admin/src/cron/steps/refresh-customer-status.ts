

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { type CronContext, dateSqlOf } from '../lib/cron-context'

export const RESET_NON_MEMBER_STATUS_SQL = `
UPDATE client_wechat_users
   SET customer_status = NULL, updated_at = NOW()
 WHERE customer_status IS NOT NULL
   AND customer_type != '会员客'
`


export const UPDATE_CUSTOMER_STATUS_SQL = `
WITH visit_stats AS (
  SELECT so.client_user_id,
         MAX(so.service_date) AS last_service_date,
         COUNT(DISTINCT so.service_date) AS total_visits,
         COUNT(DISTINCT so.service_date) FILTER (
           WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days'
         ) AS visits_90d
  FROM service_orders so
  WHERE so.status = '已完成' AND so.client_user_id IS NOT NULL
  GROUP BY so.client_user_id
)
UPDATE client_wechat_users u
   SET customer_status = CASE
         WHEN vs.visits_90d >= 1 AND vs.total_visits >= 6 THEN '保有会员-稳定'::customer_status
         WHEN vs.visits_90d >= 1 AND vs.total_visits <= 5 THEN '保有会员-有效'::customer_status
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '6 months' THEN '沉睡'::customer_status
         WHEN vs.last_service_date >= CURRENT_DATE - INTERVAL '12 months' THEN '冰冻'::customer_status
         ELSE '休眠'::customer_status
       END,
       updated_at = NOW()
  FROM visit_stats vs
 WHERE u.user_id = vs.client_user_id
   AND u.customer_type = '会员客'
`

export const RESET_NO_VISITS_SQL = `
UPDATE client_wechat_users u
   SET customer_status = '休眠'::customer_status, updated_at = NOW()
 WHERE u.customer_type = '会员客'
   AND u.customer_status IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM service_orders so
      WHERE so.client_user_id = u.user_id AND so.status = '已完成'
   )
`


function buildUpdateCustomerStatusSql(ctx?: CronContext): string {
  if (!ctx?.referenceDate) return UPDATE_CUSTOMER_STATUS_SQL
  const dateStr = formatYmd(ctx.referenceDate)
  
  return UPDATE_CUSTOMER_STATUS_SQL.replace(/CURRENT_DATE/g, `('${dateStr}'::date)`)
}

function formatYmd(d: Date): string {
  
  const shanghaiMs = d.getTime() + 8 * 60 * 60 * 1000
  return new Date(shanghaiMs).toISOString().slice(0, 10)
}

export interface CustomerStatusResult {
  clearedNonMember: number
  updatedMember: number
  resetNoVisit: number
  stats: Array<{ customer_status: string | null; cnt: number }>
}

export async function refreshCustomerStatus(
  db: Db,
  ctx?: CronContext,
): Promise<CustomerStatusResult> {
  
  void dateSqlOf
  const updateSql = buildUpdateCustomerStatusSql(ctx)

  return await db.transaction(async (tx) => {
    const cleared = (await tx.execute(sql.raw(RESET_NON_MEMBER_STATUS_SQL))) as unknown as {
      count?: number
    }
    const updated = (await tx.execute(sql.raw(updateSql))) as unknown as {
      count?: number
    }
    const reset = (await tx.execute(sql.raw(RESET_NO_VISITS_SQL))) as unknown as { count?: number }

    const stats = (await tx.execute(sql`
      SELECT customer_status, COUNT(*)::int AS cnt
      FROM client_wechat_users
      GROUP BY customer_status
      ORDER BY customer_status
    `)) as Array<{ customer_status: string | null; cnt: number }>

    return {
      clearedNonMember: cleared.count ?? 0,
      updatedMember: updated.count ?? 0,
      resetNoVisit: reset.count ?? 0,
      stats,
    }
  })
}
