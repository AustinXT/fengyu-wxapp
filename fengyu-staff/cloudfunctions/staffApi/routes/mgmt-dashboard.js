/**
 * 管理层数据中心模块路由（员工端）
 *
 * mgmtDashboard.scopeOptions — 市场/门店二级筛选器数据源
 *   - HQ 账号：返回所有市场及其下属门店
 *   - market 账号：仅返回 roleBindings 中 scopeType='市场' 对应的市场
 *   - 5 分钟内存缓存全量 markets，每次请求按 ctx.auth 过滤后返回
 *
 * mgmtDashboard.summary — 数据中心首页 8 卡片汇总
 *   一次返回 4 张大卡（业绩/实耗，含月店均）+ 4 张小卡（客流/客量/新会员/项目数）
 *   口径定义：notes/references/metrics.md
 */

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')

// 模块级缓存：存放 HQ 全量 markets 列表（按账号过滤前的视图）
// 不同账号每次请求基于此缓存按 staffLevel + roleBindings 派生自己的视图
const CACHE_TTL_MS = 5 * 60 * 1000
let CACHE = { ts: 0, data: null }

/**
 * 加载 HQ 全量 markets 列表（带 5 分钟内存缓存）
 * @returns {Promise<Array<{id: string, name: string, stores: Array<{storeId: string, storeName: string}>}>>}
 */
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

  // 聚合为 markets[].stores[] 结构
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

/**
 * mgmtDashboard.scopeOptions
 * 入参：无（按账号权限自动过滤）
 * 出参：
 *   {
 *     staffLevel: 'headquarters' | 'market',
 *     markets: [{ id, name, stores: [{ storeId, storeName }] }, ...]
 *   }
 */
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
  }
  // headquarters 走全量；其它分支由 requireManagementLevel 拦截

  ctx.result = {
    staffLevel,
    markets: visible,
  }
}

// =====================================================================
// summary —— 8 卡片汇总
// =====================================================================

/**
 * 校验请求 scope 是否在账号权限内
 * - headquarters：放行所有 scopeType
 * - market：禁 'all'；'market' 必须命中 roleBindings 的 scopeId；'store' 必须在 scopeStoreIds 内
 */
function validateScope(auth, scopeType, scopeId) {
  if (auth.staffLevel === 'headquarters') return

  if (auth.staffLevel === 'market') {
    if (scopeType === 'all') {
      throw new Error('PERMISSION_DENIED: 市场账号不允许查看全部市场数据')
    }
    if (scopeType === 'market') {
      const allowed = (auth.roleBindings || [])
        .filter((rb) => rb && rb.scopeType === '市场')
        .map((rb) => rb.scopeId)
      if (!allowed.includes(scopeId)) {
        throw new Error('PERMISSION_DENIED: 越权访问其他市场数据')
      }
      return
    }
    if (scopeType === 'store') {
      const allowed = auth.scopeStoreIds || []
      if (!allowed.includes(scopeId)) {
        throw new Error('PERMISSION_DENIED: 越权访问其他门店数据')
      }
      return
    }
  }
}

/**
 * 构造 sale/service 表的 store_id scope 过滤片段
 * @param {string} scopeType
 * @param {string} scopeId
 * @param {string} alias 表别名（默认 'so'）
 * @param {number} startIdx 起始 $n 下标
 */
function buildSaleScope(scopeType, scopeId, alias, startIdx) {
  if (scopeType === 'all') return { sql: 'TRUE', params: [] }
  if (scopeType === 'store') {
    return { sql: `${alias}.store_id = $${startIdx}`, params: [scopeId] }
  }
  // market：走 stores JOIN org_nodes 子查询，与 scope.js 现有口径一致
  return {
    sql:
      `${alias}.store_id IN (` +
      `SELECT s.store_id FROM stores s ` +
      `JOIN org_nodes o ON s.org_node_id = o.id ` +
      `WHERE o.parent_id = $${startIdx} AND o.type = '门店')`,
    params: [scopeId],
  }
}

/** client_wechat_users.bound_store_id scope */
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

/** staff_wechat_users.store_id scope */
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

/**
 * 时间窗口 SQL 片段
 * @param {string} col 列引用
 * @param {'day'|'month'} mode
 * @param {number} idx $n 下标（指向 date 参数）
 * @param {boolean} isDateColumn col 本身是 date 类型则不必再 ::date
 */
function timeWindow(col, mode, idx, isDateColumn) {
  const dayLeft = isDateColumn ? col : `${col}::date`
  if (mode === 'day') return `${dayLeft} = $${idx}::date`
  return `date_trunc('month', ${col}) = date_trunc('month', $${idx}::date)`
}

/* ----- 7 个指标查询 ----- */

async function queryStoreRevenue(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(so.paid_amount::numeric), 0) AS v
       FROM sale_orders so
      WHERE ${sc.sql}
        AND so.sale_order_type IN ('销售单', '转换单')
        AND so.status = '已支付'
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
      WHERE ${sc.sql}
        AND so.status = '已完成'
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
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND sit.is_shengmei = TRUE
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

async function queryNewMembers(scopeType, scopeId, date, mode) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 2)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.old_member_level IS NULL
        AND c.member_level IS NOT NULL
        AND ${timeWindow('c.member_level_upgraded_at', mode, 1, false)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function queryMemberCount(scopeType, scopeId) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 1)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.customer_type = '会员客'`,
    sc.params,
  )
  return Number(rows[0]?.v || 0)
}

async function queryRetainedMemberCount(scopeType, scopeId) {
  const sc = buildClientScope(scopeType, scopeId, 'c', 1)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM client_wechat_users c
      WHERE ${sc.sql}
        AND c.customer_status IN ('保有会员-稳定', '保有会员-有效')`,
    sc.params,
  )
  return Number(rows[0]?.v || 0)
}

async function queryEmployeeCount(scopeType, scopeId) {
  const sc = buildStaffScope(scopeType, scopeId, 's', 1)
  const rows = await pg.query(
    `SELECT COUNT(*) AS v
       FROM staff_wechat_users s
      WHERE ${sc.sql}
        AND s.is_resigned = FALSE
        AND s.skills && ARRAY['美容师','养生师']::text[]`,
    sc.params,
  )
  return Number(rows[0]?.v || 0)
}

async function queryStoreCount(scopeType, scopeId) {
  if (scopeType === 'store') return 1
  if (scopeType === 'all') {
    const rows = await pg.query(
      "SELECT COUNT(*)::int AS cnt FROM org_nodes WHERE type = '门店'",
    )
    return Number(rows[0]?.cnt || 0)
  }
  const rows = await pg.query(
    "SELECT COUNT(*)::int AS cnt FROM org_nodes WHERE type = '门店' AND parent_id = $1",
    [scopeId],
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

/**
 * mgmtDashboard.summary
 * 入参：{ date: 'YYYY-MM-DD', scopeType: 'all'|'market'|'store', scopeId? }
 * 出参：见 ticket §1.2
 */
async function summary(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { date, scopeType, scopeId } = ctx.event.payload || {}

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('INVALID_PARAMS: date 必填，且格式为 YYYY-MM-DD')
  }
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: scopeType 必须是 all/market/store')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: scopeType 为 market/store 时必须提供 scopeId')
  }

  validateScope(ctx.auth, scopeType, scopeId)

  const t0 = Date.now()
  const [
    storeRevToday, storeRevMonth,
    shengmeiRevToday, shengmeiRevMonth,
    storeConsToday, storeConsMonth,
    shengmeiConsToday, shengmeiConsMonth,
    footfallToday, footfallMonth,
    headcountToday, headcountMonth,
    newMemToday, newMemMonth,
    memberCount, retainedMemberCount, employeeCount,
    storeCount,
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
    queryMemberCount(scopeType, scopeId),
    queryRetainedMemberCount(scopeType, scopeId),
    queryEmployeeCount(scopeType, scopeId),
    queryStoreCount(scopeType, scopeId),
    resolveScopeName(scopeType, scopeId),
  ])
  const elapsed = Date.now() - t0

  const round2 = (v) => Math.round(Number(v) * 100) / 100
  const avg = (m) => (storeCount > 0 ? round2(m / storeCount) : 0)

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
    // TODO: 待业务定义"项目数"口径后实现
    projectCount: { today: 0, month: 0 },
    storeCount,
    memberCount,
    retainedMemberCount,
    employeeCount,
    computedAt: new Date().toISOString(),
  }

  if (elapsed > 800) {
    console.warn(`[mgmtDashboard.summary] slow query: ${elapsed}ms`, { scopeType, scopeId, date })
  }
}

// 测试辅助：清空 loadAllMarkets 的 5 分钟内存缓存（避免 vitest 跨用例串扰）
function __resetMarketsCache() {
  CACHE = { ts: 0, data: null }
}

module.exports = { scopeOptions, summary, __resetMarketsCache }
