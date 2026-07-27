/**
 * 管理层 - 品项数据子页（mgmt-product-cycle）路由
 *
 * 入口：mgmt-dashboard 首页"品项数据"卡片（entry === 'products'）
 *
 * mgmtProduct.cardHolders — 持卡人数（截面快照，不随 period 变化）
 *   持卡 = 已解锁次数大于 0（paid_sessions > 0），不按 product_type 过滤
 *   按 product_kind 分组 + memberCount（分母）
 *
 * mgmtProduct.cycleStats — 体验/进入/复购（区间维度）
 *   达标日：SUM(received) 在 (client_user_id, store_id, product_kind, purchase_date) 分组下 ≥ threshold
 *   purchase_date：COALESCE(sale_order_datetime, paid_at)::date
 *   entry_date：跨店合并，全历史最早达标日
 *   复购：在 [startDate, endDate] 内 entry_date 后再次达标（threshold 共用）
 *   订单状态：排除已关闭/已作废/未审核/待审批/支付失败；received 达标即计入，不要求已支付
 *   单次 SQL（CTE 链 + 三段 UNION ALL）
 *
 * 口径定义：notes/references/metrics.md "品项顾客周期子页"章节
 */

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')
const { validateManagementScope } = require('../utils/scope')
const { getMemberThreshold } = require('../utils/config')

// scope 校验已统一抽取到 utils/scope.js::validateManagementScope（4 路由共用，避免拷贝漂移）

/**
 * 构造 sale/service 表的 store_id scope 过滤片段
 */
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

/**
 * period → { startDate, endDate }，与 sales-data 页时间窗口一致
 * 锚点 NOW()，与 metrics.md "时间窗口补充" 表对齐。
 */
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

function isValidDateText(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

function resolveCyclePeriod(period, startDate, endDate) {
  if (period !== 'custom') return getSalesDataPeriod(period)
  if (!isValidDateText(startDate) || !isValidDateText(endDate)) {
    throw new Error('INVALID_PARAMS: 自定义周期必须提供合法 startDate/endDate')
  }
  if (startDate > endDate) {
    throw new Error('INVALID_PARAMS: startDate 不能晚于 endDate')
  }
  return { startDate, endDate }
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

// ====================================================================
// cardHolders —— 持卡人数（截面快照）
// ====================================================================

/**
 * mgmtProduct.cardHolders
 * 入参：{ scopeType: 'all'|'market'|'store', scopeId? }
 * 出参：{ memberCount: number, cardHolders: [{ productKind, count, rate }] }
 *   rate = count / memberCount * 100，保留 2 位小数（数值类型）；memberCount=0 → null
 *
 * SQL：
 *   - 持卡：sale_items JOIN sale_orders JOIN product_skus JOIN product_categories
 *     WHERE paid_sessions > 0
 *     ∩ sale_order_type IN ('销售单','转换单','寄存单') ∩ status='已支付' ∩ scope（so.store_id）
 *     （寄存单为 WorkFine 剩余次数初始化，按次数维度纳入持卡人数）
 *   - 会员数：client_wechat_users WHERE became_member_at IS NOT NULL ∩ scope（c.bound_store_id）
 *     （与 metrics.md memberCount T2 历史化口径一致；持卡人数为截面，本接口不带 $date 守卫）
 */
async function cardHolders(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { scopeType, scopeId } = ctx.event.payload || {}

  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: scopeType 必须是 all/market/store')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: scopeType 为 market/store 时必须提供 scopeId')
  }

  validateManagementScope(ctx.auth, scopeType, scopeId)

  const t0 = Date.now()

  // 持卡 SQL —— $1=scopeId（仅当 scopeType !== 'all'）
  const sc = buildSaleScope(scopeType, scopeId, 'so', 1)
  const cardSql = `
    SELECT pc.product_kind AS product_kind,
           COUNT(DISTINCT so.client_user_id)::int AS count
      FROM sale_items si
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
     WHERE ${sc.sql}
       AND si.paid_sessions > 0
       AND so.sale_order_type IN ('销售单','转换单','寄存单')
       AND so.status = '已支付'
       AND so.client_user_id IS NOT NULL
       AND pc.product_kind IS NOT NULL
     GROUP BY pc.product_kind`

  // 会员 SQL（与 metrics.md memberCount 定义对齐：T2 历史化口径，与 mgmt-dashboard.js 一致）
  // —— $1=scopeId（仅当 scopeType !== 'all'）
  const cs = buildClientScope(scopeType, scopeId, 'c', 1)
  const memberSql = `
    SELECT COUNT(*)::int AS cnt
      FROM client_wechat_users c
     WHERE ${cs.sql}
       AND c.became_member_at IS NOT NULL`

  const [cardRows, memberRows, scopeName] = await Promise.all([
    pg.query(cardSql, sc.params),
    pg.query(memberSql, cs.params),
    resolveScopeName(scopeType, scopeId),
  ])

  const memberCount = Number(memberRows[0]?.cnt || 0)

  const cardHoldersOut = cardRows.map((r) => {
    const count = Number(r.count || 0)
    const rate = memberCount > 0
      ? parseFloat(((count / memberCount) * 100).toFixed(2))
      : null
    return { productKind: r.product_kind, count, rate }
  })

  const elapsed = Date.now() - t0
  if (elapsed > 800) {
    console.warn(`[mgmtProduct.cardHolders] slow: ${elapsed}ms`, { scopeType, scopeId })
  }

  ctx.result = {
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    memberCount,
    cardHolders: cardHoldersOut,
    computedAt: new Date().toISOString(),
  }
}

// ====================================================================
// cycleStats —— 体验/新增/复购（区间维度）
// ====================================================================

/**
 * mgmtProduct.cycleStats
 * 入参：{ period: 'month'|'lastMonth'|'year'|'custom', scopeType: 'all'|'market'|'store', scopeId?, startDate?, endDate? }
 * 出参：{ period, scope, startDate, endDate,
 *         trial: [{productKind, count, revenue, avgTicket}],
 *         newEntry: [{...}],
 *         repurchase: [{...}] }
 *
 * 内部：
 *   - getSalesDataPeriod(period) → { startDate, endDate }
 *   - getMemberThreshold() → threshold
 *   - 单次 SQL：WITH daily_agg → qualifying_days → first_entry → period_agg → xinzeng/fugou/tiyan
 *     最后用 UNION ALL 拆三段（group_kind: 'trial' / 'new' / 'repurchase'）
 *
 * 参数顺序：$1=startDate, $2=endDate, $3=threshold, $4...=scope params
 *   daily_agg WHERE: purchase_date <= $2（全历史下界）
 *   period_agg WHERE: BETWEEN $1 AND $2
 */
async function cycleStats(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { period, scopeType, scopeId, startDate: customStartDate, endDate: customEndDate } = ctx.event.payload || {}

  if (!['month', 'lastMonth', 'year', 'custom'].includes(period)) {
    throw new Error('INVALID_PARAMS: period 必须是 month/lastMonth/year/custom')
  }
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: scopeType 必须是 all/market/store')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: scopeType 为 market/store 时必须提供 scopeId')
  }

  validateManagementScope(ctx.auth, scopeType, scopeId)

  const { startDate, endDate } = resolveCyclePeriod(period, customStartDate, customEndDate)
  const threshold = await getMemberThreshold()

  // scope params 起始下标 $4
  const sc = buildSaleScope(scopeType, scopeId, 'so', 4)
  const params = [startDate, endDate, threshold, ...sc.params]
  const purchaseDateSql = 'COALESCE(so.sale_order_datetime, so.paid_at)::date'

  const sql = `
    WITH daily_agg AS (
      SELECT so.client_user_id,
             so.store_id,
             pc.product_kind,
             ${purchaseDateSql}         AS purchase_date,
             SUM(si.received::numeric)  AS day_received
        FROM sale_items si
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        JOIN product_skus sk ON sk.sku_id = si.sku_id
        JOIN product_categories pc ON pc.category_id = sk.category_id
       WHERE ${sc.sql}
         AND so.sale_order_type IN ('销售单','转换单')
         AND so.status NOT IN ('已关闭','已作废','未审核','待审批','支付失败')
         AND so.client_user_id IS NOT NULL
         AND pc.product_kind IS NOT NULL
         AND ${purchaseDateSql} <= $2
       GROUP BY so.client_user_id, so.store_id, pc.product_kind, ${purchaseDateSql}
      HAVING SUM(si.received::numeric) > 0
    ),
    qualifying_days AS (
      SELECT client_user_id, store_id, product_kind, purchase_date
        FROM daily_agg
       WHERE day_received >= $3
    ),
    first_entry AS (
      SELECT client_user_id,
             product_kind,
             MIN(purchase_date) AS entry_date
        FROM qualifying_days
       GROUP BY client_user_id, product_kind
    ),
    period_agg AS (
      SELECT client_user_id, store_id, product_kind, purchase_date, day_received
        FROM daily_agg
       WHERE purchase_date BETWEEN $1 AND $2
    ),
    xinzeng AS (
      SELECT client_user_id, product_kind, entry_date
        FROM first_entry
       WHERE entry_date BETWEEN $1 AND $2
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.product_kind
        FROM qualifying_days q
        JOIN xinzeng x ON x.client_user_id = q.client_user_id
                      AND x.product_kind   = q.product_kind
       WHERE q.purchase_date BETWEEN $1 AND $2
         AND q.purchase_date > x.entry_date
    ),
    tiyan AS (
      SELECT DISTINCT pa.client_user_id, pa.product_kind
        FROM period_agg pa
       WHERE NOT EXISTS (
         SELECT 1 FROM first_entry f
          WHERE f.client_user_id = pa.client_user_id
            AND f.product_kind   = pa.product_kind
       )
    )
    SELECT 'trial' AS group_kind,
           t.product_kind,
           COUNT(DISTINCT t.client_user_id)::int AS count,
           COALESCE(SUM(pa.day_received), 0)::numeric AS revenue
      FROM tiyan t
      LEFT JOIN period_agg pa
        ON pa.client_user_id = t.client_user_id
       AND pa.product_kind   = t.product_kind
     GROUP BY t.product_kind
    UNION ALL
    SELECT 'new' AS group_kind,
           x.product_kind,
           COUNT(DISTINCT x.client_user_id)::int AS count,
           COALESCE(SUM(pa.day_received), 0)::numeric AS revenue
      FROM xinzeng x
      LEFT JOIN period_agg pa
        ON pa.client_user_id = x.client_user_id
       AND pa.product_kind   = x.product_kind
     GROUP BY x.product_kind
    UNION ALL
    SELECT 'repurchase' AS group_kind,
           f.product_kind,
           COUNT(DISTINCT f.client_user_id)::int AS count,
           COALESCE(SUM(pa.day_received), 0)::numeric AS revenue
      FROM fugou f
      LEFT JOIN period_agg pa
        ON pa.client_user_id = f.client_user_id
       AND pa.product_kind   = f.product_kind
     GROUP BY f.product_kind`

  const t0 = Date.now()
  const [rows, scopeName] = await Promise.all([
    pg.query(sql, params),
    resolveScopeName(scopeType, scopeId),
  ])
  const elapsed = Date.now() - t0

  const trial = []
  const newEntry = []
  const repurchase = []
  const entryCountByKind = new Map()

  for (const r of rows) {
    const count = Number(r.count || 0)
    if (r.group_kind === 'new') entryCountByKind.set(r.product_kind, count)
  }

  for (const r of rows) {
    const count = Number(r.count || 0)
    const revenue = parseFloat(Number(r.revenue || 0).toFixed(2))
    const avgTicket = count > 0
      ? parseFloat((revenue / count).toFixed(2))
      : null
    const row = {
      productKind: r.product_kind,
      count,
      revenue,
      avgTicket,
    }
    if (r.group_kind === 'trial') trial.push(row)
    else if (r.group_kind === 'new') newEntry.push(row)
    else if (r.group_kind === 'repurchase') {
      const entryCount = Number(entryCountByKind.get(r.product_kind) || 0)
      repurchase.push({
        ...row,
        entryCount,
        repurchaseRate: entryCount > 0 ? parseFloat((count / entryCount).toFixed(4)) : null,
      })
    }
  }

  if (elapsed > 800) {
    console.warn(`[mgmtProduct.cycleStats] slow: ${elapsed}ms`, { period, scopeType, scopeId })
  }

  ctx.result = {
    period,
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    startDate,
    endDate,
    trial,
    newEntry,
    repurchase,
    computedAt: new Date().toISOString(),
  }
}

module.exports = { cardHolders, cycleStats }
