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

/**
 * 取 selectedDate 所属月份的月末日期（YYYY-MM-DD）。
 * 月度业绩是整月维度，对应整月在营/在职的口径，分母用月末快照。
 */
function lastDayOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number)
  // m 为下一月用 0 号 = 当月月末
  const d = new Date(Date.UTC(y, m, 0))
  const yy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

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

async function queryProjectCount(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sit.session_used), 0) AS v
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
      WHERE ${sc.sql}
        AND so.status = '已完成'
        AND sit.sales_category IN ('自销自耗', '他销自耗')
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

async function querySalesCommissionIncome(scopeType, scopeId, date, mode) {
  const sc = buildSaleScope(scopeType, scopeId, 'so', 2)
  const rows = await pg.query(
    `SELECT COALESCE(SUM(sa.total_amount::numeric), 0) AS v
       FROM sale_allocations sa
       JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
       JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      WHERE ${sc.sql}
        AND sa.is_void = FALSE
        AND sa.role_type IN ('美容师', '养生师')
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
        AND sc2.role_type IN ('美容师', '养生师')
        AND so.status = '已完成'
        AND ${timeWindow('so.service_date', mode, 1, true)}`,
    [date, ...sc.params],
  )
  return Number(rows[0]?.v || 0)
}

/**
 * 新会员（2026-04-25 起按 became_member_at 判定）
 *
 * 口径：所选时段内首次成为会员客。
 * 与 metrics.md "新会员"行严格对齐；与 became_member_at（与 customer_type='会员客' 跃迁同事务维护）作权威字段。
 *
 * 旧口径（已废弃）：`old_member_level IS NULL AND member_level IS NOT NULL AND [member_level_upgraded_at]`
 * — 旧口径会把"会员等级内跃迁（初钻→星钻 等）"也算作新会员，与业务语义偏离。
 */
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

/**
 * 会员数（截面快照，2026-04-25 T2 起按 selectedDate 历史化）
 *
 * 口径：「$date 那天为止累计成为会员客」 = COUNT(c.became_member_at::date <= $date)
 *
 * 不再用 c.customer_type = '会员客'（那是当前快照，无法反映历史日期）。
 * 改为用 c.became_member_at 时间戳，任意 $date 都可还原"那一天的会员数"。
 *
 * 跃迁路径在 `staffApi/routes/order.js`（recalcCustomerType）和
 * `payNotify/index.js`（重算路径）中已与 customer_type 跃迁同步写入 became_member_at = NOW()。
 * 历史数据由 `db/scripts/backfill-became-member-at.js` 一次性回填。
 */
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

/**
 * 保有会员数（方案 B 实时计算，2026-04-25 T5 起）
 *
 * 口径：「$date 那天已是会员客」 ∩ 「$date 前 90 天到店至少 1 次」
 *
 * 不再读 client_wechat_users.customer_status 列（那是当前快照、cronTask 每日重算，
 * 无法反映历史日期）。改为基于 service_orders 实时聚合 + became_member_at 守卫，
 * 任意 $date 都可还原"那一天的保有会员数"。
 */
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

/**
 * 员工数（截面快照，2026-04-25 T3 起按 selectedDate 历史化）
 *
 * 口径：「$date 那天为止已入职且未离职」 =
 *   COUNT(s.hired_at::date <= $date AND (s.resigned_at IS NULL OR s.resigned_at::date > $date))
 *
 * 不再用 s.is_resigned = FALSE（那是当前快照，无法反映历史日期）。
 * 改为用 s.hired_at + s.resigned_at 时间戳，任意 $date 都可还原"那一天的在职员工数"。
 *
 * 字段维护：admin 员工管理表单写入；当前 hired_at 由 created_at::date 兜底（WorkFine 无入职日期源），
 * resigned_at 由 updated_at::date 兜底。后续由管理后台维护。
 */
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

/**
 * 门店数（截面快照，2026-04-25 T4 起按 selectedDate 历史化）
 *
 * 口径：「$date 那天在营」 =
 *   COUNT(s.opening_date::date <= $date AND (s.closed_at IS NULL OR s.closed_at::date > $date))
 *
 * 单店模式（scope=store）短路返回 1，不依赖快照。
 * all/market 模式 JOIN stores 表，加 opening_date/closed_at 守卫。
 */
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
    queryEmployeeCount(scopeType, scopeId, date),     // 当日（selectedDate 当日的在职员工数）
    queryStoreCount(scopeType, scopeId, date),         // 当日（selectedDate 当日在营的门店数）
    queryEmployeeCount(scopeType, scopeId, monthEnd),  // 月末（用于月度派生指标分母）
    queryStoreCount(scopeType, scopeId, monthEnd),     // 月末（月度业绩对应的整月在营门店数）
    resolveScopeName(scopeType, scopeId),
  ])
  const elapsed = Date.now() - t0

  const round2 = (v) => Math.round(Number(v) * 100) / 100
  // monthlyAvgPerStore：分母用月末口径，与"月度业绩 = 整月在营"语义对齐
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
    // T6（2026-04-25）：双口径 — day 给屏幕展示与日维度派生分母用，month 给月维度派生分母用
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

// =====================================================================
// storeRanking —— 门店排行榜（mgmt-dashboard ranking tab）
// =====================================================================

/**
 * 落 period 区间（用于业绩/实耗/客流/新会员/项目数）
 * 锚点固定为 NOW()::date，无 date 参数（设计稿无日历组件，3 个 period 固定相对值）
 * @param {string} col 列引用（含别名）
 * @param {'month'|'lastMonth'|'year'} period
 * @param {boolean} _isDateColumn 保留形参便于未来扩展（NOW()::date 与 timestamp 比较时 PG 会自动处理）
 */
function timeWindowPeriod(col, period, _isDateColumn) {
  if (period === 'month') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date)`
  }
  if (period === 'lastMonth') {
    return `date_trunc('month', ${col}) = date_trunc('month', NOW()::date - INTERVAL '1 month')`
  }
  // year
  return `date_trunc('year', ${col}) = date_trunc('year', NOW()::date)`
}

/**
 * 保有会员（方案 B）的 refDate SQL 表达式
 * - month / year：本月或本年还未结束 → 用 NOW()::date
 * - lastMonth：上月最后一天
 */
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

/**
 * 当前账号可见门店列表
 * @returns {string[] | null} null 表示不过滤（headquarters）；[] 表示空集（market 但 scopeStoreIds 为空）
 */
function getVisibleStoreIds(auth) {
  if (auth.staffLevel === 'headquarters') return null
  return auth.scopeStoreIds || []
}

/**
 * 构造 stores 表的 store_id 过滤片段
 * @param {string[]|null} visibleStoreIds null=不过滤；[]=空集（返回 FALSE 让 SQL 短路）
 * @param {string} alias 表别名（默认 's'）
 * @param {number} startIdx 起始 $n 下标
 */
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

/**
 * 同值并列 RANK 跳号语义（标准 SQL RANK()）
 * [200,100,50] → 1/2/3；[100,100,50] → 1/1/3
 * 调用前 rows 必须已按 value DESC 排序
 */
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

/* ----- 6 个排行榜 metric 子查询 ----- */

async function rankingRevenue(period, storeFilter) {
  return pg.query(
    `SELECT
       s.store_id,
       s.store_name,
       o.name AS market_name,
       COALESCE(SUM(so.paid_amount::numeric), 0) AS value
     FROM stores s
     JOIN org_nodes o_store ON s.org_node_id = o_store.id
     JOIN org_nodes o ON o_store.parent_id = o.id
     LEFT JOIN sale_orders so
       ON so.store_id = s.store_id
       AND so.sale_order_type IN ('销售单', '转换单')
       AND so.status = '已支付'
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
     LEFT JOIN service_items sit ON sit.service_order_id = so2.service_order_id
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

/**
 * 新会员排名（2026-04-25 起按 became_member_at 判定，与 metrics.md "新会员"行对齐）
 *
 * 旧口径（已废弃）：`old_member_level IS NULL AND member_level IS NOT NULL AND [member_level_upgraded_at]`
 * 旧口径包含"会员等级内跃迁"，与"首次成会员"业务语义偏离。
 */
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

/**
 * mgmtDashboard.storeRanking
 * 入参：{ period: 'month'|'lastMonth'|'year', metric: 6 选 1 }
 * 出参：{ period, metric, unit, rows: [{rank, storeId, storeName, marketName, value}], computedAt }
 */
async function storeRanking(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, metric } = ctx.event.payload || {}

  if (!VALID_PERIODS.includes(period)) {
    throw new Error('INVALID_PARAMS: period 必须是 month/lastMonth/year')
  }
  if (!VALID_METRICS.includes(metric)) {
    throw new Error('INVALID_PARAMS: metric 必须是 ' + VALID_METRICS.join('/'))
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

// =====================================================================
// staffRanking —— 员工排行榜（mgmt-dashboard ranking tab 「员工」子视图）
// =====================================================================
//
// 与 storeRanking 的关系：
//   - 复用 helper：timeWindowPeriod / getVisibleStoreIds / buildStoreFilter / assignRanks
//   - 独立 SQL：所有 metric 都先用 producer_employees CTE 锁定"产能员工"再 LEFT JOIN
//   - metric 集合不同：员工无 retainedMember；员工独有 income（销售提成 + 服务提成）
//
// 产能员工口径（与 metrics.md employeeCount 一致）：
//   hired_at/resigned_at + NOW() 锚点 ∩ skills && ARRAY['美容师','养生师'] ∩ scope（store_id 可见列表）
// 排序：value DESC, employee_name ASC, employee_id ASC（避免随机抖动）

/**
 * 拼接 producer_employees CTE 头部（所有 metric 共享）。
 * @param {{sql: string, params: any[]}} storeFilter buildStoreFilter('sw', startIdx) 的结果
 */
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
    AND sw.skills && ARRAY['美容师','养生师']
    AND ${storeFilter.sql}
)`
}

const STAFF_ORDER_BY = `ORDER BY value DESC, pe.employee_name ASC, pe.employee_id ASC`

/* ----- 6 个员工排行榜 metric 子查询 ----- */

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
  WHERE so2.status = '已完成'
    AND ${timeWindowPeriod('so2.service_date', period, true)}
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
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

/**
 * 新会员排名（2026-04-25 起按 became_member_at 判定，与 metrics.md "新会员"行对齐）
 * 旧口径（已废弃）：old_member_level IS NULL ∧ member_level IS NOT NULL ∩ [member_level_upgraded_at]
 *
 * 归属字段：client_wechat_users.bound_employee_id（绑定美容师）
 * bound_employee_id IS NULL 的新会员不归属任何员工（"无归属新会员"由监控关注，本接口不展示）
 */
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
${STAFF_ORDER_BY}`,
    storeFilter.params,
  )
}

/**
 * 收入排名 = 销售提成（业绩）+ 服务提成
 *   - 销售部分公式与 staffRankingRevenue 完全一致
 *   - 服务部分来自 service_commissions.commission_amount（已是计算后的实拿提成）
 * role_type IN ('美容师','养生师') ∩ is_void=FALSE
 */
async function staffRankingIncome(period, storeFilter) {
  return pg.query(
    `${producerEmployeesCte(storeFilter)},
sales_comm AS (
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
),
service_comm AS (
  SELECT
    sc.employee_id,
    COALESCE(SUM(sc.commission_amount::numeric), 0) AS v
  FROM service_commissions sc
  JOIN service_items sit  ON sit.service_item_id   = sc.service_item_id
  JOIN service_orders so2 ON so2.service_order_id  = sit.service_order_id
  WHERE sc.is_void = FALSE
    AND sc.role_type IN ('美容师','养生师')
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

/**
 * mgmtDashboard.staffRanking
 * 入参：{ period: 'month'|'lastMonth'|'year', metric: 6 选 1 }
 * 出参：{ period, metric, unit, rows: [{rank, employeeId, employeeName, storeId, storeName, value}], computedAt }
 */
async function staffRanking(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, metric } = ctx.event.payload || {}

  if (!VALID_PERIODS.includes(period)) {
    throw new Error('INVALID_PARAMS: period 必须是 month/lastMonth/year')
  }
  if (!VALID_STAFF_METRICS.includes(metric)) {
    throw new Error('INVALID_PARAMS: metric 必须是 ' + VALID_STAFF_METRICS.join('/'))
  }

  const visibleStoreIds = getVisibleStoreIds(ctx.auth)
  // 注意：员工查询 store filter 别名是 sw（staff_wechat_users）
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

// =====================================================================
// salesData —— 销售数据页（业绩与实耗 + 品项维度汇总）
// =====================================================================

// 销售数据页骨架常量（仅经营类型 — 与 db/schema/enums.ts::salesCategoryEnum 同源）
// 一级/二级品项骨架不在此写死，运行时从 product_categories 表读取（见 SQL 9）
const SALES_CATEGORY_SKELETON = ['自销自耗', '他销自耗', '他销他耗', '生态合作']

/**
 * mgmtDashboard.salesData
 * 入参：{ period: 'month'|'lastMonth'|'year', scope: { type: 'all'|'market'|'store', id?: string } }
 * 出参：totalRevenue / 分客型业绩 / totalConsume / 分客型实耗 / 品项汇总
 *
 * 时间轴：BETWEEN period.startDate AND period.endDate（与 summary 的 date_trunc 不同）
 * 顾客分型：取 client_wechat_users 当前快照（新增会员 = became_member_at >= startDate）
 */
async function salesData(ctx) {
  await requireManagementLevel()(ctx, async () => {})
  const { period, scope } = ctx.event.payload || {}
  const scopeType = scope?.type
  const scopeId = scope?.id || null

  if (!['month', 'lastMonth', 'year'].includes(period)) {
    throw new Error('INVALID_PARAMS: period 必须是 month/lastMonth/year')
  }
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: scope.type 必须是 all/market/store')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: scope.type 为 market/store 时必须提供 scope.id')
  }

  validateScope(ctx.auth, scopeType, scopeId)

  const { startDate, endDate } = getSalesDataPeriod(period)
  const fmt = (v) => parseFloat(v || 0).toFixed(2)

  // $1=startDate, $2=endDate, $3...=scope params
  const scSale = buildSaleScope(scopeType, scopeId, 'o', 3)
  const scSvc = buildSaleScope(scopeType, scopeId, 'so', 3)
  const saleP = [startDate, endDate, ...scSale.params]
  const svcP = [startDate, endDate, ...scSvc.params]

  const t0 = Date.now()
  const [revRows, custRevRows, consRows, custConsRows, prodOutRows, catRows, kindRows, nameRows, skeletonRows] =
    await Promise.all([
      // SQL 1: 总业绩
      pg.query(
        `SELECT COALESCE(SUM(o.paid_amount::numeric), 0) AS v
           FROM sale_orders o
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND o.paid_at::date BETWEEN $1 AND $2`,
        saleP,
      ),
      // SQL 2: 分客型业绩（单次扫描三 FILTER）
      pg.query(
        `SELECT
            COALESCE(SUM(si.received::numeric) FILTER (
              WHERE c.customer_type = '小美客'
            ), 0) AS xiaomei,
            COALESCE(SUM(si.received::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND c.became_member_at::date >= $1
            ), 0) AS new_member,
            COALESCE(SUM(si.received::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND c.became_member_at::date < $1
            ), 0) AS old_member
           FROM sale_items si
           JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
           JOIN client_wechat_users c ON c.user_id = o.client_user_id
          WHERE ${scSale.sql}
            AND o.sale_order_type IN ('销售单', '转换单')
            AND o.status = '已支付'
            AND o.paid_at::date BETWEEN $1 AND $2`,
        saleP,
      ),
      // SQL 3: 总实耗
      pg.query(
        `SELECT COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS v
           FROM service_items sit
           JOIN service_orders so ON so.service_order_id = sit.service_order_id
          WHERE ${scSvc.sql}
            AND so.status = '已完成'
            AND so.service_date BETWEEN $1 AND $2`,
        svcP,
      ),
      // SQL 4: 分客型项目实耗
      pg.query(
        `SELECT
            COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
              WHERE c.customer_type = '小美客'
            ), 0) AS xiaomei,
            COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
              WHERE c.customer_type = '会员客'
                AND c.became_member_at::date >= $1
            ), 0) AS new_member,
            COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used) FILTER (
              WHERE c.customer_type = '会员客'
                AND c.became_member_at::date < $1
            ), 0) AS old_member
           FROM service_items sit
           JOIN service_orders so ON so.service_order_id = sit.service_order_id
           JOIN client_wechat_users c ON c.user_id = so.client_user_id
          WHERE ${scSvc.sql}
            AND so.status = '已完成'
            AND so.service_date BETWEEN $1 AND $2`,
        svcP,
      ),
      // SQL 5: 分客型产品出库（product_type='家居产品' 快照列）
      pg.query(
        `SELECT
            COALESCE(SUM(si.received::numeric) FILTER (
              WHERE c.customer_type = '小美客'
            ), 0) AS xiaomei,
            COALESCE(SUM(si.received::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND c.became_member_at::date >= $1
            ), 0) AS new_member,
            COALESCE(SUM(si.received::numeric) FILTER (
              WHERE c.customer_type = '会员客'
                AND c.became_member_at::date < $1
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
      // SQL 6: 按经营类型汇总
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
      // SQL 7: 按一级品项汇总
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
      // SQL 8: 按一二级品项当期销售（嵌套用）
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
      // SQL 9: 品项骨架（不依赖时间窗 / scope，是 product_categories 表的当前全量快照）
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

  // 经营类型骨架（4 行硬展示，pgEnum 序）+ 占比（分母=4 行金额之和）
  const catMap = new Map(catRows.map((r) => [r.label, r.value]))
  const salesCategoryTotal = Array.from(catMap.values())
    .reduce((s, v) => s + parseFloat(v || 0), 0)
  const bySalesCategory = SALES_CATEGORY_SKELETON.map((lbl) => {
    const v = catMap.get(lbl) || 0
    return { label: lbl, value: fmt(v), ratio: fmtPct(v, salesCategoryTotal) }
  })

  // 一级/二级骨架来自 SQL 9 的 product_categories 快照
  const kindTotalMap = new Map(kindRows.map((r) => [r.label, r.value]))
  const leafValueMap = new Map() // `${kind}::${label}` -> value
  for (const r of nameRows) {
    leafValueMap.set(`${r.kind}::${r.label}`, r.value)
  }

  // 品项总额（一级金额之和）— 一级和二级 ratio 的统一分母
  const productKindTotal = kindRows
    .reduce((s, r) => s + parseFloat(r.value || 0), 0)

  // 按 product_kind 分组骨架（children 暂存数值原值供 ratio 计算）
  const groupBuilder = new Map() // kind -> { children: [{label, value}] }
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

  // 装配最终结构：一级 value 取 kindRows，children 排序，一级整体按 value DESC + label 升序
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

// 测试辅助：清空 loadAllMarkets 的 5 分钟内存缓存（避免 vitest 跨用例串扰）
function __resetMarketsCache() {
  CACHE = { ts: 0, data: null }
}

module.exports = { scopeOptions, summary, storeRanking, staffRanking, salesData, __resetMarketsCache }
