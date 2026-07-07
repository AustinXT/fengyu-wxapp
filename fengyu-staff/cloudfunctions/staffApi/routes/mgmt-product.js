

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')
const { getMemberThreshold } = require('../utils/config')






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






async function cardHolders(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { scopeType, scopeId } = ctx.event.payload || {}

  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: scopeType 必须是 all/market/store')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: scopeType 为 market/store 时必须提供 scopeId')
  }

  validateScope(ctx.auth, scopeType, scopeId)

  const t0 = Date.now()

  
  const sc = buildSaleScope(scopeType, scopeId, 'so', 1)
  const cardSql = `
    SELECT pc.product_kind AS product_kind,
           COUNT(DISTINCT so.client_user_id)::int AS count
      FROM sale_items si
      JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
      JOIN product_skus sk ON sk.sku_id = si.sku_id
      JOIN product_categories pc ON pc.category_id = sk.category_id
     WHERE ${sc.sql}
       AND si.product_type = '疗程卡'
       AND si.remaining_sessions > 0
       AND so.sale_order_type IN ('销售单','转换单','寄存单')
       AND so.status = '已支付'
       AND so.client_user_id IS NOT NULL
       AND pc.product_kind IS NOT NULL
     GROUP BY pc.product_kind`

  
  
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






async function cycleStats(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { period, scopeType, scopeId } = ctx.event.payload || {}

  if (!['month', 'lastMonth', 'year'].includes(period)) {
    throw new Error('INVALID_PARAMS: period 必须是 month/lastMonth/year')
  }
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: scopeType 必须是 all/market/store')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: scopeType 为 market/store 时必须提供 scopeId')
  }

  validateScope(ctx.auth, scopeType, scopeId)

  const { startDate, endDate } = getSalesDataPeriod(period)
  const threshold = await getMemberThreshold()

  
  const sc = buildSaleScope(scopeType, scopeId, 'so', 4)
  const params = [startDate, endDate, threshold, ...sc.params]

  const sql = `
    WITH daily_agg AS (
      SELECT so.client_user_id,
             so.store_id,
             pc.product_kind,
             so.paid_at::date           AS purchase_date,
             SUM(si.received::numeric)  AS day_received
        FROM sale_items si
        JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
        JOIN product_skus sk ON sk.sku_id = si.sku_id
        JOIN product_categories pc ON pc.category_id = sk.category_id
       WHERE ${sc.sql}
         AND so.sale_order_type IN ('销售单','转换单')
         AND so.status = '已支付'
         AND so.client_user_id IS NOT NULL
         AND pc.product_kind IS NOT NULL
         AND so.paid_at::date <= $2
       GROUP BY so.client_user_id, so.store_id, pc.product_kind, so.paid_at::date
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
      SELECT client_user_id, product_kind
        FROM first_entry
       WHERE entry_date BETWEEN $1 AND $2
    ),
    fugou AS (
      SELECT DISTINCT q.client_user_id, q.product_kind
        FROM qualifying_days q
        JOIN first_entry f ON f.client_user_id = q.client_user_id
                          AND f.product_kind   = q.product_kind
       WHERE q.purchase_date BETWEEN $1 AND $2
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
    else if (r.group_kind === 'repurchase') repurchase.push(row)
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
