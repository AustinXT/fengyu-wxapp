/**
 * 管理层客量数据子页（mgmtTraffic）
 *
 * summary — 一次返回 5 个 section：
 *   1. 注册情况（截至 endDate）
 *   2. 到店客流（区间维度）
 *   3. 会员状态与客活（截面 + 区间 + 本月激活）
 *   4. 会员被经营（6 桶 + 客单价）
 *   5. 新会员经营（数量 / 消费 / trialFootfall）
 *
 * 口径权威源：notes/references/metrics.md「客量数据子页」章节
 */

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')
const { validateManagementScope, buildManagementStoreScope } = require('../utils/scope')
// 在营口径单源（#401）：只看门店组织节点 is_active，与 mgmt-dashboard.js / admin scopeFilterSql 同源
const { activeStoreCondition } = require('../utils/store-status')
const { excludeDepositRefundSql } = require('../utils/consume-filter')
const { getMemberThreshold } = require('../utils/config')

/**
 * 会员被经营 6 档分桶的固定下界（星钻 1w / 粉钻 3w / 金钻 6w / 黑钻 10w）。
 * 最低一档下界 = 会员门槛 system_configs.new_member_threshold（getMemberThreshold，#292）。
 * ⚠️ admin 同值独立副本：fengyu-admin/src/lib/data-center/spend-buckets.ts（禁止跨端共享代码），
 * 由 fengyu-admin consistency.customer.test.ts 守护。tier 标签 '<1990' / '1990-1W' 保持写死（2026-09-25 拍板）。
 */
const SPEND_BUCKET_FLOORS = Object.freeze({
  star: 10000,
  pink: 30000,
  gold: 60000,
  black: 100000,
})

const VALID_PERIODS = ['month', 'lastMonth', 'year']

// scope 校验已统一抽取到 utils/scope.js::validateManagementScope（4 路由共用，避免拷贝漂移）

/** sale/service 表的 store_id scope 过滤片段（与 mgmt-dashboard.js 同实现） */
function buildSaleScope(scopeType, scopeId, alias, startIdx) {
  const column = `${alias}.store_id`
  const scope = buildManagementStoreScope(scopeType, scopeId, column, startIdx)
  return { sql: `(${scope.sql}) AND ${activeStoreCondition(column)}`, params: scope.params }
}

/** client_wechat_users.bound_store_id scope（与 mgmt-dashboard.js 同实现） */
function buildClientScope(scopeType, scopeId, alias, startIdx) {
  const column = `${alias}.bound_store_id`
  const scope = buildManagementStoreScope(scopeType, scopeId, column, startIdx)
  return { sql: `(${scope.sql}) AND ${activeStoreCondition(column)}`, params: scope.params }
}

/**
 * 解析 period → { startDate, endDate } YYYY-MM-DD 字符串
 * 锚点为"今天"（执行时刻），与 SQL 内 NOW() 同源
 */
function resolvePeriodRange(period) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() // 0-based
  const d = now.getDate()
  const fmt = (yy, mm, dd) =>
    `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`

  if (period === 'month') {
    return { startDate: fmt(y, m, 1), endDate: fmt(y, m, d) }
  }
  if (period === 'lastMonth') {
    const startY = m === 0 ? y - 1 : y
    const startM = m === 0 ? 11 : m - 1
    // 上月最后一天 = 当月 0 号
    const endDay = new Date(y, m, 0)
    return {
      startDate: fmt(startY, startM, 1),
      endDate: fmt(endDay.getFullYear(), endDay.getMonth(), endDay.getDate()),
    }
  }
  // year
  return { startDate: fmt(y, 0, 1), endDate: fmt(y, m, d) }
}

/** endDate 表达式：用 NOW() 锚点避免时区漂移 */
function endDateExpr(period) {
  if (period === 'lastMonth') {
    return `(date_trunc('month', NOW()) - INTERVAL '1 day')::date`
  }
  return `NOW()::date`
}

/** startDate 表达式：用 NOW() 锚点 */
function startDateExpr(period) {
  if (period === 'month') {
    return `date_trunc('month', NOW())::date`
  }
  if (period === 'lastMonth') {
    return `date_trunc('month', NOW() - INTERVAL '1 month')::date`
  }
  return `date_trunc('year', NOW())::date`
}

async function resolveScopeName(scopeType, scopeId) {
  if (scopeType === 'all') return '全部市场'
  if (scopeType === 'market') {
    const rows = await pg.query(
      "SELECT name FROM org_nodes WHERE id = $1 AND type = '市场'",
      [scopeId],
    )
    return rows[0]?.name || ''
  }
  const rows = await pg.query(
    'SELECT store_name FROM stores WHERE store_id = $1',
    [scopeId],
  )
  return rows[0]?.store_name || ''
}

// =====================================================================
// Section 1：注册情况（4 项截面）
// =====================================================================

async function querySingleRegistration(scopeType, scopeId, period, customerType) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 1)

  // 会员客切 became_member_at 与 mgmt-dashboard.summary.memberCount 对齐（2026-04-25）
  if (customerType === '会员客') {
    const rows = await pg.query(
      `SELECT COUNT(*) AS v
         FROM client_wechat_users c
        WHERE ${sc.sql}
          AND c.became_member_at IS NOT NULL
          AND c.became_member_at::date <= ${endDateExpr(period)}`,
      sc.params,
    )
    return Number(rows[0]?.v || 0)
  }

  // 其他类型仍用 customer_type 快照（regOnly/regTrial/regTotal）
  const typeClause = customerType
    ? ` AND c.customer_type = '${customerType}'`
    : ''
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.created_at::date <= ${endDateExpr(period)}${typeClause}`,
    sc.params,
  )
  return Number(rows[0]?.v || 0)
}

async function queryRegistration(scopeType, scopeId, period) {
  const [regTotal, regOnly, regTrial, regMember] = await Promise.all([
    querySingleRegistration(scopeType, scopeId, period, null),
    querySingleRegistration(scopeType, scopeId, period, '流量客'),
    querySingleRegistration(scopeType, scopeId, period, '体验客'),
    querySingleRegistration(scopeType, scopeId, period, '会员客'),
  ])
  return { regTotal, regOnly, regTrial, regMember }
}

// =====================================================================
// Section 2：到店客流（trafficCount / trafficUsers / trafficSessions × 4 列）
// =====================================================================

const TRAFFIC_TYPES = [
  { type: 'total', label: '总', customerType: null },
  { type: 'trial', label: '体验客', customerType: '体验客' },
  { type: 'xiaomei', label: '小美客', customerType: '小美客' },
  { type: 'member', label: '会员客', customerType: '会员客' },
]

/**
 * 一次性出 trafficCount + trafficUsers（按 customer_type ROLLUP，total 行 customer_type=NULL）
 */
async function queryTrafficCountUsers(scopeType, scopeId, period) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 1)
  const rows = await pg.query(
    `SELECT
       c.customer_type AS customer_type,
       COUNT(*) AS cnt,
       COUNT(DISTINCT so.client_user_id) AS users
     FROM service_orders so
     JOIN client_wechat_users c ON c.user_id = so.client_user_id
     WHERE ${sc.sql}
       AND so.status = '已完成'
       AND so.service_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
     GROUP BY ROLLUP(c.customer_type)`,
    sc.params,
  )
  return rows
}

/**
 * 一次性出 trafficSessions（按 customer_type ROLLUP，限定 sales_category）
 */
async function queryTrafficSessions(scopeType, scopeId, period) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 1)
  const rows = await pg.query(
    `SELECT
       c.customer_type AS customer_type,
       COALESCE(SUM(sit.session_used), 0) AS sessions
     FROM service_orders so
     JOIN service_items sit ON sit.service_order_id = so.service_order_id
     JOIN client_wechat_users c ON c.user_id = so.client_user_id
     WHERE ${sc.sql}
       AND so.status = '已完成'
       AND so.service_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
       AND sit.sales_category IN ('自销自耗', '他销自耗')
       AND ${excludeDepositRefundSql('so')}
     GROUP BY ROLLUP(c.customer_type)`,
    sc.params,
  )
  return rows
}

async function queryTraffic(scopeType, scopeId, period) {
  const [cuRows, sessRows] = await Promise.all([
    queryTrafficCountUsers(scopeType, scopeId, period),
    queryTrafficSessions(scopeType, scopeId, period),
  ])

  const cuMap = new Map()
  for (const r of cuRows) {
    const key = r.customer_type === null || r.customer_type === undefined ? '__total__' : r.customer_type
    cuMap.set(key, { cnt: Number(r.cnt || 0), users: Number(r.users || 0) })
  }
  const sessMap = new Map()
  for (const r of sessRows) {
    const key = r.customer_type === null || r.customer_type === undefined ? '__total__' : r.customer_type
    sessMap.set(key, Number(r.sessions || 0))
  }

  return TRAFFIC_TYPES.map((t) => {
    const key = t.customerType === null ? '__total__' : t.customerType
    const cu = cuMap.get(key) || { cnt: 0, users: 0 }
    const sess = sessMap.get(key) || 0
    return {
      type: t.type,
      label: t.label,
      count: cu.cnt,
      users: cu.users,
      sessions: sess,
    }
  })
}

// =====================================================================
// Section 3：会员状态与客活
// =====================================================================

/**
 * 5 项截面（按 customer_status 分组）
 *   - 沉睡 需追加 customer_type='会员客' 过滤（D-6 落地：migration 0013 已对齐）
 */
async function queryStatusBreakdown(scopeType, scopeId) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 1)
  // 'normal' 集合：customer_status IN (4 项)
  const normalRows = await pg.query(
    `SELECT c.customer_status AS s, COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.customer_status IN ('保有会员-稳定', '保有会员-有效', '冰冻', '休眠')
      GROUP BY c.customer_status`,
    sc.params,
  )
  // dormantWarn 单独查（追加 customer_type='会员客'）
  const warnRows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.customer_status = '沉睡'
        AND c.customer_type = '会员客'`,
    sc.params,
  )

  const map = new Map(normalRows.map((r) => [r.s, Number(r.v || 0)]))
  return {
    retainedStable: map.get('保有会员-稳定') || 0,
    retainedActive: map.get('保有会员-有效') || 0,
    dormantWarn: Number(warnRows[0]?.v || 0),
    dormantFrozen: map.get('冰冻') || 0,
    dormantDeep: map.get('休眠') || 0,
  }
}

/**
 * 一次客活 / 二次客活 = 区间内到店**天数** = 1 / >= 2（#298）
 *
 * 到店天数按 (client_user_id, service_date) 去重，同日多张服务单只算 1 天；
 * 与 cron monthly_activity 同轴。admin 侧同口径在 lib/data-center/visit-days.ts（visitDaysSql），
 * 两端独立副本，由 fengyu-admin consistency.customer.test.ts 守护。
 *
 * ★ 会员守卫 `became_member_at IS NOT NULL AND ::date <= endDateExpr(period)`（#414，用户 2026-09-25 拍板同步）：
 * `customer_status` 是 cron 重算的**当前**截面、不随 period 回溯，缺守卫时「区间内到店过、现在是保有会员、
 * 但入会晚于区间终点」的人也会被计入。admin 侧该守卫是达成率「分子 ⊆ 分母」的承重条件；
 * staff 无达成率，补它是为了**同名指标两端不分叉**（#298 刚统一过口径）。
 * 只影响 period='lastMonth'（终点是上月末）：prod 实测 一次 511→486 / 二次 894→847，合计 −72 人。
 * 'month' / 'year' 的终点是 NOW()::date，守卫对全部会员恒真，数字不变。
 * ⚠ cron `refresh-monthly-activity` 与 `db/scripts/calc-monthly-activity.js` **不带**这条
 * （它们给当月到店的所有顾客打标、含非会员，加了会改自己的口径）。
 */
async function queryActiveOnce(scopeType, scopeId, period) {
  const ssc = buildSaleScope(scopeType, scopeId, 'so', 1)
  const csc = buildClientScope(scopeType, scopeId, 'c', 1 + ssc.params.length)
  const rows = await pg.query(
    `WITH visit_count AS (
       SELECT so.client_user_id, COUNT(DISTINCT so.service_date) AS days
         FROM service_orders so
        WHERE ${ssc.sql}
          AND so.status = '已完成'
          AND so.client_user_id IS NOT NULL
          AND so.service_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
        GROUP BY so.client_user_id
     )
     SELECT COUNT(*) AS v
       FROM visit_count vc
       JOIN client_wechat_users c ON c.user_id = vc.client_user_id
      WHERE ${csc.sql}
        AND c.customer_status IN ('保有会员-稳定', '保有会员-有效')
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= ${endDateExpr(period)}
        AND vc.days = 1`,
    [...ssc.params, ...csc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryActiveTwice(scopeType, scopeId, period) {
  const ssc = buildSaleScope(scopeType, scopeId, 'so', 1)
  const csc = buildClientScope(scopeType, scopeId, 'c', 1 + ssc.params.length)
  const rows = await pg.query(
    `WITH visit_count AS (
       SELECT so.client_user_id, COUNT(DISTINCT so.service_date) AS days
         FROM service_orders so
        WHERE ${ssc.sql}
          AND so.status = '已完成'
          AND so.client_user_id IS NOT NULL
          AND so.service_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
        GROUP BY so.client_user_id
     )
     SELECT COUNT(*) AS v
       FROM visit_count vc
       JOIN client_wechat_users c ON c.user_id = vc.client_user_id
      WHERE ${csc.sql}
        AND c.customer_status IN ('保有会员-稳定', '保有会员-有效')
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= ${endDateExpr(period)}
        AND vc.days >= 2`,
    [...ssc.params, ...csc.params],
  )
  return Number(rows[0]?.v || 0)
}

/**
 * 本月激活 3 档（anchor=startDate-1 的 customer_status 实时反推）
 *
 * @param {'warn'|'frozen'|'deep'} bucket
 *   - warn:   last_dt >= anchor - 6 months
 *   - frozen: last_dt < anchor - 6 months AND last_dt >= anchor - 12 months
 *   - deep:   last_dt < anchor - 12 months OR last_dt IS NULL
 */
async function queryReactivated(scopeType, scopeId, period, startDate, bucket) {
  const ssc = buildSaleScope(scopeType, scopeId, 'so', 2) // $1=startDate
  const csc = buildClientScope(
    scopeType,
    scopeId,
    'c',
    2 + ssc.params.length,
  )

  let lastDtClause
  if (bucket === 'warn') {
    lastDtClause = `a.last_dt IS NOT NULL
       AND a.last_dt >= ($1::date - 1 - INTERVAL '6 months')::date`
  } else if (bucket === 'frozen') {
    lastDtClause = `a.last_dt IS NOT NULL
       AND a.last_dt < ($1::date - 1 - INTERVAL '6 months')::date
       AND a.last_dt >= ($1::date - 1 - INTERVAL '12 months')::date`
  } else {
    // deep
    lastDtClause = `(a.last_dt IS NULL
       OR a.last_dt < ($1::date - 1 - INTERVAL '12 months')::date)`
  }

  const params = [startDate, ...ssc.params, ...csc.params]

  const rows = await pg.query(
    `WITH visited_in_period AS (
       SELECT DISTINCT so.client_user_id
         FROM service_orders so
        WHERE ${ssc.sql}
          AND so.status = '已完成'
          AND so.client_user_id IS NOT NULL
          AND so.service_date BETWEEN $1::date AND ${endDateExpr(period)}
     ),
     anchor_stats AS (
       SELECT
         c.user_id,
         MAX(so.service_date) AS last_dt,
         COUNT(*) FILTER (
           WHERE so.service_date BETWEEN ($1::date - 1 - INTERVAL '90 days')::date
                                      AND ($1::date - 1)
         ) AS visits_90d_prev
         FROM client_wechat_users c
         LEFT JOIN service_orders so
           ON so.client_user_id = c.user_id
          AND so.status = '已完成'
          AND so.service_date <= ($1::date - 1)
        WHERE c.became_member_at IS NOT NULL
          AND c.became_member_at::date <= ($1::date - 1)
        GROUP BY c.user_id
     )
     SELECT COUNT(*) AS v
       FROM visited_in_period v
       JOIN anchor_stats a ON a.user_id = v.client_user_id
       JOIN client_wechat_users c ON c.user_id = v.client_user_id
      WHERE a.visits_90d_prev = 0
        AND ${lastDtClause}
        AND ${csc.sql}`,
    params,
  )
  return Number(rows[0]?.v || 0)
}

// =====================================================================
// Section 4：会员被经营（6 桶 + 客单价）
// =====================================================================

async function queryMemberOps(scopeType, scopeId, period) {
  const sc = buildSaleScope(scopeType, scopeId, 'o', 1)
  const threshold = await getMemberThreshold()
  // 门槛参数占位（字符串拼接而非模板串：守护的 SQL 词法器会把 `$${` 读成 PG dollar-quote）
  const th = '$' + (sc.params.length + 1)
  const f = SPEND_BUCKET_FLOORS
  const rows = await pg.query(
    `WITH member_spend AS (
       SELECT o.client_user_id,
              SUM(spe.amount::numeric) AS spend
         FROM sale_order_performance_events spe
         JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
         JOIN client_wechat_users c ON c.user_id = o.client_user_id
        WHERE ${sc.sql}
          AND spe.sale_order_type IN ('销售单', '转换单')
          AND spe.status = '已支付'
          AND spe.change_type IN ('首次支付', '回款', '退款')
          AND spe.legacy_source IS DISTINCT FROM 'workfine'
          AND spe.performance_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
          AND c.customer_type = '会员客'
        GROUP BY o.client_user_id
     )
     SELECT
       COUNT(*) FILTER (WHERE spend < ${th}) AS bucket1_count,
       COALESCE(SUM(spend) FILTER (WHERE spend < ${th}), 0) AS bucket1_spend,
       COUNT(*) FILTER (WHERE spend >= ${th} AND spend < ${f.star}) AS bucket2_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= ${th} AND spend < ${f.star}), 0) AS bucket2_spend,
       COUNT(*) FILTER (WHERE spend >= ${f.star} AND spend < ${f.pink}) AS bucket3_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= ${f.star} AND spend < ${f.pink}), 0) AS bucket3_spend,
       COUNT(*) FILTER (WHERE spend >= ${f.pink} AND spend < ${f.gold}) AS bucket4_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= ${f.pink} AND spend < ${f.gold}), 0) AS bucket4_spend,
       COUNT(*) FILTER (WHERE spend >= ${f.gold} AND spend < ${f.black}) AS bucket5_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= ${f.gold} AND spend < ${f.black}), 0) AS bucket5_spend,
       COUNT(*) FILTER (WHERE spend >= ${f.black}) AS bucket6_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= ${f.black}), 0) AS bucket6_spend,
       COALESCE(SUM(spend), 0) AS total_spend,
       COUNT(*) AS total_count
     FROM member_spend`,
    [...sc.params, threshold],
  )
  const r = rows[0] || {}
  const round2 = (v) => Math.round(Number(v || 0) * 100) / 100
  const totalSpend = Number(r.total_spend || 0)
  const totalCount = Number(r.total_count || 0)
  return {
    buckets: [
      { tier: '<1990', count: Number(r.bucket1_count || 0), spend: round2(r.bucket1_spend) },
      { tier: '1990-1W', count: Number(r.bucket2_count || 0), spend: round2(r.bucket2_spend) },
      { tier: '1-3W', count: Number(r.bucket3_count || 0), spend: round2(r.bucket3_spend) },
      { tier: '3-6W', count: Number(r.bucket4_count || 0), spend: round2(r.bucket4_spend) },
      { tier: '6-10W', count: Number(r.bucket5_count || 0), spend: round2(r.bucket5_spend) },
      { tier: '10W+', count: Number(r.bucket6_count || 0), spend: round2(r.bucket6_spend) },
    ],
    avgTicket: totalCount > 0 ? round2(totalSpend / totalCount) : 0,
  }
}

// =====================================================================
// Section 5：新会员经营（count / spend / trialFootfall）
// =====================================================================

async function queryNewMemberCount(scopeType, scopeId, period) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 1)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}`,
    sc.params,
  )
  return Number(rows[0]?.v || 0)
}

async function queryNewMemberSpend(scopeType, scopeId, period) {
  const sc = buildSaleScope(scopeType, scopeId, 'o', 1)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(spe.amount::numeric), 0) AS v
       FROM sale_order_performance_events spe
       JOIN sale_orders o ON o.sale_order_id = spe.sale_order_id
       JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE ${sc.sql}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
        AND spe.sale_order_type IN ('销售单', '转换单')
        AND spe.status = '已支付'
        AND spe.change_type IN ('首次支付', '回款', '退款')
        AND spe.legacy_source IS DISTINCT FROM 'workfine'
        AND spe.performance_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}`,
    sc.params,
  )
  return Number(rows[0]?.v || 0)
}

/**
 * 成交率分母 = 期初未达会员的到店活跃池 ∪ 本期全部新增会员
 * （D-conv-denom=1c，#284 于 2026-09-22 拍板；推翻原 D-2=B）
 *
 * 为什么不能只用 `customer_type IN ('体验客','小美客')`：该字段是**只升不降的当前快照**
 * （升级链 流量客 → 体验客 → 小美客 → 会员客），本期成功转化的人当期已是「会员客」，
 * 被从分母整体剔除 —— **而他们正是分子**，成交率因此虚高、单店可出 800%、分母归零显示 '--'。
 *
 * 分支 ② 保证「分子 ⊆ 分母」：本期新增会员里有一部分当期没有任何已完成服务单，
 * 不 UNION 进来的话他们进分子不进分母，单店仍可能 > 100%。
 *
 * 两分支 scope 列不同是有意的：① 按服务发生门店（`so.store_id`）、② 按顾客绑定门店
 * （`c.bound_store_id`，与分子 queryNewMemberCount 同源）。⚠️ 参数占位符跨两段连号，
 * 第二段起始下标必须按第一段实际 params 长度接续（all 档为 0，market/store 档为 1）。
 *
 * admin 侧同口径副本：fengyu-admin/src/actions/data-center/customer.ts::queryTrialFootfall
 */
async function queryTrialFootfall(scopeType, scopeId, period) {
  const scVisit = buildSaleScope(scopeType, scopeId, 'so', 1)
  const scMember = buildClientScope(scopeType, scopeId, 'c', 1 + scVisit.params.length)
  const rows = await pg.query(
    `SELECT COUNT(DISTINCT t.uid) AS v
       FROM (
         SELECT so.client_user_id AS uid
           FROM service_orders so
           JOIN client_wechat_users c ON c.user_id = so.client_user_id
          WHERE ${scVisit.sql}
            AND so.status = '已完成'
            AND so.client_user_id IS NOT NULL
            AND so.service_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
            AND (
              c.customer_type IN ('体验客', '小美客')
              OR c.became_member_at::date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
            )
          UNION
         SELECT c.user_id AS uid
           FROM client_wechat_users c
          WHERE ${scMember.sql}
            AND c.became_member_at IS NOT NULL
            AND c.became_member_at::date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
       ) t`,
    [...scVisit.params, ...scMember.params],
  )
  return Number(rows[0]?.v || 0)
}

// =====================================================================
// summary 入口
// =====================================================================

async function summary(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { period, scopeType, scopeId } = ctx.event.payload || {}

  if (!period || !VALID_PERIODS.includes(period)) {
    throw new Error('INVALID_PARAMS: 时间维度必须是 本月/上月/本年')
  }
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: 范围类型必须是 全部/市场/门店')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: 范围类型为市场/门店时必须提供范围 ID')
  }

  validateManagementScope(ctx.auth, scopeType, scopeId)

  const { startDate, endDate } = resolvePeriodRange(period)

  const t0 = Date.now()
  const [
    registration,
    traffic,
    statusBreakdown,
    activeOnce,
    activeTwice,
    reactivatedFromWarn,
    reactivatedFromFrozen,
    reactivatedFromDeep,
    memberOps,
    newMemberCount,
    newMemberSpend,
    trialFootfall,
    scopeName,
  ] = await Promise.all([
    queryRegistration(scopeType, scopeId, period),
    queryTraffic(scopeType, scopeId, period),
    queryStatusBreakdown(scopeType, scopeId),
    queryActiveOnce(scopeType, scopeId, period),
    queryActiveTwice(scopeType, scopeId, period),
    queryReactivated(scopeType, scopeId, period, startDate, 'warn'),
    queryReactivated(scopeType, scopeId, period, startDate, 'frozen'),
    queryReactivated(scopeType, scopeId, period, startDate, 'deep'),
    queryMemberOps(scopeType, scopeId, period),
    queryNewMemberCount(scopeType, scopeId, period),
    queryNewMemberSpend(scopeType, scopeId, period),
    queryTrialFootfall(scopeType, scopeId, period),
    resolveScopeName(scopeType, scopeId),
  ])
  const elapsed = Date.now() - t0

  ctx.result = {
    period,
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    startDate,
    endDate,
    registration,
    traffic,
    status: {
      retainedStable: statusBreakdown.retainedStable,
      retainedActive: statusBreakdown.retainedActive,
      dormantWarn: statusBreakdown.dormantWarn,
      dormantFrozen: statusBreakdown.dormantFrozen,
      dormantDeep: statusBreakdown.dormantDeep,
      activeOnce,
      activeTwice,
      reactivatedFromWarn,
      reactivatedFromFrozen,
      reactivatedFromDeep,
    },
    memberOps,
    newMembers: {
      count: newMemberCount,
      spend: Math.round(Number(newMemberSpend) * 100) / 100,
      trialFootfall,
    },
    computedAt: new Date().toISOString(),
  }

  if (elapsed > 800) {
    console.warn(`[mgmtTraffic.summary] slow: ${elapsed}ms`, { period, scopeType, scopeId })
  }
}

module.exports = { summary }
