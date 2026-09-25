/**
 * 管理层 - 品项数据子页（mgmt-product-cycle）路由
 *
 * 入口：mgmt-dashboard 首页"品项数据"卡片（entry === 'products'）
 *
 * mgmtProduct.cardHolders — 持卡人数（截面快照，不随 period 变化）
 *   持卡 = 已解锁次数大于 0（paid_sessions > 0），不按 product_type 过滤
 *   按 product_kind 分组 + memberCount（分母）
 *   ★★ 分子必须与分母同源（#287）：人群都只算会员、scope 都走 c.bound_store_id。
 *      此前分子不限客型且按 so.store_id 归店 → 集团占比恒 253%、单店最高 2600%。
 *
 * mgmtProduct.cycleStats — 体验/进入/复购（区间维度）
 *   达标日：SUM(sipe.amount) 在 (client_user_id, store_id, product_kind, purchase_date) 分组下 ≥ threshold
 *   purchase_date：sale_item_performance_events.performance_date（子项业绩归属日期）
 *   ⚠ 2026-09-14 订正：原注释写「SUM(received)」「COALESCE(sale_order_datetime, paid_at)::date」
 *     与实现不符 —— #137 起本文件 daily_agg 已改走子项业绩事件视图（见下方 SQL），
 *     跨月回款按款项分摊到各自归属日，不再整单压在下单日。
 *   entry_date：跨店合并，全历史最早达标日
 *   复购：在 [startDate, endDate] 内 entry_date 后再次达标（threshold 共用）
 *   订单状态：排除已关闭/已作废/未审核/待审批/支付失败；received 达标即计入，不要求已支付
 *   单次 SQL（CTE 链 + 三段 UNION ALL）
 *
 * 口径定义：notes/references/metrics.md "品项顾客周期子页"章节
 */

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')
const { validateManagementScope, buildManagementStoreScope } = require('../utils/scope')
// 在营口径单源（#401）：只看门店组织节点 is_active，与 mgmt-dashboard.js / admin scopeFilterSql 同源
const { activeStoreCondition } = require('../utils/store-status')
const { getMemberThreshold } = require('../utils/config')

// scope 校验已统一抽取到 utils/scope.js::validateManagementScope（4 路由共用，避免拷贝漂移）

/**
 * 构造 sale/service 表的 store_id scope 过滤片段
 */
function buildSaleScope(scopeType, scopeId, alias, startIdx) {
  const column = `${alias}.store_id`
  const scope = buildManagementStoreScope(scopeType, scopeId, column, startIdx)
  return { sql: `(${scope.sql}) AND ${activeStoreCondition(column)}`, params: scope.params }
}

/** client_wechat_users.bound_store_id scope */
function buildClientScope(scopeType, scopeId, alias, startIdx) {
  const column = `${alias}.bound_store_id`
  const scope = buildManagementStoreScope(scopeType, scopeId, column, startIdx)
  return { sql: `(${scope.sql}) AND ${activeStoreCondition(column)}`, params: scope.params }
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
 *   - 持卡（占比分子）：**client_wechat_users c** JOIN sale_orders JOIN sale_items
 *     JOIN product_skus JOIN product_categories
 *     WHERE became_member_at IS NOT NULL ∩ paid_sessions > 0
 *     ∩ sale_order_type IN ('销售单','转换单','寄存单') ∩ status='已支付'
 *     ∩ scope（**c.bound_store_id**，与分母同源 —— #287，此处曾是 so.store_id）
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

  // 持卡 SQL（占比分子）—— $1=scopeId（仅当 scopeType !== 'all'）
  //
  // ★ 口径红线：**分子必须与下面的 memberSql 同源**（#287）。两条铁律：
  //   ① 驱动表是 client_wechat_users，且带 became_member_at IS NOT NULL —— 人群与分母相同
  //   ② scope 用 buildClientScope（c.bound_store_id），**不是** buildSaleScope（so.store_id）
  //      —— 归店键与分母相同
  // 二者合起来 ⇒ 分子人群 ⊆ 分母人群、归店键一致 ⇒ 占比数学上恒 ≤ 100%。
  //
  // ⚠️ 2026-09-22 审计：此前分子不限客型、且按 so.store_id 归店，
  //    集团占比恒 253%、单店最高 2600%（admin 同型缺陷见 product.ts queryCardHolders）。
  //    admin 侧用「分母壳 + EXISTS」，这里因为要 GROUP BY pc.product_kind
  //    （分组键在连接表上）改用 JOIN + COUNT(DISTINCT c.user_id)，同源性等价。
  const cs = buildClientScope(scopeType, scopeId, 'c', 1)
  const cardSql = `
    SELECT pc.product_kind AS product_kind,
           COUNT(DISTINCT c.user_id)::int AS count
      FROM client_wechat_users c
      JOIN sale_orders so ON so.client_user_id = c.user_id
      JOIN sale_items si ON si.sale_order_id = so.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
     WHERE ${cs.sql}
       AND c.became_member_at IS NOT NULL
       AND si.paid_sessions > 0
       AND so.sale_order_type IN ('销售单','转换单','寄存单')
       AND so.status = '已支付'
       AND pc.product_kind IS NOT NULL
     GROUP BY pc.product_kind`

  // 会员 SQL（占比分母；与 metrics.md memberCount 定义对齐：T2 历史化口径，与 mgmt-dashboard.js 一致）
  // —— 复用上面同一个 cs：**分子分母必须共用同一个 scope 构造**（#287），
  //    各建一个会让「归店键一致」退化成靠自觉维护。
  const memberSql = `
    SELECT COUNT(*)::int AS cnt
      FROM client_wechat_users c
     WHERE ${cs.sql}
       AND c.became_member_at IS NOT NULL`

  const [cardRows, memberRows, scopeName] = await Promise.all([
    pg.query(cardSql, cs.params),
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
 *   - 单次 SQL：WITH daily_agg → qualifying_days / repurchase_qualifying_days
 *     → first_entry → period_agg → xinzeng/fugou/tiyan
 *   - 寄存单只参与首次进入基线；复购达标与区间业绩只统计销售单/转换单
 *   - 最后用 UNION ALL 拆三段（group_kind: 'trial' / 'new' / 'repurchase'）
 *
 * 参数顺序：$1=startDate, $2=endDate, $3=threshold, $4...=scope params
 *   daily_agg WHERE: performance_date <= $2（全历史下界）
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
  const sql = `
    WITH daily_agg AS (
      SELECT so.client_user_id,
             so.store_id,
             pc.product_kind,
             sipe.performance_date       AS purchase_date,
             SUM(sipe.amount::numeric)   AS day_received,
             COALESCE(
               SUM(sipe.amount::numeric) FILTER (
                 WHERE so.sale_order_type IN ('销售单','转换单')
               ),
               0
             )                           AS purchase_received
        FROM sale_item_performance_events sipe
        JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        JOIN product_skus sk ON sk.sku_id = si.sku_id
        JOIN product_categories pc ON pc.category_id = sk.category_id
       WHERE ${sc.sql}
         AND so.sale_order_type IN ('销售单','转换单','寄存单')
         AND so.status NOT IN ('已关闭','已作废','未审核','待审批','支付失败')
         AND so.client_user_id IS NOT NULL
         AND pc.product_kind IS NOT NULL
         AND sipe.performance_date <= $2
       GROUP BY so.client_user_id, so.store_id, pc.product_kind, sipe.performance_date
      HAVING SUM(sipe.amount::numeric) > 0
    ),
    qualifying_days AS (
      SELECT client_user_id, store_id, product_kind, purchase_date
        FROM daily_agg
       WHERE day_received >= $3
    ),
    repurchase_qualifying_days AS (
      SELECT client_user_id, store_id, product_kind, purchase_date
        FROM daily_agg
       WHERE purchase_received >= $3
    ),
    first_entry AS (
      SELECT client_user_id,
             product_kind,
             MIN(purchase_date) AS entry_date
        FROM qualifying_days
       GROUP BY client_user_id, product_kind
    ),
    period_agg AS (
      SELECT client_user_id, store_id, product_kind, purchase_date,
             purchase_received AS day_received
        FROM daily_agg
       WHERE purchase_date BETWEEN $1 AND $2
         AND purchase_received > 0
    ),
    xinzeng AS (
      SELECT client_user_id, product_kind, entry_date
        FROM first_entry
       WHERE entry_date BETWEEN $1 AND $2
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.product_kind
        FROM repurchase_qualifying_days q
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
