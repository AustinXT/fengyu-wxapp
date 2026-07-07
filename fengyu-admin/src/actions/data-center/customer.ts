'use server'



import { db } from '@/db'
import { sql, type SQL } from 'drizzle-orm'
import { withPermission } from '@/lib/with-permission'
import { prepareBoardContext } from '@/lib/data-center/context'
import { scopeFilterSql, scopeStoreSkeletonSql } from '@/lib/data-center/scope-sql'
import { excludeDepositRefundSql } from '@/lib/data-center/consume-filter'
import { withComparison } from '@/lib/data-center/comparison'
import type { AuthSession } from '@/lib/types'
import type {
  BoardParams,
  BreakdownRow,
  CustomerBoardResult,
  DataCenterScope,
  KpiCell,
  ResolvedRange,
} from '@/lib/data-center/types'


const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const round2 = (v: unknown): number => Math.round(num(v) * 100) / 100

const first = (rows: unknown): Record<string, unknown> =>
  ((rows as unknown[])[0] as Record<string, unknown>) ?? {}






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


async function queryOperatedMembers(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'o.store_id')
  const rows = await db.execute(sql`
    WITH member_spend AS (
      SELECT o.client_user_id,
             SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric) AS spend
      FROM sale_orders o
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE ${sc}
        AND o.sale_order_type IN ('销售单', '转换单')
        AND o.status = '已支付'
        AND o.legacy_source IS DISTINCT FROM 'workfine'
        AND o.paid_at::date BETWEEN ${range.start} AND ${range.end}
        AND c.customer_type = '会员客'
      GROUP BY o.client_user_id
    )
    SELECT COUNT(*) FILTER (WHERE spend >= 1990) AS v
    FROM member_spend
  `)
  return num(first(rows).v)
}


async function queryMemberAvgTicket(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number | null> {
  const sc = scopeFilterSql(session, scope, 'o.store_id')
  const rows = await db.execute(sql`
    WITH member_spend AS (
      SELECT o.client_user_id,
             SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric) AS spend
      FROM sale_orders o
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE ${sc}
        AND o.sale_order_type IN ('销售单', '转换单')
        AND o.status = '已支付'
        AND o.legacy_source IS DISTINCT FROM 'workfine'
        AND o.paid_at::date BETWEEN ${range.start} AND ${range.end}
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


async function queryNewMemberSpend(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'o.store_id')
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric), 0) AS v
    FROM sale_orders o
    JOIN client_wechat_users c ON c.user_id = o.client_user_id
    WHERE ${sc}
      AND c.became_member_at IS NOT NULL
      AND c.became_member_at::date BETWEEN ${range.start} AND ${range.end}
      AND o.sale_order_type IN ('销售单', '转换单')
      AND o.status = '已支付'
      AND o.legacy_source IS DISTINCT FROM 'workfine'
      AND o.paid_at::date BETWEEN ${range.start} AND ${range.end}
  `)
  return num(first(rows).v)
}


async function queryTrialFootfall(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
): Promise<number> {
  const sc = scopeFilterSql(session, scope, 'so.store_id')
  const rows = await db.execute(sql`
    SELECT COUNT(DISTINCT so.client_user_id) AS v
    FROM service_orders so
    JOIN client_wechat_users c ON c.user_id = so.client_user_id
    WHERE ${sc}
      AND so.status = '已完成'
      AND so.service_date BETWEEN ${range.start} AND ${range.end}
      AND c.customer_type IN ('体验客', '小美客')
  `)
  return num(first(rows).v)
}


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
  memberSpendTotal: number 
  memberSpendCount: number 
  newMemberSpendTotal: number 
  shengmeiConsumeTotal: number 
  serviceCount: number 
}


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

  const rows = await db.execute(sql`
    WITH skel AS (${skeleton}),
    -- 注册（会员客口径，became_member_at 截面）按 bound_store_id 归组
    reg AS (
      SELECT c.bound_store_id AS store_id, COUNT(*) AS registered
      FROM client_wechat_users c
      WHERE c.bound_store_id IS NOT NULL
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= ${end}
      GROUP BY c.bound_store_id
    ),
    -- 有效保有会员（90 天窗口 + became_member_at 守卫）按 bound_store_id 归组
    ret AS (
      SELECT c.bound_store_id AS store_id, COUNT(DISTINCT so.client_user_id) AS retained
      FROM service_orders so
      JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE c.bound_store_id IS NOT NULL
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
      WHERE c.bound_store_id IS NOT NULL
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
      WHERE c.bound_store_id IS NOT NULL
      GROUP BY c.bound_store_id
    ),
    -- 本月激活 anchor 反推（期内有到店 + anchor 非保有 + anchor 状态分档），按 bound_store_id 归组
    visited_in_period AS (
      SELECT DISTINCT so.client_user_id
      FROM service_orders so
      WHERE so.status = '已完成'
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
      WHERE c.became_member_at IS NOT NULL
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


async function queryOpsBreakdown(
  session: AuthSession,
  scope: DataCenterScope,
  range: ResolvedRange,
  group: 'market' | 'store',
): Promise<Map<string, OpsAgg>> {
  const skeleton = scopeStoreSkeletonSql(session, scope)
  const groupId = group === 'market' ? sql.raw('sk.market_id') : sql.raw('sk.store_id')
  const start = range.start
  const end = range.end

  const rows = await db.execute(sql`
    WITH skel AS (${skeleton}),
    -- 会员消费分桶（按 store_id 归组）：spend = received - refunded_amount
    member_spend AS (
      SELECT o.store_id, o.client_user_id,
             SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric) AS spend
      FROM sale_orders o
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE o.sale_order_type IN ('销售单', '转换单')
        AND o.status = '已支付'
        AND o.legacy_source IS DISTINCT FROM 'workfine'
        AND o.paid_at::date BETWEEN ${start} AND ${end}
        AND c.customer_type = '会员客'
      GROUP BY o.store_id, o.client_user_id
    ),
    spend_agg AS (
      SELECT store_id,
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
      GROUP BY store_id
    ),
    -- 新增会员数（bound_store_id 归组）
    newmem AS (
      SELECT c.bound_store_id AS store_id, COUNT(*) AS new_members
      FROM client_wechat_users c
      WHERE c.bound_store_id IS NOT NULL
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date BETWEEN ${start} AND ${end}
      GROUP BY c.bound_store_id
    ),
    -- 新增会员对应消费（按 o.store_id 归组）
    newmem_spend AS (
      SELECT o.store_id,
             COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric), 0) AS new_spend
      FROM sale_orders o
      JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE c.became_member_at IS NOT NULL
        AND c.became_member_at::date BETWEEN ${start} AND ${end}
        AND o.sale_order_type IN ('销售单', '转换单')
        AND o.status = '已支付'
        AND o.legacy_source IS DISTINCT FROM 'workfine'
        AND o.paid_at::date BETWEEN ${start} AND ${end}
      GROUP BY o.store_id
    ),
    -- 流量客人数（成交率分母，体验客+小美客，按 so.store_id 归组）
    traffic_cust AS (
      SELECT so.store_id, COUNT(DISTINCT so.client_user_id) AS traffic_customers
      FROM service_orders so
      JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${start} AND ${end}
        AND c.customer_type IN ('体验客', '小美客')
      GROUP BY so.store_id
    ),
    -- 流量人次 / 会员人次（service_orders 行数，按 so.store_id 归组）
    visits_agg AS (
      SELECT so.store_id,
        COUNT(*) FILTER (WHERE c.customer_type IN ('体验客', '小美客')) AS traffic_visits,
        COUNT(*) FILTER (WHERE c.customer_type = '会员客') AS member_visits
      FROM service_orders so
      JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${start} AND ${end}
      GROUP BY so.store_id
    ),
    -- 项目数（sales_category 限定，按 so.store_id 归组）
    proj_agg AS (
      SELECT so.store_id, COALESCE(SUM(sit.session_used), 0) AS project_count
      FROM service_orders so
      JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${start} AND ${end}
        AND sit.sales_category IN ('自销自耗', '他销自耗')
        AND ${excludeDepositRefundSql('so')}
      GROUP BY so.store_id
    ),
    -- 生美实耗（单次客耗分子，按 so.store_id 归组）
    sm_consume AS (
      SELECT so.store_id,
             COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used::numeric), 0) AS sm_total
      FROM service_orders so
      JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${start} AND ${end}
        AND sit.is_shengmei = TRUE
        AND ${excludeDepositRefundSql('so')}
      GROUP BY so.store_id
    ),
    -- 服务人次（单次客耗分母 = 已完成 service_orders 行数，按 so.store_id 归组）
    svc_all AS (
      SELECT so.store_id, COUNT(*) AS service_count
      FROM service_orders so
      WHERE so.status = '已完成'
        AND so.service_date BETWEEN ${start} AND ${end}
      GROUP BY so.store_id
    )
    SELECT
      ${groupId} AS group_id,
      COALESCE(SUM(spend_agg.bucket_d), 0) AS bucket_d,
      COALESCE(SUM(spend_agg.bucket_c), 0) AS bucket_c,
      COALESCE(SUM(spend_agg.bucket_b), 0) AS bucket_b,
      COALESCE(SUM(spend_agg.bucket_a), 0) AS bucket_a,
      COALESCE(SUM(spend_agg.bucket_v), 0) AS bucket_v,
      COALESCE(SUM(spend_agg.bucket_vic), 0) AS bucket_vic,
      COALESCE(SUM(spend_agg.operated_total), 0) AS operated_total,
      COALESCE(SUM(spend_agg.member_spend_total), 0) AS member_spend_total,
      COALESCE(SUM(spend_agg.member_spend_count), 0) AS member_spend_count,
      COALESCE(SUM(newmem.new_members), 0) AS new_members,
      COALESCE(SUM(newmem_spend.new_spend), 0) AS new_spend,
      COALESCE(SUM(traffic_cust.traffic_customers), 0) AS traffic_customers,
      COALESCE(SUM(visits_agg.traffic_visits), 0) AS traffic_visits,
      COALESCE(SUM(visits_agg.member_visits), 0) AS member_visits,
      COALESCE(SUM(proj_agg.project_count), 0) AS project_count,
      COALESCE(SUM(sm_consume.sm_total), 0) AS sm_total,
      COALESCE(SUM(svc_all.service_count), 0) AS service_count
    FROM skel sk
    LEFT JOIN spend_agg ON spend_agg.store_id = sk.store_id
    LEFT JOIN newmem ON newmem.store_id = sk.store_id
    LEFT JOIN newmem_spend ON newmem_spend.store_id = sk.store_id
    LEFT JOIN traffic_cust ON traffic_cust.store_id = sk.store_id
    LEFT JOIN visits_agg ON visits_agg.store_id = sk.store_id
    LEFT JOIN proj_agg ON proj_agg.store_id = sk.store_id
    LEFT JOIN sm_consume ON sm_consume.store_id = sk.store_id
    LEFT JOIN svc_all ON svc_all.store_id = sk.store_id
    GROUP BY ${groupId}
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


const safeDiv = (a: number, b: number): number | null => (b > 0 ? a / b : null)


function buildBreakdownRows(
  group: 'market' | 'store',
  skeletonRows: Array<{ marketId: string; marketName: string; storeId: string; storeName: string }>,
  regActive: Map<string, RegActiveAgg>,
  ops: Map<string, OpsAgg>,
): BreakdownRow[] {
  
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
    
    const consumePerVisit = op ? safeDiv(round2(op.shengmeiConsumeTotal), op.serviceCount) : null
    const conv = op ? safeDiv(op.newMembers, op.trafficCustomers) : null

    rows.push({
      groupId: id,
      groupName: info.name,
      ...(group === 'store' ? { marketName: info.marketName } : {}),
      metrics: {
        
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
  
  rows.sort((a, b) => a.groupName.localeCompare(b.groupName, 'zh-Hans-CN'))
  return rows
}





export const getCustomerBoard = withPermission(
  'data_center:dashboard',
  async (session: AuthSession, params: BoardParams): Promise<CustomerBoardResult> => {
    const ctx = await prepareBoardContext(session, params)
    const { scope, comparison, enabled } = ctx
    const cur = comparison.current

    
    
    
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
      
      withComparison(reg('会员客'), comparison, 'count', enabled),
      
      withComparison((r) => queryRetainedMembers(session, scope, r), comparison, 'count', enabled),
      
      withComparison((r) => queryActive(session, scope, r, 'once'), comparison, 'count', false),
      withComparison((r) => queryActive(session, scope, r, 'twice'), comparison, 'count', false),
      
      withComparison(() => queryStatusCount(session, scope, '沉睡'), comparison, 'count', false),
      withComparison((r) => queryReactivated(session, scope, r, 'warn'), comparison, 'count', false),
      withComparison(() => queryStatusCount(session, scope, '冰冻'), comparison, 'count', false),
      withComparison((r) => queryReactivated(session, scope, r, 'frozen'), comparison, 'count', false),
      withComparison(() => queryStatusCount(session, scope, '休眠'), comparison, 'count', false),
      withComparison((r) => queryReactivated(session, scope, r, 'deep'), comparison, 'count', false),
      
      withComparison((r) => queryOperatedMembers(session, scope, r), comparison, 'count', enabled),
      
      withComparison((r) => queryNewMemberCount(session, scope, r), comparison, 'count', enabled),
      
      withComparison((r) => queryTrialFootfall(session, scope, r), comparison, 'count', enabled),
      
      withComparison((r) => queryMemberAvgTicket(session, scope, r), comparison, 'amount', enabled),
      
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
      
      withComparison((r) => queryServiceCount(session, scope, r), comparison, 'count', enabled),
      
      withComparison((r) => queryProjectCount(session, scope, r), comparison, 'count', enabled),
      
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

    
    const convRate: KpiCell = {
      value: safeDiv(newMembers.value ?? 0, trafficCustomers.value ?? 0),
      unit: 'percent',
      ...(enabled ? { mom: null, yoy: null } : {}),
    }
    
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
      trafficCustomers,
      convRate,
      memberAvgTicket,
      newCustomerAvgTicket,
      serviceCount,
      projectCount,
      consumePerVisit,
    }

    
    
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
