

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')
const { validateManagementScope } = require('../utils/scope')
const { excludeDepositRefundSql } = require('../utils/consume-filter')


function lastDayOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  
  const d = new Date(Date.UTC(y, m, 0))
  const yy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}



const CACHE_TTL_MS = 5 * 60 * 1000
let CACHE = { ts: 0, data: null }


async function loadAllMarkets() {
  if (CACHE.data && Date.now() - CACHE.ts < CACHE_TTL_MS) {
    return CACHE.data
  }

  const rows = await pg.query(`
    SELECT
      m.id          AS market_id,
      m.name        AS market_name,
      s.store_id    AS store_id,
      s.store_name  AS store_name
    FROM org_nodes m
    LEFT JOIN org_nodes so
      ON so.parent_id = m.id AND so.type = '门店'
    LEFT JOIN stores s
      ON s.org_node_id = so.id AND s.is_closed = false
    WHERE m.type = '市场'
    ORDER BY m.name ASC, s.store_name ASC
  `)

  
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.market_id)) {
      map.set(r.market_id, {
        id: r.market_id,
        name: r.market_name || '',
        stores: [],
      })
    }
    if (r.store_id) {
      map.get(r.market_id).stores.push({
        storeId: r.store_id,
        storeName: r.store_name || '',
      })
    }
  }

  const markets = Array.from(map.values())

  CACHE = { ts: Date.now(), data: markets }
  return markets
}


async function scopeOptions(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const allMarkets = await loadAllMarkets()
  const { staffLevel, roleBindings } = ctx.auth

  let visible = allMarkets
  if (staffLevel === 'market') {
    const allowedMarketIds = new Set(
      (roleBindings || [])
        .filter((rb) => rb && rb.scopeType === '市场')
        .map((rb) => rb.scopeId)
    )
    visible = allMarkets.filter((m) => allowedMarketIds.has(m.id))
  } else if (staffLevel === 'store_manager') {
    
    
    const allowed = new Set(ctx.auth.managerStoreIds || [])
    visible = allMarkets
      .map((m) => ({ ...m, stores: (m.stores || []).filter((s) => allowed.has(s.storeId)) }))
      .filter((m) => m.stores.length > 0)
  }
  

  ctx.result = {
    staffLevel,
    markets: visible,
  }
}






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


function buildStaffScope(scopeType, scopeId, alias, startIdx) {
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


function timeWindow(col, mode, idx, isDateColumn) {
  const dayLeft = isDateColumn ? col : `${col}::date`
  if (mode === 'day') return `${dayLeft} = $${idx}::date`
  return `date_trunc('month', ${col}) = date_trunc('month', $${idx}::date)`
}



async function queryStoreRevenue(scopeType, scopeId, date, mode) {
  
  
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(so.received::numeric - COALESCE(so.refunded_amount, 0)::numeric), 0) AS v
       FROM sale_orders so
      WHERE ${sc.sql}
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND so.legacy_source IS DISTINCT FROM 'workfine'
        AND ${timeWindow('so.paid_at', mode, 1, false)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryShengmeiRevenue(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(si.received::numeric), 0) AS v
       FROM sale_orders so
       JOIN sale_items si ON si.sale_order_id = so.sale_order_id
      WHERE ${sc.sql}
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND si.is_shengmei = TRUE
        AND ${timeWindow('so.paid_at', mode, 1, false)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryStoreConsume(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
       JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND ${excludeDepositRefundSql('so')}
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryShengmeiConsume(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
       JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND sit.is_shengmei = TRUE
        AND ${excludeDepositRefundSql('so')}
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryFootfall(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COUNT(DISTINCT so.client_user_id) AS v
       FROM service_orders so
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryHeadcount(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM service_orders so
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryProjectCount(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sit.session_used), 0) AS v
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND sit.sales_category IN ('自销自耗', '他销自耗')
        AND ${excludeDepositRefundSql('so')}
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}







async function querySalesCommissionIncome(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sa.commission_amount::numeric), 0) AS v
       FROM sale_allocations sa
       JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
       JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE ${sc.sql}
        AND sa.is_void = FALSE
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
        AND ${timeWindow('so.paid_at', mode, 1, false)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryServiceCommissionIncome(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sc2.commission_amount::numeric), 0) AS v
       FROM service_commissions sc2
       JOIN service_items sit ON sit.service_item_id = sc2.service_item_id
       JOIN service_orders so ON so.service_order_id = sit.service_order_id
      WHERE ${sc.sql}
        AND sc2.is_void = FALSE
        AND so.status = '已完成'
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}


async function queryNewMembers(scopeType, scopeId, date, mode) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 2)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.became_member_at IS NOT NULL
        AND ${timeWindow('c.became_member_at', mode, 1, false)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}


async function queryMemberCount(scopeType, scopeId, date) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 2)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= $1::date`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}


async function queryRetainedMemberCount(scopeType, scopeId, date) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 2)
  const rows = await pg.query(
    `SELECT COUNT(DISTINCT so.client_user_id) AS v
       FROM service_orders so
       JOIN client_wechat_users c ON c.user_id = so.client_user_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND so.client_user_id IS NOT NULL
        AND so.service_date BETWEEN ($1::date - INTERVAL '90 days') AND $1::date
        AND c.became_member_at IS NOT NULL
        AND c.became_member_at::date <= $1::date`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}


async function queryEmployeeCount(scopeType, scopeId, date) {
  const sc = buildStaffScope(scopeType, scopeId, 's', 2)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM staff_wechat_users s
      WHERE ${sc.sql}
        AND s.skills && ARRAY['美容师','养生师']::text[]
        AND s.hired_at IS NOT NULL
        AND s.hired_at::date <= $1::date
        AND (s.resigned_at IS NULL OR s.resigned_at::date > $1::date)`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}


async function queryStoreCount(scopeType, scopeId, date) {
  if (scopeType === 'store') return 1
  if (scopeType === 'all') {
    const rows = await pg.query(
      `SELECT COUNT(*)::int AS cnt
         FROM stores s
         JOIN org_nodes o ON s.org_node_id = o.id
        WHERE o.type = '门店'
          AND s.opening_date IS NOT NULL
          AND s.opening_date::date <= $1::date
          AND (s.closed_at IS NULL OR s.closed_at::date > $1::date)`,
      [date],
    )
    return Number(rows[0]?.cnt || 0)
  }
  const rows = await pg.query(
    `SELECT COUNT(*)::int AS cnt
       FROM stores s
       JOIN org_nodes o ON s.org_node_id = o.id
      WHERE o.type = '门店'
        AND o.parent_id = $1
        AND s.opening_date IS NOT NULL
        AND s.opening_date::date <= $2::date
        AND (s.closed_at IS NULL OR s.closed_at::date > $2::date)`,
    [scopeId, date],
  )
  return Number(rows[0]?.cnt || 0)
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


async function summary(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { date, scopeType, scopeId } = ctx.event.payload || {}

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('INVALID_PARAMS: 日期必填，且格式为 YYYY-MM-DD')
  }
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: 范围类型必须是 全部/市场/门店')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: 范围类型为市场/门店时必须提供范围 ID')
  }

  validateManagementScope(ctx.auth, scopeType, scopeId)

  const monthEnd = lastDayOfMonth(date)

  const t0 = Date.now()
  const [
    storeRevToday, storeRevMonth,
    shengmeiRevToday, shengmeiRevMonth,
    storeConsToday, storeConsMonth,
    shengmeiConsToday, shengmeiConsMonth,
    footfallToday, footfallMonth,
    headcountToday, headcountMonth,
    newMemToday, newMemMonth,
    projectCountToday, projectCountMonth,
    salesCommissionToday, salesCommissionMonth,
    serviceCommissionToday, serviceCommissionMonth,
    memberCount, retainedMemberCount,
    employeeCountDay, storeCountDay,
    employeeCountMonth, storeCountMonth,
    scopeName,
  ] = await Promise.all([
    queryStoreRevenue(scopeType, scopeId, date, 'day'),
    queryStoreRevenue(scopeType, scopeId, date, 'month'),
    queryShengmeiRevenue(scopeType, scopeId, date, 'day'),
    queryShengmeiRevenue(scopeType, scopeId, date, 'month'),
    queryStoreConsume(scopeType, scopeId, date, 'day'),
    queryStoreConsume(scopeType, scopeId, date, 'month'),
    queryShengmeiConsume(scopeType, scopeId, date, 'day'),
    queryShengmeiConsume(scopeType, scopeId, date, 'month'),
    queryFootfall(scopeType, scopeId, date, 'day'),
    queryFootfall(scopeType, scopeId, date, 'month'),
    queryHeadcount(scopeType, scopeId, date, 'day'),
    queryHeadcount(scopeType, scopeId, date, 'month'),
    queryNewMembers(scopeType, scopeId, date, 'day'),
    queryNewMembers(scopeType, scopeId, date, 'month'),
    queryProjectCount(scopeType, scopeId, date, 'day'),
    queryProjectCount(scopeType, scopeId, date, 'month'),
    querySalesCommissionIncome(scopeType, scopeId, date, 'day'),
    querySalesCommissionIncome(scopeType, scopeId, date, 'month'),
    queryServiceCommissionIncome(scopeType, scopeId, date, 'day'),
    queryServiceCommissionIncome(scopeType, scopeId, date, 'month'),
    queryMemberCount(scopeType, scopeId, date),
    queryRetainedMemberCount(scopeType, scopeId, date),
    queryEmployeeCount(scopeType, scopeId, date),     
    queryStoreCount(scopeType, scopeId, date),         
    queryEmployeeCount(scopeType, scopeId, monthEnd),  
    queryStoreCount(scopeType, scopeId, monthEnd),     
    resolveScopeName(scopeType, scopeId),
  ])
  const elapsed = Date.now() - t0

  const round2 = (v) => Math.round(Number(v) * 100) / 100
  
  const avg = (m) => (storeCountMonth > 0 ? round2(m / storeCountMonth) : 0)

  ctx.result = {
    date,
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    storeRevenue: {
      today: round2(storeRevToday),
      month: round2(storeRevMonth),
      monthlyAvgPerStore: avg(storeRevMonth),
    },
    shengmeiRevenue: {
      today: round2(shengmeiRevToday),
      month: round2(shengmeiRevMonth),
      monthlyAvgPerStore: avg(shengmeiRevMonth),
    },
    storeConsume: {
      today: round2(storeConsToday),
      month: round2(storeConsMonth),
      monthlyAvgPerStore: avg(storeConsMonth),
    },
    shengmeiConsume: {
      today: round2(shengmeiConsToday),
      month: round2(shengmeiConsMonth),
      monthlyAvgPerStore: avg(shengmeiConsMonth),
    },
    footfall: { today: Number(footfallToday), month: Number(footfallMonth) },
    headcount: { today: Number(headcountToday), month: Number(headcountMonth) },
    newMembers: { today: Number(newMemToday), month: Number(newMemMonth) },
    projectCount: { today: Number(projectCountToday), month: Number(projectCountMonth) },
    salesCommissionIncome: {
      today: round2(salesCommissionToday),
      month: round2(salesCommissionMonth),
    },
    serviceCommissionIncome: {
      today: round2(serviceCommissionToday),
      month: round2(serviceCommissionMonth),
    },
    
    storeCount: { day: storeCountDay, month: storeCountMonth },
    employeeCount: { day: employeeCountDay, month: employeeCountMonth },
    memberCount,
    retainedMemberCount,
    computedAt: new Date().toISOString(),
  }

  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.summary] slow query: ${elapsed}ms`, { scopeType, scopeId, date })
  }
}






function timeWindowPeriod(col, period, _isDateColumn) {
  if (period === 'month') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date)`
  }
  if (period === 'lastMonth') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date - INTERVAL '1 month')`
  }
  
  return `date_trunc('year', ${col}) = date_trunc('year', NOW()::date)`
}


function getRefDateExpr(period) {
  if (period === 'lastMonth') {
    return `(date_trunc('month', NOW()::date) - INTERVAL '1 day')::date`
  }
  return `NOW()::date`
}

function getSalesDataPeriod(period) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const d = now.getDate()
  const p = (v) => String(v).padStart(2, '0')
  const today = `${y}-${p(m)}-${p(d)}`
  if (period === 'month') {
    return { startDate: `${y}-${p(m)}-01`, endDate: today }
  }
  if (period === 'lastMonth') {
    const lmY = m === 1 ? y - 1 : y
    const lmM = m === 1 ? 12 : m - 1
    const lastDay = new Date(Date.UTC(lmY, lmM, 0)).getUTCDate()
    return { startDate: `${lmY}-${p(lmM)}-01`, endDate: `${lmY}-${p(lmM)}-${p(lastDay)}` }
  }
  return { startDate: `${y}-01-01`, endDate: today }
}


function getVisibleStoreIds(auth) {
  if (auth.staffLevel === 'headquarters') return null
  
  
  if (auth.staffLevel === 'store_manager') return auth.managerStoreIds || []
  return auth.scopeStoreIds || []
}


function buildStoreFilter(visibleStoreIds, alias, startIdx) {
  if (!visibleStoreIds) return { sql: 'TRUE', params: [] }
  if (visibleStoreIds.length === 0) {
    return { sql: 'FALSE', params: [] }
  }
  return {
    sql: `${alias}.store_id = ANY($${startIdx}::text[])`,
    params: [visibleStoreIds],
  }
}


function assignRanks(rows) {
  let rank = 0
  let lastValue = null
  rows.forEach((row, idx) => {
    if (row.value !== lastValue) {
      rank = idx + 1
      lastValue = row.value
    }
    row.rank = rank
  })
  return rows
}



async function rankingRevenue(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COALESCE(SUM(so.received::numeric - COALESCE(so.refunded_amount, 0)::numeric), 0) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN sale_orders so
       ON so.store_id = s.store_id
       AND so.sale_order_type IN ('销售单', '转换单')
       AND so.status = '已支付'
       AND so.legacy_source IS DISTINCT FROM 'workfine'
       AND ${timeWindowPeriod('so.paid_at', period, false)}
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

async function rankingConsume(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN service_orders so2
       ON so2.store_id = s.store_id
       AND so2.status = '已完成'
       AND ${timeWindowPeriod('so2.service_date', period, true)}
       AND ${excludeDepositRefundSql('so2')}
     LEFT JOIN service_items sit ON sit.service_order_id = so2.service_order_id
     LEFT JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

async function rankingRetainedMember(period, storeFilter) {
  const refDate = getRefDateExpr(period)
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COUNT(DISTINCT c.user_id) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN client_wechat_users c
       ON c.bound_store_id = s.store_id
       AND c.became_member_at IS NOT NULL
       AND c.became_member_at::date <= ${refDate}
       AND EXISTS (
         SELECT 1 FROM service_orders so
         WHERE so.client_user_id = c.user_id
           AND so.status = '已完成'
           AND so.service_date BETWEEN (${refDate} - INTERVAL '90 days') AND ${refDate}
       )
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}


async function rankingNewMember(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COUNT(c.user_id) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN client_wechat_users c
       ON c.bound_store_id = s.store_id
       AND c.became_member_at IS NOT NULL
       AND ${timeWindowPeriod('c.became_member_at', period, false)}
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

async function rankingProjectCount(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COALESCE(SUM(sit.session_used), 0) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN service_orders so2
       ON so2.store_id = s.store_id
       AND so2.status = '已完成'
       AND ${timeWindowPeriod('so2.service_date', period, true)}
       AND ${excludeDepositRefundSql('so2')}
     LEFT JOIN service_items sit
       ON sit.service_order_id = so2.service_order_id
       AND sit.sales_category IN ('自销自耗', '他销自耗')
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

async function rankingFootfall(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COUNT(DISTINCT so2.client_user_id) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN service_orders so2
       ON so2.store_id = s.store_id
       AND so2.status = '已完成'
       AND so2.client_user_id IS NOT NULL
       AND ${timeWindowPeriod('so2.service_date', period, true)}
     WHERE ${storeFilter.sql}
     GROUP BY s.store_id, s.store_name, o.name
     ORDER BY value DESC, s.store_name ASC`,
    storeFilter.params,
  )
}

const METRIC_DISPATCH = {
  revenue: rankingRevenue,
  consume: rankingConsume,
  retainedMember: rankingRetainedMember,
  newMember: rankingNewMember,
  projectCount: rankingProjectCount,
  footfall: rankingFootfall,
}

const VALID_PERIODS = ['month', 'lastMonth', 'year']
const VALID_METRICS = ['revenue', 'consume', 'retainedMember', 'newMember', 'projectCount', 'footfall']


const PERIOD_CN = '本月/上月/本年'
const METRIC_CN = '业绩/实耗/留存会员/新会员/项目数/客流'
const STAFF_METRIC_CN = '业绩/实耗/新会员/客流/项目数/收入'
const SCOPE_TYPE_CN = '全部/市场/门店'


async function storeRanking(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, metric } = ctx.event.payload || {}

  if (!VALID_PERIODS.includes(period)) {
    throw new Error('INVALID_PARAMS: 时间维度必须是 ' + PERIOD_CN)
  }
  if (!VALID_METRICS.includes(metric)) {
    throw new Error('INVALID_PARAMS: 指标必须是 ' + METRIC_CN)
  }

  const visibleStoreIds = getVisibleStoreIds(ctx.auth)
  const storeFilter = buildStoreFilter(visibleStoreIds, 's', 1)

  const t0 = Date.now()
  const rawRows = await METRIC_DISPATCH[metric](period, storeFilter)
  const elapsed = Date.now() - t0

  const unit = (metric === 'revenue' || metric === 'consume') ? 'amount' : 'count'
  const rows = assignRanks(
    rawRows.map((r) => ({
      storeId: r.store_id,
      storeName: r.store_name,
      marketName: r.market_name,
      value: Number(r.value || 0),
    })),
  )

  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.storeRanking] slow: ${elapsed}ms`, { period, metric })
  }

  ctx.result = {
    period,
    metric,
    unit,
    rows,
    computedAt: new Date().toISOString(),
  }
}



















function producerEmployeesCte(storeFilter) {
  return `WITH producer_employees AS (
  SELECT
    sw.employee_id,
    sw.name        AS employee_name,
    sw.store_id,
    s.store_name
  FROM staff_wechat_users sw
  LEFT JOIN stores s ON s.store_id = sw.store_id
  WHERE sw.hired_at IS NOT NULL
    AND sw.hired_at::date <= NOW()::date
    AND (sw.resigned_at IS NULL OR sw.resigned_at::date > NOW()::date)
    AND ${storeFilter.sql}
)`
}

const STAFF_ORDER_BY = `ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC`



async function staffRankingRevenue(period, storeFilter) {
  return pg.query(
    `${producerEmployeesCte(storeFilter)},
revenue_by_emp AS (
  SELECT
    sa.employee_id,
    COALESCE(SUM(sa.total_amount::numeric), 0) AS v
  FROM sale_allocations sa
  JOIN sale_items si  ON si.sale_item_id  = sa.sale_item_id
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  WHERE sa.is_void = FALSE
    AND sa.role_type IN ('美容师','养生师')
    AND so.sale_order_type IN ('销售单','转换单')
    AND so.status = '已支付'
    AND ${timeWindowPeriod('so.paid_at', period, false)}
  GROUP BY sa.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(r.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN revenue_by_emp r ON r.employee_id = pe.employee_id
WHERE COALESCE(r.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

async function staffRankingConsume(period, storeFilter) {
  return pg.query(
    `${producerEmployeesCte(storeFilter)},
consume_by_emp AS (
  SELECT
    sit.employee_id,
    COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
  FROM service_items sit
  JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
  JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
  WHERE so2.status = '已完成'
    AND ${timeWindowPeriod('so2.service_date', period, true)}
    AND ${excludeDepositRefundSql('so2')}
  GROUP BY sit.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(c.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN consume_by_emp c ON c.employee_id = pe.employee_id
WHERE COALESCE(c.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}


async function staffRankingNewMember(period, storeFilter) {
  return pg.query(
    `${producerEmployeesCte(storeFilter)},
new_member_by_emp AS (
  SELECT
    c.bound_employee_id AS employee_id,
    COUNT(*) AS v
  FROM client_wechat_users c
  WHERE c.bound_employee_id IS NOT NULL
    AND c.became_member_at IS NOT NULL
    AND ${timeWindowPeriod('c.became_member_at', period, false)}
  GROUP BY c.bound_employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(n.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN new_member_by_emp n ON n.employee_id = pe.employee_id
WHERE COALESCE(n.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

async function staffRankingFootfall(period, storeFilter) {
  return pg.query(
    `${producerEmployeesCte(storeFilter)},
footfall_by_emp AS (
  SELECT
    sit.employee_id,
    COUNT(DISTINCT so2.client_user_id) AS v
  FROM service_items sit
  JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
  WHERE so2.status = '已完成'
    AND so2.client_user_id IS NOT NULL
    AND ${timeWindowPeriod('so2.service_date', period, true)}
  GROUP BY sit.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(f.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN footfall_by_emp f ON f.employee_id = pe.employee_id
WHERE COALESCE(f.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

async function staffRankingProjectCount(period, storeFilter) {
  return pg.query(
    `${producerEmployeesCte(storeFilter)},
project_by_emp AS (
  SELECT
    sit.employee_id,
    COALESCE(SUM(sit.session_used), 0) AS v
  FROM service_items sit
  JOIN service_orders so2 ON so2.service_order_id = sit.service_order_id
  WHERE so2.status = '已完成'
    AND sit.sales_category IN ('自销自耗','他销自耗')
    AND ${timeWindowPeriod('so2.service_date', period, true)}
    AND ${excludeDepositRefundSql('so2')}
  GROUP BY sit.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  COALESCE(p.v, 0)::numeric AS value
FROM producer_employees pe
LEFT JOIN project_by_emp p ON p.employee_id = pe.employee_id
WHERE COALESCE(p.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}


async function staffRankingIncome(period, storeFilter) {
  return pg.query(
    `${producerEmployeesCte(storeFilter)},
sales_comm AS (
  SELECT
    sa.employee_id,
    COALESCE(SUM(sa.commission_amount::numeric), 0) AS v
  FROM sale_allocations sa
  JOIN sale_items si  ON si.sale_item_id  = sa.sale_item_id
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  WHERE sa.is_void = FALSE
    AND so.sale_order_type IN ('销售单','转换单')
    AND so.status = '已支付'
    AND ${timeWindowPeriod('so.paid_at', period, false)}
  GROUP BY sa.employee_id
),
service_comm AS (
  SELECT
    sc.employee_id,
    COALESCE(SUM(sc.commission_amount::numeric), 0) AS v
  FROM service_commissions sc
  JOIN service_items sit  ON sit.service_item_id   = sc.service_item_id
  JOIN service_orders so2 ON so2.service_order_id  = sit.service_order_id
  WHERE sc.is_void = FALSE
    AND so2.status = '已完成'
    AND ${timeWindowPeriod('so2.service_date', period, true)}
  GROUP BY sc.employee_id
)
SELECT
  pe.employee_id,
  pe.employee_name,
  pe.store_id,
  pe.store_name,
  (COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0))::numeric AS value
FROM producer_employees pe
LEFT JOIN sales_comm   sc1 ON sc1.employee_id = pe.employee_id
LEFT JOIN service_comm sc2 ON sc2.employee_id = pe.employee_id
WHERE COALESCE(sc1.v, 0) + COALESCE(sc2.v, 0) > 0
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

const STAFF_METRIC_DISPATCH = {
  revenue:      staffRankingRevenue,
  consume:      staffRankingConsume,
  newMember:    staffRankingNewMember,
  footfall:     staffRankingFootfall,
  projectCount: staffRankingProjectCount,
  income:       staffRankingIncome,
}

const VALID_STAFF_METRICS = ['revenue', 'consume', 'newMember', 'footfall', 'projectCount', 'income']


async function staffRanking(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, metric } = ctx.event.payload || {}

  if (!VALID_PERIODS.includes(period)) {
    throw new Error('INVALID_PARAMS: 时间维度必须是 ' + PERIOD_CN)
  }
  if (!VALID_STAFF_METRICS.includes(metric)) {
    throw new Error('INVALID_PARAMS: 指标必须是 ' + STAFF_METRIC_CN)
  }

  const visibleStoreIds = getVisibleStoreIds(ctx.auth)
  
  const storeFilter = buildStoreFilter(visibleStoreIds, 'sw', 1)

  const t0 = Date.now()
  const rawRows = await STAFF_METRIC_DISPATCH[metric](period, storeFilter)
  const elapsed = Date.now() - t0

  const unit = (metric === 'revenue' || metric === 'consume' || metric === 'income') ? 'amount' : 'count'
  const rows = assignRanks(
    rawRows.map((r) => ({
      employeeId:   r.employee_id,
      employeeName: r.employee_name || '',
      storeId:      r.store_id || null,
      storeName:    r.store_name || '',
      value:        Number(r.value || 0),
    })),
  )

  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.staffRanking] slow: ${elapsed}ms`, { period, metric })
  }

  ctx.result = {
    period,
    metric,
    unit,
    rows,
    computedAt: new Date().toISOString(),
  }
}







const SALES_CATEGORY_SKELETON = ['自销自耗', '他销自耗', '他销他耗', '生态合作']


async function salesData(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, scope } = ctx.event.payload || {}
  const scopeType = scope?.type
  const scopeId = scope?.id || null

  if (!['month', 'lastMonth', 'year'].includes(period)) {
    throw new Error('INVALID_PARAMS: 时间维度必须是 ' + PERIOD_CN)
  }
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: 范围类型必须是 ' + SCOPE_TYPE_CN)
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: 范围类型为市场/门店时必须提供范围 ID')
  }

  validateManagementScope(ctx.auth, scopeType, scopeId)

  const { startDate, endDate } = getSalesDataPeriod(period)
  const fmt = (v) => parseFloat(v || 0).toFixed(2)

  
  const scSale = buildSaleScope(scopeType, scopeId, 'o', 3)
  const scSvc = buildSaleScope(scopeType, scopeId, 'so', 3)
  const saleP = [startDate, endDate, ...scSale.params]
  const svcP = [startDate, endDate, ...scSvc.params]

  const t0 = Date.now()
  const [revRows, custRevRows, consRows, custConsRows, prodOutRows, catRows, kindRows, nameRows, skeletonRows] =
    await Promise.all([
      
      pg.query(
        `SELECT COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric), 0) AS v
           FROM sale_orders o
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND o.legacy_source IS DISTINCT FROM 'workfine'
            AND o.paid_at::date BETWEEN $1 AND $2`,
        saleP,
      ),
      
      
      
      
      pg.query(
        `SELECT
            COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric) FILTER (
              WHERE c.customer_type = '小美客'
            ), 0) AS xiaomei,
            COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date >= $1
            ), 0) AS new_member,
            COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date < $1
            ), 0) AS old_member
           FROM sale_orders o
           JOIN client_wechat_users c ON c.user_id = o.client_user_id
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND o.legacy_source IS DISTINCT FROM 'workfine'
            AND o.paid_at::date BETWEEN $1 AND $2`,
        saleP,
      ),
      
      pg.query(
        `SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
           FROM service_items sit
           JOIN service_orders so ON so.service_order_id = sit.service_order_id
           JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
          WHERE ${scSvc.sql}
            AND so.status = '已完成'
            AND so.service_date BETWEEN $1 AND $2
            AND ${excludeDepositRefundSql('so')}`,
        svcP,
      ),
      
      pg.query(
        `SELECT
            COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
              WHERE c.customer_type = '小美客'
            ), 0) AS xiaomei,
            COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date >= $1
            ), 0) AS new_member,
            COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date < $1
            ), 0) AS old_member
           FROM service_items sit
           JOIN service_orders so ON so.service_order_id = sit.service_order_id
           JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
           JOIN client_wechat_users c ON c.user_id = so.client_user_id
          WHERE ${scSvc.sql}
            AND so.status = '已完成'
            AND so.service_date BETWEEN $1 AND $2
            AND ${excludeDepositRefundSql('so')}`,
        svcP,
      ),
      
      pg.query(
        `SELECT
            COALESCE(SUM(si.received::numeric) FILTER (
              WHERE c.customer_type = '小美客'
            ), 0) AS xiaomei,
            COALESCE(SUM(si.received::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date >= $1
            ), 0) AS new_member,
            COALESCE(SUM(si.received::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND COALESCE(c.became_member_at, '1970-01-01'::timestamptz)::date < $1
            ), 0) AS old_member
           FROM sale_items si
           JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
           JOIN client_wechat_users c ON c.user_id = o.client_user_id
          WHERE ${scSale.sql}
            AND si.product_type = '家居产品'
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND o.paid_at::date BETWEEN $1 AND $2`,
        saleP,
      ),
      
      pg.query(
        `SELECT si.sales_category AS label,
                COALESCE(SUM(si.received::numeric), 0) AS value
           FROM sale_items si
           JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND o.paid_at::date BETWEEN $1 AND $2
            AND si.sales_category IS NOT NULL
          GROUP BY si.sales_category
          ORDER BY value DESC`,
        saleP,
      ),
      
      pg.query(
        `SELECT pc.product_kind AS label,
                COALESCE(SUM(si.received::numeric), 0) AS value
           FROM sale_items si
           JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
           JOIN product_skus sk ON sk.sku_id = si.sku_id
           JOIN product_categories pc ON pc.category_id = sk.category_id
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND o.paid_at::date BETWEEN $1 AND $2
            AND pc.product_kind IS NOT NULL
          GROUP BY pc.product_kind
          ORDER BY value DESC`,
        saleP,
      ),
      
      pg.query(
        `SELECT pc.product_kind AS kind,
                pc.category_name AS label,
                COALESCE(SUM(si.received::numeric), 0) AS value
           FROM sale_items si
           JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
           JOIN product_skus sk ON sk.sku_id = si.sku_id
           JOIN product_categories pc ON pc.category_id = sk.category_id
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND o.paid_at::date BETWEEN $1 AND $2
            AND pc.product_kind IS NOT NULL
            AND pc.category_name IS NOT NULL
          GROUP BY pc.product_kind, pc.category_name`,
        saleP,
      ),
      
      pg.query(
        `SELECT product_kind, category_name
           FROM product_categories
          WHERE product_kind IS NOT NULL
            AND category_name IS NOT NULL
          ORDER BY product_kind, category_name`,
        [],
      ),
    ])

  const elapsed = Date.now() - t0

  const fmtPct = (num, denom) => {
    const d = parseFloat(denom || 0)
    if (d === 0) return '—'
    return ((parseFloat(num || 0) / d) * 100).toFixed(2) + '%'
  }
  const cmpDescByValueAscByLabel = (a, b) => {
    const dv = parseFloat(b.value) - parseFloat(a.value)
    return dv !== 0 ? dv : a.label.localeCompare(b.label, 'zh-Hans-CN')
  }

  
  const catMap = new Map(catRows.map((r) => [r.label, r.value]))
  const salesCategoryTotal = Array.from(catMap.values())
    .reduce((s, v) => s + parseFloat(v || 0), 0)
  const bySalesCategory = SALES_CATEGORY_SKELETON.map((lbl) => {
    const v = catMap.get(lbl) || 0
    return { label: lbl, value: fmt(v), ratio: fmtPct(v, salesCategoryTotal) }
  })

  
  const kindTotalMap = new Map(kindRows.map((r) => [r.label, r.value]))
  const leafValueMap = new Map() 
  for (const r of nameRows) {
    leafValueMap.set(`${r.kind}::${r.label}`, r.value)
  }

  
  const productKindTotal = kindRows
    .reduce((s, r) => s + parseFloat(r.value || 0), 0)

  
  const groupBuilder = new Map() 
  for (const sk of skeletonRows) {
    if (!groupBuilder.has(sk.product_kind)) {
      groupBuilder.set(sk.product_kind, { children: [] })
    }
    const v = leafValueMap.get(`${sk.product_kind}::${sk.category_name}`) || 0
    groupBuilder.get(sk.product_kind).children.push({
      label: sk.category_name,
      value: fmt(v),
      ratio: fmtPct(v, productKindTotal),
    })
  }

  
  const byProductKind = Array.from(groupBuilder.entries())
    .map(([kind, { children }]) => {
      const kv = kindTotalMap.get(kind) || 0
      return {
        label: kind,
        value: fmt(kv),
        ratio: fmtPct(kv, productKindTotal),
        children: children.sort(cmpDescByValueAscByLabel),
      }
    })
    .sort(cmpDescByValueAscByLabel)

  ctx.result = {
    totalRevenue: fmt(revRows[0]?.v),
    xiaomeiRevenue: fmt(custRevRows[0]?.xiaomei),
    newMemberRevenue: fmt(custRevRows[0]?.new_member),
    oldMemberRevenue: fmt(custRevRows[0]?.old_member),
    totalConsume: fmt(consRows[0]?.v),
    xiaomeiProjectConsume: fmt(custConsRows[0]?.xiaomei),
    newMemberProjectConsume: fmt(custConsRows[0]?.new_member),
    oldMemberProjectConsume: fmt(custConsRows[0]?.old_member),
    xiaomeiProductOut: fmt(prodOutRows[0]?.xiaomei),
    newMemberProductOut: fmt(prodOutRows[0]?.new_member),
    oldMemberProductOut: fmt(prodOutRows[0]?.old_member),
    bySalesCategory,
    byProductKind,
  }

  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.salesData] slow: ${elapsed}ms`, { period, scopeType, scopeId })
  }
}


function __resetMarketsCache() {
  CACHE = { ts: 0, data: null }
}

module.exports = { scopeOptions, summary, storeRanking, staffRanking, salesData, __resetMarketsCache }
