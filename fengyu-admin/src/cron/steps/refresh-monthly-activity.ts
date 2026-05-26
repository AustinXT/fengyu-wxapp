/**
 * STEP — monthly_activity（月度客活）重算（迁自 db/scripts/calc-monthly-activity.js 客活部分）
 *
 * 业务口径（按「当月到店天数」，service_date 去重，非服务单次数）：
 *   - 二次客活：当月到店 >= 2 天
 *   - 一次客活：当月到店 = 1 天
 *   - 0次客活：会员客当月未到店（仅会员客；非会员未到店一律 NULL）
 *
 * 三段 SQL 在同一事务中串行：
 *   段 1：全表 monthly_activity 置 NULL（清理上月残留；幂等重入）
 *   段 2：当月有到店记录的顾客（含非会员），按去重天数打 二次/一次客活
 *   段 3：会员客当月未到店（段 2 没分到）的，置 0次客活
 *
 * 与 refresh-customer-status 的分工：customer_status 是「历史到店状态」（STEP customerStatus），
 * monthly_activity 是「当月到店活跃度」，两者口径与时间窗口不同，互不重叠。
 *
 * SQL 常量 export 出来以便测试做正则形态断言（与 refresh-customer-status 范式对齐）。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import type { CronContext } from '../lib/cron-context'

export const RESET_MONTHLY_ACTIVITY_SQL = `
UPDATE client_wechat_users
   SET monthly_activity = NULL, updated_at = NOW()
 WHERE monthly_activity IS NOT NULL
`

/**
 * 段 2 SQL：含 CURRENT_DATE 时间引用（当月窗口）。
 * ctx=undefined 时与原 raw SQL 等价（生产路径 + Vitest 形态断言）。
 */
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

/**
 * 动态构造段 2 SQL：把 raw 中的 `CURRENT_DATE` 替换为 ctx.referenceDate 注入的字面量。
 * 仅替换 `CURRENT_DATE`（两处 date_trunc），不影响 `NOW()`（updated_at 仍真实时间）。
 */
function buildUpdateMonthlyActivitySql(ctx?: CronContext): string {
  if (!ctx?.referenceDate) return UPDATE_MONTHLY_ACTIVITY_SQL
  const dateStr = formatYmd(ctx.referenceDate)
  return UPDATE_MONTHLY_ACTIVITY_SQL.replace(/CURRENT_DATE/g, `('${dateStr}'::date)`)
}

function formatYmd(d: Date): string {
  // Asia/Shanghai 日历日期（与 PG CURRENT_DATE 在 +0800 时区一致）
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
