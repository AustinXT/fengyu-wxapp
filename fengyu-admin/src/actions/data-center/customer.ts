'use server'

/**
 * 数据中心 — 客量板块取数 action（getCustomerBoard）
 *
 * 口径权威：notes/references/metrics.md「客量数据子页」全 5 大类
 *   1. 注册情况（截面，截至 endDate）
 *   2. 到店客流（区间）
 *   3. 会员状态与客活（截面 5 档 + 区间客活 2 档 + 本月激活 anchor 反推 3 档）
 *   4. 会员被经营（6 档消费分桶 member_spend CTE + 会员客单价）
 *   5. 新会员经营（成交率 / 客单价）
 *
 * 移植源（纯 JS 原生 SQL，禁止 import，照搬成 Drizzle raw SQL）：
 *   fengyu-staff/cloudfunctions/staffApi/routes/mgmt-traffic.js（summary）
 *
 * 关键口径红线（与 mgmt-traffic.js 字面一致，consistency.customer.test.ts 守护）：
 *   - 新会员/会员数 = became_member_at（历史化）；保有会员 = 90 天到店窗口 + became_member_at 守卫
 *   - 消费分桶 = member_spend CTE 左闭右开 [1990,1w)/[1w,3w)/[3w,6w)/[6w,10w)/[10w,+∞)，
 *     不复用 spending_tier 列（lifetime 快照）；
 *     spend = SUM(sale_order_performance_events.amount) @ performance_date（#138 起，与业绩 KPI 同源；
 *     不按父订单 status 过滤、排除储值卡抵扣；与 mgmt-traffic.js 逐条一致，由 consistency.customer.test.ts 守护）
 *   - 成交率分母 = 期初未达会员的到店活跃池 ∪ 本期全部新增会员（D-conv-denom=1c，#284 推翻原 D-2=B；
 *     ② 分支与分子 newmem/queryNewMemberCount 同源，保证分子 ⊆ 分母、成交率恒 ≤ 100%）
 *   - 项目数 = SUM(session_used) WHERE sales_category IN ('自销自耗','他销自耗')（D-5）
 *   - customer_status 枚举 '沉睡'/'冰冻'/'休眠'（非 '预警沉睡'）
 *   - 客户维度 scope 用 bound_store_id，服务/订单维度用 store_id
 *   - 本月激活 3 档：anchor=startDate-1 实时反推 customer_status（D-react-source=C），
 *     用 last_dt 区间判定（沉睡 last_dt>=anchor-6m / 冰冻 [anchor-12m,anchor-6m) / 休眠 <anchor-12m OR NULL）
 *
 * 性能：6 分桶 + anchor CTE + 多档查询较重。明细表（byMarket/byStore）按 scope 骨架逐组聚合，
 * 不做同比环比。激活/客活依赖 cron 重算的 customer_status，前端加小字提示。
 */

import { db } from '@/db'
import { sql, type SQL } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import { prepareBoardContext } from '@/lib/data-center/context'
import { scopeFilterSql, scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { excludeDepositRefundSql } from '@/lib/data-center/consume-filter'
import { withComparison } from '@/lib/data-center/comparison'
import { resolveDeltaDisplay } from '@/lib/delta-display'
import type { AuthSession } from '@/lib/types'
import type {
  BoardParams,
  BreakdownRow,
  CustomerBoardResult,
  DataCenterScope,
  KpiCell,
  ResolvedRange,
} from '@/lib/data-center/types'

// ── 工具 ──────────────────────────────────────────────────────────────
const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const round2 = (v: unknown): number => Math.round(num(v) * 100) / 100
/** 取数组首行（db.execute 返回数组） */
const first = (rows: unknown): Record<string, unknown> =>
  ((rows as unknown[])[0] as Record<string, unknown>) ?? {}

// =====================================================================
// 单标量 KPI 查询（供 withComparison 跑本期/上期/去年同期）
// =====================================================================

/**
 * 注册情况单项（截面，截至区间 endDate）。
 * 会员客切 became_member_at（精确历史截面，与首页实时 memberCount 用 customer_type 不矛盾——历史报表用成为会员时间才准）；其余 3 档仍 customer_type 当前快照 + created_at 截面。
 */
async function queryRegistration(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  customerType: '流量客' | '体验客' | '会员客' | null,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  if (customerType === '会员客') {
    const rows = await db.execute(sql`
      SELECT COUNT(*) AS v
      FROM client_wechat_users c
      WHERE ${sc}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= ${range.end}
    `)
    return num(first(rows).v)
  }
  const typeClause = customerType ? sql` AND c.customer_type = ${customerType}` : sql``
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS v
    FROM client_wechat_users c
    WHERE ${sc}
      AND c.created_at::date <= ${range.end}${typeClause}
  `)
  return num(first(rows).v)
}

/** 当期到店客流量（行数）/ 对应人数（DISTINCT user）/ 项目数 —— 按 customer_type 过滤 */
async function queryTrafficCount(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  customerType: '体验客' | '小美客' | '会员客' | null,
  metric: 'count' | 'users',
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const typeClause = customerType ? sql` AND c.customer_type = ${customerType}` : sql``
  const expr = metric === 'users' ? sql`COUNT(DISTINCT so.client_user_id)` : sql`COUNT(*)`
  const rows = await db.execute(sql`
    SELECT ${expr} AS v
    FROM service_orders so
    JOIN client_wechat_users c ON c.user_id = so.client_user_id
    WHERE ${sc}
      AND so.status = '已完成'
      AND so.service_date BETWEEN ${range.start} AND ${range.end}${typeClause}
  `)
  return num(first(rows).v)
}

/** 项目数（扣卡次数）：SUM(session_used) WHERE sales_category IN ('自销自耗','他销自耗') */
async function queryProjectCount(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(sit.session_used), 0) AS v
    FROM service_orders so
    JOIN service_items sit ON sit.service_order_id = so.service_order_id
    WHERE ${sc}
      AND so.status = '已完成'
      AND so.service_date BETWEEN ${range.start} AND ${range.end}
      AND sit.sales_category IN ('自销自耗', '他销自耗')
      AND ${excludeDepositRefundSql('so')}
  `)
  return num(first(rows).v)
}

/** 服务人次（service_orders 行数，已完成） */
async function queryServiceCount(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS v
    FROM service_orders so
    WHERE ${sc}
      AND so.status = '已完成'
      AND so.service_date BETWEEN ${range.start} AND ${range.end}
  `)
  return num(first(rows).v)
}

/** 生美实耗（区间）：SUM(unit_real_price * session_used) WHERE is_shengmei，供「单次客耗」分子 */
async function queryShengmeiConsume(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used::numeric), 0) AS v
    FROM service_orders so
    JOIN service_items sit ON sit.service_order_id = so.service_order_id
    WHERE ${sc}
      AND so.status = '已完成'
      AND so.service_date BETWEEN ${range.start} AND ${range.end}
      AND sit.is_shengmei = TRUE
      AND ${excludeDepositRefundSql('so')}
  `)
  return num(first(rows).v)
}

/** 5 档截面状态人数（按 customer_status；沉睡追加 customer_type='会员客'） */
async function queryStatusCount(
  session: AuthSession,
  scope: DataCenterScope,
  status: '保有会员-稳定' | '保有会员-有效' | '沉睡' | '冰冻' | '休眠',
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const memberClause = status === '沉睡' ? sql` AND c.customer_type = '会员客'` : sql``
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS v
    FROM client_wechat_users c
    WHERE ${sc}
      AND c.customer_status = ${status}${memberClause}
  `)
  return num(first(rows).v)
}

/** 一次客活 / 二次客活（区间内到店次数 = 1 或 >= 2，且 customer_status 为保有会员） */
async function queryActive(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  mode: 'once' | 'twice',
): Promise<number> {
  const ssc = scopeFilterSql(session, scope, 'so.store_id')
  const csc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const nClause = mode === 'once' ? sql`vc.n = 1` : sql`vc.n >= 2`
  const rows = await db.execute(sql`
    WITH visit_count AS (
      SELECT so.client_user_id, COUNT(*) AS n
      FROM service_orders so
      WHERE ${ssc}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${range.start} AND ${range.end}
      GROUP BY so.client_user_id
    )
    SELECT COUNT(*) AS v
    FROM visit_count vc
    JOIN client_wechat_users c ON c.user_id = vc.client_user_id
    WHERE ${csc}
      AND c.customer_status IN ('保有会员-稳定', '保有会员-有效')
      AND ${nClause}
  `)
  return num(first(rows).v)
}

/**
 * 本月激活 3 档（anchor = startDate-1 的 customer_status 实时反推，D-react-source=C）。
 *   - warn(沉睡):   last_dt >= anchor - 6 months
 *   - frozen(冰冻): last_dt < anchor - 6 months AND last_dt >= anchor - 12 months
 *   - deep(休眠):   last_dt < anchor - 12 months OR last_dt IS NULL
 * anchor 非保有（visits_90d_prev = 0）+ became_member_at::date <= anchor 守卫；
 * 期内有到店（visited_in_period）即视为本期激活。
 */
async function queryReactivated(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  bucket: 'warn' | 'frozen' | 'deep',
): Promise<number> {
  const ssc = scopeFilterSql(session, scope, 'so.store_id')
  const csc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const start = range.start

  let lastDtClause: SQL
  if (bucket === 'warn') {
    lastDtClause = sql`a.last_dt IS NOT NULL
      AND a.last_dt >= (${start}::date - 1 - INTERVAL '6 months')::date`
  } else if (bucket === 'frozen') {
    lastDtClause = sql`a.last_dt IS NOT NULL
      AND a.last_dt < (${start}::date - 1 - INTERVAL '6 months')::date
      AND a.last_dt >= (${start}::date - 1 - INTERVAL '12 months')::date`
  } else {
    lastDtClause = sql`(a.last_dt IS NULL
      OR a.last_dt < (${start}::date - 1 - INTERVAL '12 months')::date)`
  }

  const rows = await db.execute(sql`
    WITH visited_in_period AS (
      SELECT DISTINCT so.client_user_id
      FROM service_orders so
      WHERE ${ssc}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${start}::date AND ${range.end}
    ),
    anchor_stats AS (
      SELECT
        c.user_id,
        MAX(so.service_date) AS last_dt,
        COUNT(*) FILTER (
          WHERE so.service_date BETWEEN (${start}::date - 1 - INTERVAL '90 days')::date
                                    AND (${start}::date - 1)
        ) AS visits_90d_prev
      FROM client_wechat_users c
      LEFT JOIN service_orders so
        ON so.client_user_id = c.user_id
       AND so.status = '已完成'
       AND so.service_date <= (${start}::date - 1)
      WHERE c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= (${start}::date - 1)
      GROUP BY c.user_id
    )
    SELECT COUNT(*) AS v
    FROM visited_in_period v
    JOIN anchor_stats a ON a.user_id = v.client_user_id
    JOIN client_wechat_users c ON c.user_id = v.client_user_id
    WHERE a.visits_90d_prev = 0
      AND ${lastDtClause}
      AND ${csc}
  `)
  return num(first(rows).v)
}

/**
 * 会员经营人数（区间内**已入账款项净额合计** >= 1990 的会员客去重人数）。
 * ⚠ 不是「单笔订单 >= 1990」——SQL 先 GROUP BY client_user_id 汇总区间内全部款项流水，
 * 再按 1990 分档。#138 起金额口径为款项流水净额（含退款负数），日期按业绩归属日期。
 */
async function queryOperatedMembers(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'o.store_id')
  const rows = await db.execute(sql`
    WITH member_spend AS (
      SELECT o.client_user_id,
             SUM(spe.amount::numeric) AS spend
      FROM sale_order_performance_events spe
      JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE ${sc}
        AND spe.sale_order_type IN ('销售单', '转换单')
        AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
        AND c.customer_type = '会员客'
      GROUP BY o.client_user_id
    )
    SELECT COUNT(*) FILTER (WHERE spend >= 1990) AS v
    FROM member_spend
  `)
  return num(first(rows).v)
}

/** 会员客单价（整个 member_spend：SUM(spend)/COUNT(*)；防除零 → null） */
async function queryMemberAvgTicket(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number | null> {
  const sc = scopeFilterSql(session, scope, 'o.store_id')
  const rows = await db.execute(sql`
    WITH member_spend AS (
      SELECT o.client_user_id,
             SUM(spe.amount::numeric) AS spend
      FROM sale_order_performance_events spe
      JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE ${sc}
        AND spe.sale_order_type IN ('销售单', '转换单')
        AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
        AND c.customer_type = '会员客'
      GROUP BY o.client_user_id
    )
    SELECT COALESCE(SUM(spend), 0) AS total_spend, COUNT(*) AS total_count
    FROM member_spend
  `)
  const r = first(rows)
  const cnt = num(r.total_count)
  return cnt > 0 ? round2(num(r.total_spend) / cnt) : null
}

/** 新增会员数（became_member_at 落在区间内） */
async function queryNewMemberCount(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS v
    FROM client_wechat_users c
    WHERE ${sc}
      AND c.became_member_at IS NOT NULL
      AND c.became_member_at::date BETWEEN ${range.start} AND ${range.end}
  `)
  return num(first(rows).v)
}

/** 新增会员对应消费（这群人区间内全部销售消费，D-newMemberSpend=A） */
async function queryNewMemberSpend(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'o.store_id')
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
    FROM sale_order_performance_events spe
    JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
    JOIN client_wechat_users c ON c.user_id = o.client_user_id
    WHERE ${sc}
      AND c.became_member_at IS NOT NULL
      AND c.became_member_at::date BETWEEN ${range.start} AND ${range.end}
      AND spe.sale_order_type IN ('销售单', '转换单')
      AND spe.status = '已支付'
      AND spe.change_type IN ('首次支付', '回款', '退款')
      AND spe.legacy_source IS DISTINCT FROM 'workfine'
      AND spe.performance_date BETWEEN ${range.start} AND ${range.end}
  `)
  return num(first(rows).v)
}

/**
 * 当月流量客人数（成交率分母）= 期初未达会员的到店活跃池 ∪ 本期全部新增会员
 * （D-conv-denom=1c，#284 于 2026-09-22 拍板；推翻原 D-2=B）
 *
 * 为什么不能只用 `customer_type IN ('体验客','小美客')`：该字段是**只升不降的当前快照**
 * （升级链 流量客 → 体验客 → 小美客 → 会员客），本期成功转化的人当期已是「会员客」，
 * 被从分母整体剔除 —— **而他们正是分子**。实测集团 2026-09 有 141 人被抹掉，
 * 35 家有新会员的门店全部虚高，单店可出 800%，分母归零时前端显示 '--'。
 *
 * 分支 ② 不是锦上添花：151 名本期新增会员中有 10 人本期没有任何已完成服务单，
 * 只有把他们 UNION 进分母，才能让**分子成为分母的真子集**，成交率上限 ≤ 100% 恒成立
 * （纯活跃池方案 1a 做不到，故被否决）。
 *
 * 两分支 scope 列不同是有意的：① 按服务发生门店（`so.store_id`）、② 按顾客绑定门店
 * （`c.bound_store_id`，与分子 `queryNewMemberCount` 逐字同源，子集关系靠这个对齐）。
 */
async function queryTrialFootfall(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const scVisit = scopeFilterSql(session, scope, 'so.store_id')
  const scMember = scopeFilterSql(session, scope, 'c.bound_store_id')
  const rows = await db.execute(sql`
    SELECT COUNT(DISTINCT t.uid) AS v
    FROM (
      -- ① 本期到店 且 期初未达会员（当前仍未达会员 OR 本期内才转化）
      SELECT so.client_user_id AS uid
      FROM service_orders so
      JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE ${scVisit}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${range.start} AND ${range.end}
        AND (
          c.customer_type IN ('体验客', '小美客')
          OR c.became_member_at::date BETWEEN ${range.start} AND ${range.end}
        )
      UNION
      -- ② 本期全部新增会员（兜住本期无已完成服务单者，保证分子 ⊆ 分母）
      SELECT c.user_id AS uid
      FROM client_wechat_users c
      WHERE ${scMember}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date BETWEEN ${range.start} AND ${range.end}
    ) t
  `)
  return num(first(rows).v)
}

/** 有效保有会员（90 天到店窗口 + became_member_at 守卫，截至 range.end，与首页 retainedMemberCount 同口径） */
async function queryRetainedMembers(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'c.bound_store_id')
  const rows = await db.execute(sql`
    SELECT COUNT(DISTINCT so.client_user_id) AS v
    FROM service_orders so
    JOIN client_wechat_users c ON c.user_id = so.client_user_id
    WHERE ${sc}
      AND so.status = '已完成'
      AND so.client_user_id IS NOT NULL
      AND so.service_date BETWEEN (${range.end}::date - INTERVAL '90 days')::date AND ${range.end}
      AND c.became_member_at IS NOT NULL
      AND c.became_member_at::date <= ${range.end}
  `)
  return num(first(rows).v)
}

// =====================================================================
// 明细表（byMarket / byStore）：scope 骨架逐组聚合，不做同比环比
// =====================================================================

/** 注册客活组（一组 = 一行 BreakdownRow.metrics 的注册/客活相关列） */
interface RegActiveAgg {
  registered: number
  retained: number
  visitOnce: number
  visitTwice: number
  dormant: number
  reactivatedDormant: number
  frozen: number
  reactivatedFrozen: number
  deep: number
  reactivatedDeep: number
}

/** 消费分桶 + 经营组 */
interface OpsAgg {
  bucketD: number
  bucketC: number
  bucketB: number
  bucketA: number
  bucketV: number
  bucketVIC: number
  operatedTotal: number
  newMembers: number
  trafficCustomers: number
  trafficVisits: number
  memberVisits: number
  projectCount: number
  memberSpendTotal: number // 内部：算 memberAvgTicket
  memberSpendCount: number // 内部：算 memberAvgTicket 分母
  newMemberSpendTotal: number // 内部：算 newCustomerAvgTicket
  shengmeiConsumeTotal: number // 内部：算 consumePerVisit 分子
  serviceCount: number // 内部：服务人次（consumePerVisit 分母）
}

/**
 * 注册客活明细：scope 骨架 LEFT JOIN 各子聚合，按 group_col（市场或门店）GROUP BY。
 * group='market' → 市场维度（骨架 market_id/market_name）；group='store' → 门店维度。
 *
 * 客户维度（registered/retained/dormant/...）按 bound_store_id 归组；
 * 服务维度（visitOnce/visitTwice）按 service_orders 归组（用 c.bound_store_id 与客户一致，避免跨店漂移）。
 * 本月激活 3 档按 anchor 反推 + bound_store_id 归组。
 */
async function queryRegActiveBreakdown(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  group: 'market' | 'store',
): Promise<Map<string, RegActiveAgg>> {
  const skeleton = scopeStoreSkeletonSql(session, scope)
  const groupId = group === 'market' ? sql.raw('sk.market_id') : sql.raw('sk.store_id')
  const start = range.start
  const end = range.end
  const serviceScope = scopeFilterSql(session, scope, 'so.store_id')
  const customerScope = scopeFilterSql(session, scope, 'c.bound_store_id')

  const rows = await db.execute(sql`
    WITH skel AS (${skeleton}),
    -- 注册（会员客口径，became_member_at 截面）按 bound_store_id 归组
    reg AS (
      SELECT c.bound_store_id AS store_id, COUNT(*) AS registered
      FROM client_wechat_users c
      WHERE ${customerScope}
        AND c.bound_store_id IS NOT NULL
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= ${end}
      GROUP BY c.bound_store_id
    ),
    -- 有效保有会员（90 天窗口 + became_member_at 守卫）按 bound_store_id 归组
    ret AS (
      SELECT c.bound_store_id AS store_id, COUNT(DISTINCT so.client_user_id) AS retained
      FROM service_orders so
      JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE ${customerScope}
        AND c.bound_store_id IS NOT NULL
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN (${end}::date - INTERVAL '90 days')::date AND ${end}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= ${end}
      GROUP BY c.bound_store_id
    ),
    -- 区间到店次数（按客户 + bound_store_id），区分一次/二次客活（仅保有会员）
    visit_count AS (
      SELECT so.client_user_id, c.bound_store_id AS store_id, COUNT(*) AS n,
             c.customer_status AS cstatus
      FROM service_orders so
      JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE ${serviceScope}
        AND ${customerScope}
        AND c.bound_store_id IS NOT NULL
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${start} AND ${end}
      GROUP BY so.client_user_id, c.bound_store_id, c.customer_status
    ),
    active AS (
      SELECT store_id,
             COUNT(*) FILTER (WHERE n = 1) AS visit_once,
             COUNT(*) FILTER (WHERE n >= 2) AS visit_twice
      FROM visit_count
      WHERE cstatus IN ('保有会员-稳定', '保有会员-有效')
      GROUP BY store_id
    ),
    -- 5 档截面状态人数（沉睡追加会员客）
    status_agg AS (
      SELECT c.bound_store_id AS store_id,
             COUNT(*) FILTER (WHERE c.customer_status = '沉睡' AND c.customer_type = '会员客') AS dormant,
             COUNT(*) FILTER (WHERE c.customer_status = '冰冻') AS frozen,
             COUNT(*) FILTER (WHERE c.customer_status = '休眠') AS deep
      FROM client_wechat_users c
      WHERE ${customerScope}
        AND c.bound_store_id IS NOT NULL
      GROUP BY c.bound_store_id
    ),
    -- 本月激活 anchor 反推（期内有到店 + anchor 非保有 + anchor 状态分档），按 bound_store_id 归组
    visited_in_period AS (
      SELECT DISTINCT so.client_user_id
      FROM service_orders so
      WHERE ${serviceScope}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ${start}::date AND ${end}
    ),
    anchor_stats AS (
      SELECT
        c.user_id,
        c.bound_store_id AS store_id,
        MAX(so.service_date) AS last_dt,
        COUNT(*) FILTER (
          WHERE so.service_date BETWEEN (${start}::date - 1 - INTERVAL '90 days')::date
                                    AND (${start}::date - 1)
        ) AS visits_90d_prev
      FROM client_wechat_users c
      LEFT JOIN service_orders so
        ON so.client_user_id = c.user_id
       AND so.status = '已完成'
       AND so.service_date <= (${start}::date - 1)
      WHERE ${customerScope}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= (${start}::date - 1)
        AND c.bound_store_id IS NOT NULL
      GROUP BY c.user_id, c.bound_store_id
    ),
    react AS (
      SELECT a.store_id,
        COUNT(*) FILTER (
          WHERE a.last_dt IS NOT NULL
            AND a.last_dt >= (${start}::date - 1 - INTERVAL '6 months')::date
        ) AS react_dormant,
        COUNT(*) FILTER (
          WHERE a.last_dt IS NOT NULL
            AND a.last_dt < (${start}::date - 1 - INTERVAL '6 months')::date
            AND a.last_dt >= (${start}::date - 1 - INTERVAL '12 months')::date
        ) AS react_frozen,
        COUNT(*) FILTER (
          WHERE a.last_dt IS NULL
            OR a.last_dt < (${start}::date - 1 - INTERVAL '12 months')::date
        ) AS react_deep
      FROM anchor_stats a
      JOIN visited_in_period v ON v.client_user_id = a.user_id
      WHERE a.visits_90d_prev = 0
      GROUP BY a.store_id
    )
    SELECT
      ${groupId} AS group_id,
      ${group === 'market' ? sql.raw('MAX(sk.market_name)') : sql.raw('MAX(sk.store_name)')} AS group_name,
      MAX(sk.market_name) AS market_name,
      COALESCE(SUM(reg.registered), 0) AS registered,
      COALESCE(SUM(ret.retained), 0) AS retained,
      COALESCE(SUM(active.visit_once), 0) AS visit_once,
      COALESCE(SUM(active.visit_twice), 0) AS visit_twice,
      COALESCE(SUM(status_agg.dormant), 0) AS dormant,
      COALESCE(SUM(react.react_dormant), 0) AS react_dormant,
      COALESCE(SUM(status_agg.frozen), 0) AS frozen,
      COALESCE(SUM(react.react_frozen), 0) AS react_frozen,
      COALESCE(SUM(status_agg.deep), 0) AS deep,
      COALESCE(SUM(react.react_deep), 0) AS react_deep
    FROM skel sk
    LEFT JOIN reg ON reg.store_id = sk.store_id
    LEFT JOIN ret ON ret.store_id = sk.store_id
    LEFT JOIN active ON active.store_id = sk.store_id
    LEFT JOIN status_agg ON status_agg.store_id = sk.store_id
    LEFT JOIN react ON react.store_id = sk.store_id
    GROUP BY ${groupId}
  `)

  const map = new Map<string, RegActiveAgg>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.group_id ?? '')
    if (!id) continue
    map.set(id, {
      registered: num(r.registered),
      retained: num(r.retained),
      visitOnce: num(r.visit_once),
      visitTwice: num(r.visit_twice),
      dormant: num(r.dormant),
      reactivatedDormant: num(r.react_dormant),
      frozen: num(r.frozen),
      reactivatedFrozen: num(r.react_frozen),
      deep: num(r.deep),
      reactivatedDeep: num(r.react_deep),
    })
  }
  return map
}

/**
 * 消费分桶 + 经营明细：先由 scope 骨架构造市场/门店分组，再在分组内聚合。
 *
 * 市场人数必须在市场内先按 client_user_id 去重：同一顾客跨同市场门店消费时，会员消费
 * 先合并后分桶，流量客也只计一次；跨市场仍分别归属。金额、人次、项目数仍按实际发生门店汇总。
 */
async function queryOpsBreakdown(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  group: 'market' | 'store',
): Promise<Map<string, OpsAgg>> {
  const skeleton = scopeStoreSkeletonSql(session, scope)
  const groupId = group === 'market' ? sql.raw('sk.market_id') : sql.raw('sk.store_id')
  const groupName = group === 'market' ? sql.raw('sk.market_name') : sql.raw('sk.store_name')
  const start = range.start
  const end = range.end

  const rows = await db.execute(sql`
    WITH skel AS (${skeleton}),
    group_skel AS (
      SELECT ${groupId} AS group_id,
             MAX(${groupName}) AS group_name,
             MAX(sk.market_name) AS market_name
      FROM skel sk
      GROUP BY ${groupId}
    ),
    -- 会员消费先按当前市场/门店 + 顾客合并：spend = SUM(已入账款项流水) @ 业绩归属日期（#138）
    member_spend AS (
      SELECT ${groupId} AS group_id, o.client_user_id,
             SUM(spe.amount::numeric) AS spend
      FROM sale_order_performance_events spe
      JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
      JOIN skel sk ON sk.store_id = o.store_id
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE spe.sale_order_type IN ('销售单', '转换单')
        AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN ${start} AND ${end}
        AND c.customer_type = '会员客'
      GROUP BY ${groupId}, o.client_user_id
    ),
    spend_agg AS (
      SELECT group_id,
        COUNT(*) FILTER (WHERE spend < 1990) AS bucket_d,
        COUNT(*) FILTER (WHERE spend >= 1990 AND spend < 10000) AS bucket_c,
        COUNT(*) FILTER (WHERE spend >= 10000 AND spend < 30000) AS bucket_b,
        COUNT(*) FILTER (WHERE spend >= 30000 AND spend < 60000) AS bucket_a,
        COUNT(*) FILTER (WHERE spend >= 60000 AND spend < 100000) AS bucket_v,
        COUNT(*) FILTER (WHERE spend >= 100000) AS bucket_vic,
        COUNT(*) FILTER (WHERE spend >= 1990) AS operated_total,
        COALESCE(SUM(spend), 0) AS member_spend_total,
        COUNT(*) AS member_spend_count
      FROM member_spend
      GROUP BY group_id
    ),
    -- 新增会员数按顾客绑定门店归组（绑定门店唯一，市场内无需二次去重）
    newmem AS (
      SELECT ${groupId} AS group_id, COUNT(*) AS new_members
      FROM client_wechat_users c
      JOIN skel sk ON sk.store_id = c.bound_store_id
      WHERE c.bound_store_id IS NOT NULL
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date BETWEEN ${start} AND ${end}
      GROUP BY ${groupId}
    ),
    -- 新增会员对应消费按实际订单发生门店汇总
    newmem_spend AS (
      SELECT ${groupId} AS group_id,
             COALESCE(SUM(spe.amount::numeric), 0) AS new_spend
      FROM sale_order_performance_events spe
      JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
      JOIN skel sk ON sk.store_id = o.store_id
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE c.became_member_at IS NOT NULL
        AND c.became_member_at::date BETWEEN ${start} AND ${end}
        AND spe.sale_order_type IN ('销售单', '转换单')
        AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN ${start} AND ${end}
      GROUP BY ${groupId}
    ),
    -- 流量客人数（成交率分母，D-conv-denom=1c）：期初未达会员的到店活跃池 ∪ 本期全部新增会员。
    -- 与 KPI 的 queryTrialFootfall 同口径；② 分支的 JOIN 与 newmem（分子）逐字一致，
    -- 组内分子 ⊆ 分母由此成立 —— 明细行的成交率不会再 > 100%，也不会因分母 0 显示 '--'。
    -- 市场内按 uid DISTINCT：同一顾客跨同市场门店到店只计一次。
    traffic_cust AS (
      SELECT group_id, COUNT(DISTINCT uid) AS traffic_customers
      FROM (
        SELECT ${groupId} AS group_id, so.client_user_id AS uid
        FROM service_orders so
        JOIN skel sk ON sk.store_id = so.store_id
        JOIN client_wechat_users c ON c.user_id = so.client_user_id
        WHERE so.status = '已完成'
          AND so.client_user_id IS NOT NULL
          AND so.service_date BETWEEN ${start} AND ${end}
          AND (
            c.customer_type IN ('体验客', '小美客')
            OR c.became_member_at::date BETWEEN ${start} AND ${end}
          )
        UNION
        SELECT ${groupId} AS group_id, c.user_id AS uid
        FROM client_wechat_users c
        JOIN skel sk ON sk.store_id = c.bound_store_id
        WHERE c.bound_store_id IS NOT NULL
          AND c.became_member_at IS NOT NULL
          AND c.became_member_at::date BETWEEN ${start} AND ${end}
      ) tc
      GROUP BY group_id
    ),
    -- 流量人次 / 会员人次（service_orders 行数，按实际发生门店汇总）
    visits_agg AS (
      SELECT ${groupId} AS group_id,
        COUNT(*) FILTER (WHERE c.customer_type IN ('体验客', '小美客')) AS traffic_visits,
        COUNT(*) FILTER (WHERE c.customer_type = '会员客') AS member_visits
      FROM service_orders so
      JOIN skel sk ON sk.store_id = so.store_id
      JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${start} AND ${end}
      GROUP BY ${groupId}
    ),
    -- 项目数（sales_category 限定，按实际发生门店汇总）
    proj_agg AS (
      SELECT ${groupId} AS group_id, COALESCE(SUM(sit.session_used), 0) AS project_count
      FROM service_orders so
      JOIN skel sk ON sk.store_id = so.store_id
      JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${start} AND ${end}
        AND sit.sales_category IN ('自销自耗', '他销自耗')
        AND ${excludeDepositRefundSql('so')}
      GROUP BY ${groupId}
    ),
    -- 生美实耗（单次客耗分子，按实际发生门店汇总）
    sm_consume AS (
      SELECT ${groupId} AS group_id,
             COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used::numeric), 0) AS sm_total
      FROM service_orders so
      JOIN skel sk ON sk.store_id = so.store_id
      JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${start} AND ${end}
        AND sit.is_shengmei = TRUE
        AND ${excludeDepositRefundSql('so')}
      GROUP BY ${groupId}
    ),
    -- 服务人次（单次客耗分母 = 已完成 service_orders 行数）
    svc_all AS (
      SELECT ${groupId} AS group_id, COUNT(*) AS service_count
      FROM service_orders so
      JOIN skel sk ON sk.store_id = so.store_id
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${start} AND ${end}
      GROUP BY ${groupId}
    )
    SELECT
      gs.group_id,
      COALESCE(spend_agg.bucket_d, 0) AS bucket_d,
      COALESCE(spend_agg.bucket_c, 0) AS bucket_c,
      COALESCE(spend_agg.bucket_b, 0) AS bucket_b,
      COALESCE(spend_agg.bucket_a, 0) AS bucket_a,
      COALESCE(spend_agg.bucket_v, 0) AS bucket_v,
      COALESCE(spend_agg.bucket_vic, 0) AS bucket_vic,
      COALESCE(spend_agg.operated_total, 0) AS operated_total,
      COALESCE(spend_agg.member_spend_total, 0) AS member_spend_total,
      COALESCE(spend_agg.member_spend_count, 0) AS member_spend_count,
      COALESCE(newmem.new_members, 0) AS new_members,
      COALESCE(newmem_spend.new_spend, 0) AS new_spend,
      COALESCE(traffic_cust.traffic_customers, 0) AS traffic_customers,
      COALESCE(visits_agg.traffic_visits, 0) AS traffic_visits,
      COALESCE(visits_agg.member_visits, 0) AS member_visits,
      COALESCE(proj_agg.project_count, 0) AS project_count,
      COALESCE(sm_consume.sm_total, 0) AS sm_total,
      COALESCE(svc_all.service_count, 0) AS service_count
    FROM group_skel gs
    LEFT JOIN spend_agg ON spend_agg.group_id = gs.group_id
    LEFT JOIN newmem ON newmem.group_id = gs.group_id
    LEFT JOIN newmem_spend ON newmem_spend.group_id = gs.group_id
    LEFT JOIN traffic_cust ON traffic_cust.group_id = gs.group_id
    LEFT JOIN visits_agg ON visits_agg.group_id = gs.group_id
    LEFT JOIN proj_agg ON proj_agg.group_id = gs.group_id
    LEFT JOIN sm_consume ON sm_consume.group_id = gs.group_id
    LEFT JOIN svc_all ON svc_all.group_id = gs.group_id
  `)

  const map = new Map<string, OpsAgg>()
  for (const raw of rows as unknown[]) {
    const r = raw as Record<string, unknown>
    const id = String(r.group_id ?? '')
    if (!id) continue
    map.set(id, {
      bucketD: num(r.bucket_d),
      bucketC: num(r.bucket_c),
      bucketB: num(r.bucket_b),
      bucketA: num(r.bucket_a),
      bucketV: num(r.bucket_v),
      bucketVIC: num(r.bucket_vic),
      operatedTotal: num(r.operated_total),
      newMembers: num(r.new_members),
      trafficCustomers: num(r.traffic_customers),
      trafficVisits: num(r.traffic_visits),
      memberVisits: num(r.member_visits),
      projectCount: num(r.project_count),
      memberSpendTotal: num(r.member_spend_total),
      memberSpendCount: num(r.member_spend_count),
      newMemberSpendTotal: num(r.new_spend),
      shengmeiConsumeTotal: num(r.sm_total),
      serviceCount: num(r.service_count),
    })
  }
  return map
}

/** 安全除法（分母 0 → null，前端 '--'） */
const safeDiv = (a: number, b: number): number | null => (b > 0 ? a / b : null)

/** 组装 byMarket / byStore 行：骨架去重出组列表，逐组填 metrics */
function buildBreakdownRows(
  group: 'market' | 'store',
  skeletonRows: Array<{ marketId: string; marketName: string; storeId: string; storeName: string }>,
  regActive: Map<string, RegActiveAgg>,
  ops: Map<string, OpsAgg>,
): BreakdownRow[] {
  // 去重出该维度的组
  const groups = new Map<string, { name: string; marketName: string }>()
  for (const s of skeletonRows) {
    if (group === 'market') {
      if (!groups.has(s.marketId)) groups.set(s.marketId, { name: s.marketName, marketName: s.marketName })
    } else {
      if (!groups.has(s.storeId)) groups.set(s.storeId, { name: s.storeName, marketName: s.marketName })
    }
  }

  const rows: BreakdownRow[] = []
  for (const [id, info] of groups) {
    const ra = regActive.get(id)
    const op = ops.get(id)
    const memberAvg = op ? safeDiv(round2(op.memberSpendTotal), op.memberSpendCount) : null
    const newAvg = op ? safeDiv(round2(op.newMemberSpendTotal), op.newMembers) : null
    // 单次客耗 = 生美实耗 ÷ 服务人次（2026-05-26 用户拍板；防除零）
    const consumePerVisit = op ? safeDiv(round2(op.shengmeiConsumeTotal), op.serviceCount) : null
    const conv = op ? safeDiv(op.newMembers, op.trafficCustomers) : null

    rows.push({
      groupId: id,
      groupName: info.name,
      ...(group === 'store' ? { marketName: info.marketName } : {}),
      metrics: {
        // 注册客活组
        registered: ra?.registered ?? 0,
        retained: ra?.retained ?? 0,
        visitOnce: ra?.visitOnce ?? 0,
        visitOnceRate: ra ? safeDiv(ra.visitOnce, ra.retained) : null,
        visitTwice: ra?.visitTwice ?? 0,
        visitTwiceRate: ra ? safeDiv(ra.visitTwice, ra.retained) : null,
        dormant: ra?.dormant ?? 0,
        reactivatedDormant: ra?.reactivatedDormant ?? 0,
        frozen: ra?.frozen ?? 0,
        reactivatedFrozen: ra?.reactivatedFrozen ?? 0,
        deep: ra?.deep ?? 0,
        reactivatedDeep: ra?.reactivatedDeep ?? 0,
        // 消费分桶 + 经营组
        bucketD: op?.bucketD ?? 0,
        bucketC: op?.bucketC ?? 0,
        bucketB: op?.bucketB ?? 0,
        bucketA: op?.bucketA ?? 0,
        bucketV: op?.bucketV ?? 0,
        bucketVIC: op?.bucketVIC ?? 0,
        operatedTotal: op?.operatedTotal ?? 0,
        newMembers: op?.newMembers ?? 0,
        trafficCustomers: op?.trafficCustomers ?? 0,
        convRate: conv,
        memberAvgTicket: memberAvg,
        newCustomerAvgTicket: newAvg,
        trafficVisits: op?.trafficVisits ?? 0,
        memberVisits: op?.memberVisits ?? 0,
        projectCount: op?.projectCount ?? 0,
        consumePerVisit,
      },
    })
  }
  // 稳定排序：按 groupName
  rows.sort((a, b) => a.groupName.localeCompare(b.groupName, 'zh-Hans-CN'))
  return rows
}

// =====================================================================
// 入口
// =====================================================================

export const getCustomerBoard = withPermission(
  'data_center:dashboard',
  async (session: AuthSession, params: BoardParams): Promise<CustomerBoardResult> => {
    const ctx = await prepareBoardContext(session, params)
    const { scope, comparison, enabled } = ctx
    const cur = comparison.current

    // ── KPI（按语义分组并行查询）──────────────────────────────
    // 同比环比类（注册/到店/经营核心指标）走 withComparison；
    // 激活/客活/截面状态只对当期有意义，传 enabled=false（仅算 current）。
    const reg = (
      ct: '流量客' | '体验客' | '会员客' | null,
    ) => (r: ResolvedRange) => queryRegistration(session, scope, r, ct)
    const trafficC = (
      ct: '体验客' | '小美客' | '会员客' | null,
      metric: 'count' | 'users',
    ) => (r: ResolvedRange) => queryTrafficCount(session, scope, r, ct, metric)

    const [
      registeredMembers,
      retainedMembers,
      visitOnce,
      visitTwice,
      dormant,
      reactivatedDormant,
      frozen,
      reactivatedFrozen,
      deep,
      reactivatedDeep,
      operatedMembers,
      newMembers,
      trafficCustomers,
      memberAvgTicket,
      newCustomerAvgTicket,
      serviceCount,
      projectCount,
      consumePerVisit,
    ] = await Promise.all([
      // 会员注册人数（截面，对齐 memberCount）
      withComparison(reg('会员客'), comparison, 'count', enabled),
      // 有效保有会员（90 天窗口）
      withComparison((r) => queryRetainedMembers(session, scope, r), comparison, 'count', enabled),
      // 一次/二次客活（截面客活，仅当期）
      withComparison((r) => queryActive(session, scope, r, 'once'), comparison, 'count', false),
      withComparison((r) => queryActive(session, scope, r, 'twice'), comparison, 'count', false),
      // 5 档状态（截面，仅当期）
      withComparison(() => queryStatusCount(session, scope, '沉睡'), comparison, 'count', false),
      withComparison((r) => queryReactivated(session, scope, r, 'warn'), comparison, 'count', false),
      withComparison(() => queryStatusCount(session, scope, '冰冻'), comparison, 'count', false),
      withComparison((r) => queryReactivated(session, scope, r, 'frozen'), comparison, 'count', false),
      withComparison(() => queryStatusCount(session, scope, '休眠'), comparison, 'count', false),
      withComparison((r) => queryReactivated(session, scope, r, 'deep'), comparison, 'count', false),
      // 会员经营人数（区间内款项净额合计 ≥1990，非单笔）
      withComparison((r) => queryOperatedMembers(session, scope, r), comparison, 'count', enabled),
      // 会员新增
      withComparison((r) => queryNewMemberCount(session, scope, r), comparison, 'count', enabled),
      // 成交率分母（#284 起为「期初未达会员活跃池 ∪ 本期全部新增会员」）
      // ⚠ 第 4 参传 false = **不算同比/环比**，见下方 trafficCustomersCell 处的理由
      withComparison((r) => queryTrialFootfall(session, scope, r), comparison, 'count', false),
      // 会员客单价
      withComparison((r) => queryMemberAvgTicket(session, scope, r), comparison, 'amount', enabled),
      // 新客客单价
      withComparison(
        async (r) => {
          const [spend, count] = await Promise.all([
            queryNewMemberSpend(session, scope, r),
            queryNewMemberCount(session, scope, r),
          ])
          return count > 0 ? round2(spend / count) : null
        },
        comparison,
        'amount',
        enabled,
      ),
      // 服务人次
      withComparison((r) => queryServiceCount(session, scope, r), comparison, 'count', enabled),
      // 服务项目数
      withComparison((r) => queryProjectCount(session, scope, r), comparison, 'count', enabled),
      // 单次客耗 = 生美实耗 ÷ 服务人次（2026-05-26 用户拍板，对齐 metrics.md 明细区分母语义）
      withComparison(
        async (r) => {
          const [smConsume, svcCount] = await Promise.all([
            queryShengmeiConsume(session, scope, r),
            queryServiceCount(session, scope, r),
          ])
          return svcCount > 0 ? round2(smConsume / svcCount) : null
        },
        comparison,
        'amount',
        enabled,
      ),
    ])

    /**
     * 成交率分母禁用同比/环比（#284）。
     *
     * 分母的两个分支数据深度差 50 个月：① 取自 `service_orders`（最早 2026-07-08）、
     * ② 取自 `became_member_at`（回溯 2022-08）。基期一旦落在 2026-07-08 之前，
     * ① 恒空而 ② 仍有数百人 —— 算出来的 delta **100% 由 ② 构成**，是个看着合理的假数。
     *
     * 旧口径分母只读 `service_orders`，这类基期恒 0，`deltaPct` 会抑制成 null → UI '--'，
     * 是诚实的「算不出」。不把这条禁掉，本次修复就会把一个诚实的空值换成静默的错数。
     *
     * 与同页 `convRate` 同样处理：显式给「算不出」占位（前端渲染 '--'），而不是省略字段——
     * 省略会让前端的 `!== undefined` 判定整行不渲染徽章。
     * 割点背景见 memory `project-data-timeline-cutoff-20260703`。
     *
     * ⚠️ 这里原本写的是 `{ mom: null, yoy: null }`（#284 落地时 `KpiCell.mom` 还是
     * `DeltaPct | null`）。#310/#315 把类型收紧为 `DeltaDisplay`、用 `{ kind: 'na' }`
     * 表达「算不出」后，`null` 不再合法——两个 PR 各自绿灯、合并进 dev 才撞上。
     * 构造一律走 `resolveDeltaDisplay`（`types.ts` 的要求），别手写 `{ kind: 'na' }` 字面量。
     */
    const trafficCustomersCell: KpiCell = {
      ...trafficCustomers,
      ...(enabled
        ? { mom: resolveDeltaDisplay(null, null), yoy: resolveDeltaDisplay(null, null) }
        : {}),
    }
    // 成交率 = 会员新增 ÷ 成交率分母（派生自上面已算的两个 KPI 的 value）
    const convRate: KpiCell = {
      value: safeDiv(newMembers.value ?? 0, trafficCustomers.value ?? 0),
      unit: 'percent',
      // 派生指标不算同比环比，但 enabled 时仍要占位，否则前端 `!== undefined` 判定会整行不渲染徽章。
      // 走构造函数而不是手写 `{ kind: 'na' }` 字面量——types.ts 要求「构造一律走 resolveDeltaDisplay」，
      // 手写字面量会给后人开效仿的口子，而手写 `pct` 会绕过「value*100 恒有限」的构造保证。
      ...(enabled
        ? { mom: resolveDeltaDisplay(null, null), yoy: resolveDeltaDisplay(null, null) }
        : {}),
    }
    // 当月一次/二次人数（与客活同值，单列展示）—— 复用 visitOnce/visitTwice 的 value
    const visitOnceCell: KpiCell = { value: visitOnce.value, unit: 'count' }
    const visitTwiceCell: KpiCell = { value: visitTwice.value, unit: 'count' }

    const kpis: Record<string, KpiCell> = {
      registeredMembers,
      retainedMembers,
      visitOnce: visitOnceCell,
      visitTwice: visitTwiceCell,
      dormant,
      reactivatedDormant,
      frozen,
      reactivatedFrozen,
      deep,
      reactivatedDeep,
      operatedMembers,
      newMembers,
      trafficCustomers: trafficCustomersCell,
      convRate,
      memberAvgTicket,
      newCustomerAvgTicket,
      serviceCount,
      projectCount,
      consumePerVisit,
    }

    // ── 明细表（byMarket / byStore，仅当期）──────────────────────
    // 骨架（去重出组列表 + 所属市场名）
    const skelRows = (await db.execute(scopeStoreSkeletonSql(session, scope))) as unknown[]
    const skeleton = skelRows.map((raw) => {
      const r = raw as Record<string, unknown>
      return {
        marketId: String(r.market_id ?? ''),
        marketName: String(r.market_name ?? ''),
        storeId: String(r.store_id ?? ''),
        storeName: String(r.store_name ?? ''),
      }
    })

    const [
      regActiveByMarket,
      opsByMarket,
      regActiveByStore,
      opsByStore,
    ] = await Promise.all([
      queryRegActiveBreakdown(session, scope, cur, 'market'),
      queryOpsBreakdown(session, scope, cur, 'market'),
      queryRegActiveBreakdown(session, scope, cur, 'store'),
      queryOpsBreakdown(session, scope, cur, 'store'),
    ])

    const byMarket = buildBreakdownRows('market', skeleton, regActiveByMarket, opsByMarket)
    const byStore = buildBreakdownRows('store', skeleton, regActiveByStore, opsByStore)

    return {
      ...ctx.meta,
      kpis,
      byMarket,
      byStore,
    }
  },
)
