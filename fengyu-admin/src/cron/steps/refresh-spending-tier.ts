

import { sql } from 'drizzle-orm'
import type { Db } from '../run'

export const UPDATE_SPENDING_TIER_SQL = `
WITH spend AS (
  SELECT u.user_id,
         COALESCE(SUM(GREATEST((o.received::numeric) - (o.refunded_amount::numeric), 0)) FILTER (
                    WHERE o.sale_order_type IN ('销售单', '转换单')
                  ), 0) AS total
    FROM client_wechat_users u
    LEFT JOIN sale_orders o
      ON o.client_user_id = u.user_id
   GROUP BY u.user_id
),
tiered AS (
  SELECT user_id,
         (CASE
            WHEN total >= 100000 THEN '10W+'
            WHEN total >= 60000  THEN '6-10W'
            WHEN total >= 30000  THEN '3-6W'
            WHEN total >= 10000  THEN '1-3W'
            WHEN total >= 1990   THEN '1990-1W'
            ELSE '<1990'
          END)::spending_tier AS tier
    FROM spend
)
UPDATE client_wechat_users u
   SET spending_tier = t.tier,
       updated_at = NOW()
  FROM tiered t
 WHERE u.user_id = t.user_id
   AND u.spending_tier IS DISTINCT FROM t.tier
`

export interface SpendingTierResult {
  updated: number
  stats: Array<{ spending_tier: string | null; cnt: number }>
}

export async function refreshSpendingTier(db: Db): Promise<SpendingTierResult> {
  return await db.transaction(async (tx) => {
    const updated = (await tx.execute(sql.raw(UPDATE_SPENDING_TIER_SQL))) as unknown as {
      count?: number
    }

    const stats = (await tx.execute(sql`
      SELECT spending_tier, COUNT(*)::int AS cnt
      FROM client_wechat_users
      GROUP BY spending_tier
      ORDER BY spending_tier
    `)) as Array<{ spending_tier: string | null; cnt: number }>

    return {
      updated: updated.count ?? 0,
      stats,
    }
  })
}
