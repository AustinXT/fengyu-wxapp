/**
 * STEP — spending_tier（历史消费档位）重算（迁自 db/scripts/calc-spending-tier.js）
 *
 * 业务口径：
 *   spending_tier = 顾客**累计（终身）消费额**分档，对所有顾客都有值（默认 '<1990'）。
 *   净额 = SUM(GREATEST(received - refunded_amount, 0))
 *          FILTER (WHERE sale_order_type IN ('销售单','转换单'))。
 *   与 member_level 的区别：spending_tier 是终身累计、**不加时间过滤**（故 WorkFine 同步的
 *   历史已完成单 paid_at=NULL 也计入），member_level 限滚动 12 个月。因此本 STEP 不依赖
 *   CURRENT_DATE/ctx 时间注入。
 *
 *   分档阈值（与 member_level 5 档数值一致，多一个 1990 下界）：
 *     >= 100000 → '10W+'，>= 60000 → '6-10W'，>= 30000 → '3-6W'，
 *     >= 10000 → '1-3W'，>= 1990 → '1990-1W'，其余 → '<1990'。
 *
 * 幂等、可重入：仅更新档位发生变化的行（IS DISTINCT FROM），避免无谓 updated_at churn。
 * SQL 常量 export 以便测试做正则形态断言。
 */

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
