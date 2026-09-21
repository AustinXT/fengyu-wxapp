/**
 * STEP 1 — customer_status 重算（迁自 cronTask/index.js:34-86）
 *
 * 业务口径：customer_status 仅对 customer_type='会员客' 的顾客有值，
 * 非会员客（流量客 / 体验客 / 小美客）一律 NULL。
 *
 * 三段 SQL 在同一事务中串行，三段的覆盖域必须并起来等于全表（#254 曾漏一类行）：
 *   段 1：非会员客一律置 NULL（清理脏数据）
 *   段 2：会员客有到店记录的，按 visits_90d / total_visits 打状态
 *   段 3：会员客但完全无到店记录的，置 '休眠'（含已有旧值的 —— 见 RESET_NO_VISITS_SQL 注释）
 *
 * 与原 cronTask 的事务边界一致：整体一个 db.transaction，任一段失败 → 全段回滚。
 *
 * SQL 常量 export 出来以便测试做正则形态断言（与原 cronTask __test__ 导出对齐）。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { type CronContext, dateSqlOf } from '../lib/cron-context'

export const RESET_NON_MEMBER_STATUS_SQL = `
UPDATE client_wechat_users
   SET customer_status = NULL, updated_at = NOW()
 WHERE customer_status IS NOT NULL
   AND customer_type != '会员客'
`

/**
 * 段 2 SQL：含 CURRENT_DATE 时间引用。
 * ctx=undefined 时与原 raw SQL 等价（生产路径 + Vitest 形态断言）。
 */
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

/**
 * 段 3 SQL：会员客 ∧ 无已完成服务单 → '休眠'。
 *
 * ⚠️ 守卫必须是 `IS DISTINCT FROM '休眠'` 而非 `IS NULL`（#254）：
 * `NOT EXISTS(已完成服务单)` 与段 2 的 `visit_stats` join 互为补集（visit_stats 正由
 * `status='已完成'` 分组而来），「只补段 2 没分到的」这一意图已由它完整表达。再叠一个
 * `IS NULL` 就把「段 2 没分到 **且** 已有旧值」误判成不需要处理 —— 顾客原有已完成服务单
 * （状态已写入），后来服务单被撤销/删除/改状态而掉出 visit_stats 时，三段全不匹配，
 * 旧状态永久卡住、cron 跑多少次都不自愈（prod 2026-09-22 实际命中 2 行）。
 *
 * 改用 `IS DISTINCT FROM` 既消除缺口（NULL 行仍命中），又保留「已是休眠就不重写
 * updated_at」的原意，与 refresh-spending-tier.ts 的范式一致。
 */
export const RESET_NO_VISITS_SQL = `
UPDATE client_wechat_users u
   SET customer_status = '休眠'::customer_status, updated_at = NOW()
 WHERE u.customer_type = '会员客'
   AND u.customer_status IS DISTINCT FROM '休眠'::customer_status
   AND NOT EXISTS (
     SELECT 1 FROM service_orders so
      WHERE so.client_user_id = u.user_id AND so.status = '已完成'
   )
`

/**
 * 动态构造段 2 SQL：将 raw 中的 `CURRENT_DATE` 替换为 ctx.referenceDate 注入的字面量。
 * 仅替换 `CURRENT_DATE` 三处（90 days / 6 months / 12 months 各 1），不影响 `NOW()`（updated_at 仍真实时间）。
 */
function buildUpdateCustomerStatusSql(ctx?: CronContext): string {
  if (!ctx?.referenceDate) return UPDATE_CUSTOMER_STATUS_SQL
  const dateStr = formatYmd(ctx.referenceDate)
  // 用字面量替换（参数化此处复杂度高且 PG 不缓存查询计划差异）
  return UPDATE_CUSTOMER_STATUS_SQL.replace(/CURRENT_DATE/g, `('${dateStr}'::date)`)
}

function formatYmd(d: Date): string {
  // Asia/Shanghai 日历日期（与 PG CURRENT_DATE 在 +0800 时区一致）
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
  // dateSqlOf 仅用于 stats 聚合处（无需），段 1/3 无时间引用，段 2 用 buildUpdateCustomerStatusSql
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
