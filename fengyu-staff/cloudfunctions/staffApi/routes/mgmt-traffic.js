

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')
const { validateManagementScope } = require('../utils/scope')
const { excludeDepositRefundSql } = require('../utils/consume-filter')

const VALID_PERIODS = ['month', 'lastMonth', 'year']




function buildSaleScope(scopeType, scopeId, alias, startIdx) {
  if (scopeType === 'all') return { sql: 'TRUE', params: [] }
  if (scopeType === 'store') {
    return { sql: `${alias}.store_id = $${startIdx}`, params: [scopeId] }
  }
  return {
    sql:
      `${alias}.store_id IN (` +
      `SELECT s.store_id FROM stores s ` +
      `JOIN org_nodes o ON s.org_node_id = o.id ` +
      `WHERE o.parent_id = $${startIdx} AND o.type = '门店')`,
    params: [scopeId],
  }
}


function buildClientScope(scopeType, scopeId, alias, startIdx) {
  if (scopeType === 'all') return { sql: 'TRUE', params: [] }
  if (scopeType === 'store') {
    return { sql: `${alias}.bound_store_id = $${startIdx}`, params: [scopeId] }
  }
  return {
    sql:
      `${alias}.bound_store_id IN (` +
      `SELECT s.store_id FROM stores s ` +
      `JOIN org_nodes o ON s.org_node_id = o.id ` +
      `WHERE o.parent_id = $${startIdx} AND o.type = '门店')`,
    params: [scopeId],
  }
}


function resolvePeriodRange(period) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() 
  const d = now.getDate()
  const fmt = (yy, mm, dd) =>
    `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`

  if (period === 'month') {
    return { startDate: fmt(y, m, 1), endDate: fmt(y, m, d) }
  }
  if (period === 'lastMonth') {
    const startY = m === 0 ? y - 1 : y
    const startM = m === 0 ? 11 : m - 1
    
    const endDay = new Date(y, m, 0)
    return {
      startDate: fmt(startY, startM, 1),
      endDate: fmt(endDay.getFullYear(), endDay.getMonth(), endDay.getDate()),
    }
  }
  
  return { startDate: fmt(y, 0, 1), endDate: fmt(y, m, d) }
}


function endDateExpr(period) {
  if (period === 'lastMonth') {
    return `(date_trunc('month', NOW()) - INTERVAL '1 day')::date`
  }
  return `NOW()::date`
}


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





async function querySingleRegistration(scopeType, scopeId, period, customerType) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 1)

  
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





const TRAFFIC_TYPES = [
  { type: 'total', label: '总', customerType: null },
  { type: 'trial', label: '体验客', customerType: '体验客' },
  { type: 'xiaomei', label: '小美客', customerType: '小美客' },
  { type: 'member', label: '会员客', customerType: '会员客' },
]


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






async function queryStatusBreakdown(scopeType, scopeId) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 1)
  
  const normalRows = await pg.query(
    `SELECT c.customer_status AS s, COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.customer_status IN ('保有会员-稳定', '保有会员-有效', '冰冻', '休眠')
      GROUP BY c.customer_status`,
    sc.params,
  )
  
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


async function queryActiveOnce(scopeType, scopeId, period) {
  const ssc = buildSaleScope(scopeType, scopeId, 'so', 1)
  const csc = buildClientScope(scopeType, scopeId, 'c', 1 + ssc.params.length)
  const rows = await pg.query(
    `WITH visit_count AS (
       SELECT so.client_user_id, COUNT(*) AS n
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
        AND vc.n = 1`,
    [...ssc.params, ...csc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryActiveTwice(scopeType, scopeId, period) {
  const ssc = buildSaleScope(scopeType, scopeId, 'so', 1)
  const csc = buildClientScope(scopeType, scopeId, 'c', 1 + ssc.params.length)
  const rows = await pg.query(
    `WITH visit_count AS (
       SELECT so.client_user_id, COUNT(*) AS n
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
        AND vc.n >= 2`,
    [...ssc.params, ...csc.params],
  )
  return Number(rows[0]?.v || 0)
}


async function queryReactivated(scopeType, scopeId, period, startDate, bucket) {
  const ssc = buildSaleScope(scopeType, scopeId, 'so', 2) 
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





async function queryMemberOps(scopeType, scopeId, period) {
  const sc = buildSaleScope(scopeType, scopeId, 'o', 1)
  const rows = await pg.query(
    `WITH member_spend AS (
       SELECT o.client_user_id,
              SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric) AS spend
         FROM sale_orders o
         JOIN client_wechat_users c ON c.user_id = o.client_user_id
        WHERE ${sc.sql}
          AND o.sale_order_type IN ('销售单', '转换单')
          AND o.status = '已支付'
          AND o.legacy_source IS DISTINCT FROM 'workfine'
          AND o.paid_at::date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
          AND c.customer_type = '会员客'
        GROUP BY o.client_user_id
     )
     SELECT
       COUNT(*) FILTER (WHERE spend < 1990) AS bucket1_count,
       COALESCE(SUM(spend) FILTER (WHERE spend < 1990), 0) AS bucket1_spend,
       COUNT(*) FILTER (WHERE spend >= 1990 AND spend < 10000) AS bucket2_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= 1990 AND spend < 10000), 0) AS bucket2_spend,
       COUNT(*) FILTER (WHERE spend >= 10000 AND spend < 30000) AS bucket3_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= 10000 AND spend < 30000), 0) AS bucket3_spend,
       COUNT(*) FILTER (WHERE spend >= 30000 AND spend < 60000) AS bucket4_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= 30000 AND spend < 60000), 0) AS bucket4_spend,
       COUNT(*) FILTER (WHERE spend >= 60000 AND spend < 100000) AS bucket5_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= 60000 AND spend < 100000), 0) AS bucket5_spend,
       COUNT(*) FILTER (WHERE spend >= 100000) AS bucket6_count,
       COALESCE(SUM(spend) FILTER (WHERE spend >= 100000), 0) AS bucket6_spend,
       COALESCE(SUM(spend), 0) AS total_spend,
       COUNT(*) AS total_count
     FROM member_spend`,
    sc.params,
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
    `SELECT COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric), 0) AS v
       FROM sale_orders o
       JOIN client_wechat_users c ON c.user_id = o.client_user_id
      WHERE ${sc.sql}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
        AND o.sale_order_type IN ('销售单', '转换单')
        AND o.status = '已支付'
        AND o.legacy_source IS DISTINCT FROM 'workfine'
        AND o.paid_at::date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}`,
    sc.params,
  )
  return Number(rows[0]?.v || 0)
}

async function queryTrialFootfall(scopeType, scopeId, period) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 1)
  const rows = await pg.query(
    `SELECT COUNT(DISTINCT so.client_user_id) AS v
       FROM service_orders so
       JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND so.service_date BETWEEN ${startDateExpr(period)} AND ${endDateExpr(period)}
        AND c.customer_type IN ('体验客', '小美客')`,
    sc.params,
  )
  return Number(rows[0]?.v || 0)
}





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
