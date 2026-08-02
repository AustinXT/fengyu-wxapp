/**
 * 管理层 - 顾客档案子页（mgmt-customer-list / mgmt-customer-detail）路由
 *
 * 入口：mgmt-dashboard 首页"顾客档案"卡片（entry === 'customers'）
 *
 * 6 个 action：
 *   mgmtCustomer.search        — 默认列表 / 关键字 / 手机号（scope=bound_store_id；50/页分页）
 *   mgmtCustomer.detail        — 顾客档案详情（含越权防护：bound_store_id ∈ scope）
 *   mgmtCustomer.calendar      — 月度消费日历（scope=sale_orders.store_id）
 *   mgmtCustomer.paidOrders    — 已支付订单含明细（scope=sale_orders.store_id）
 *   mgmtCustomer.giftHistory   — 赠送记录（scope=sale_orders.store_id）
 *   mgmtCustomer.refundHistory — 退换记录(scope=sale_orders.store_id)
 *
 * 决策点：
 *   D-mgmt-phone-mask     — 管理层 staffLevel ∈ {headquarters, market} 手机号不脱敏
 *   D-customer-scope-source — 顾客主键过滤用 bound_store_id（确定性主键）
 *   D-detail-record-scope — 详情消费/服务/赠送/退换均按 sale_orders.store_id ∈ scope 过滤
 *   D-cross-scope-customer — 顾客 bound 不在 scope → 详情接口 403
 *   D-search-pagination   — search 默认/关键字分支按 user_id ASC 排序 + 50/页分页（hasMore 由 rows.length===pageSize 推断）
 */

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')
const { validateManagementScope, canAccessManagementLevel } = require('../utils/scope')
const { maskPhone } = require('../utils/pii')

// ====================================================================
// 共享 helper（buildSaleScope/buildClientScope 为与 mgmt-product.js 一致的本地副本；
// scope 校验已统一抽取到 utils/scope.js::validateManagementScope，避免 4 路由拷贝漂移）
// ====================================================================

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
 * 标准入参校验
 */
function validateScopeParams(scopeType, scopeId) {
  if (!['all', 'market', 'store'].includes(scopeType)) {
    throw new Error('INVALID_PARAMS: 范围类型必须是 全部/市场/门店')
  }
  if (scopeType !== 'all' && !scopeId) {
    throw new Error('INVALID_PARAMS: 范围类型为市场/门店时必须提供范围 ID')
  }
}

/** 是否对管理层返回原始手机号（D-mgmt-phone-mask）。
 *  总部 / 市场 / 门店店长均返回全号——店长在管理层视图的数据范围已被 validateManagementScope
 *  锁定在其 managerStoreIds 内（与门店视图同一批顾客），不构成额外隐私降级。 */
function isMgmtFullPhone(auth) {
  return canAccessManagementLevel(auth.staffLevel)
}

/** 解析 scope 名称（与 mgmt-product.js 保持一致） */
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
// scope 内消费 / 服务 / 常购 helper（对 customer.js 同名 helper 的 scope 改造）
// ====================================================================

/**
 * 到店信息（按 service_orders.store_id ∈ scope 过滤）
 */
async function getVisitInfoScoped(clientUserId, scopeType, scopeId) {
  if (!clientUserId) return { lastServiceDate: null, visitFrequency: null }
  // 交易数据跟顾客走：到店统计不按门店过滤（detail 已 assertCustomerInScope 守卫顾客可见性）
  const rows = await pg.query(
    `SELECT
       MAX(so.service_date) AS last_date,
       COUNT(DISTINCT so.service_date) FILTER (WHERE so.service_date >= CURRENT_DATE - INTERVAL '90 days') AS visit_count_90d
     FROM service_orders so
     WHERE so.client_user_id = $1
       AND so.status = '已完成'`,
    [clientUserId],
  )

  const lastDate = rows[0]?.last_date || null
  const count90d = parseInt(rows[0]?.visit_count_90d) || 0

  let visitFrequency = null
  if (count90d >= 12) visitFrequency = '一周一次以上'
  else if (count90d >= 6) visitFrequency = '两周一次'
  else if (count90d >= 3) visitFrequency = '一月一次'
  else if (count90d >= 1) visitFrequency = '偶尔到店'

  return { lastServiceDate: lastDate, visitFrequency }
}

/**
 * 常购商品（scope 内购买次数最多）
 */
async function getTopProductScoped(clientUserId, scopeType, scopeId) {
  if (!clientUserId) return null
  // 交易数据跟顾客走：常购商品不按门店过滤
  const rows = await pg.query(
    `SELECT si.product_name, COUNT(*) AS cnt
       FROM sale_orders o
       JOIN sale_items si ON si.sale_order_id = o.sale_order_id
      WHERE o.client_user_id = $1
        AND o.status IN ('已支付', '已完成')
        AND si.item_direction = '购买'
      GROUP BY si.product_name
      ORDER BY cnt DESC
      LIMIT 1`,
    [clientUserId],
  )
  return rows.length > 0 ? rows[0].product_name : null
}

/**
 * 消费统计（scope 过滤后的 累计 + 年度）
 */
async function getConsumptionStatsScoped(clientUserId, scopeType, scopeId) {
  if (!clientUserId) return { totalConsumption: 0, yearConsumption: 0 }
  const yearStart = new Date(new Date().getFullYear(), 0, 1)
  // $1=clientUserId, $2=yearStart。交易数据跟顾客走：消费统计不按门店过滤
  const rows = await pg.query(
    `SELECT
       COALESCE(SUM(si.received::numeric), 0) AS total,
       COALESCE(SUM(CASE WHEN o.paid_at >= $2 THEN si.received::numeric ELSE 0 END), 0) AS year_total
     FROM sale_orders o
     JOIN sale_items si ON o.sale_order_id = si.sale_order_id
     WHERE o.status = '已支付'
       AND o.client_user_id = $1`,
    [clientUserId, yearStart],
  )
  return {
    totalConsumption: Number(rows[0]?.total || 0),
    yearConsumption: Number(rows[0]?.year_total || 0),
  }
}

/**
 * 顾客越权防护：bound_store_id 必须在 scope 内
 *   scope=all     → 总部已校验，跳过
 *   scope=market  → bound_store_id 必须挂在该市场下属门店
 *   scope=store   → bound_store_id 必须 == scopeId
 */
async function assertCustomerInScope(boundStoreId, scopeType, scopeId) {
  if (scopeType === 'all') return
  if (!boundStoreId) {
    throw new Error('PERMISSION_DENIED: 顾客不在当前 scope 范围内')
  }
  if (scopeType === 'store') {
    if (boundStoreId !== scopeId) {
      throw new Error('PERMISSION_DENIED: 顾客不在当前 scope 范围内')
    }
    return
  }
  // market：用一个 EXISTS 查询验证
  const rows = await pg.query(
    `SELECT 1 FROM stores s
       JOIN org_nodes o ON s.org_node_id = o.id
      WHERE s.store_id = $1 AND o.parent_id = $2 AND o.type = '门店'
      LIMIT 1`,
    [boundStoreId, scopeId],
  )
  if (rows.length === 0) {
    throw new Error('PERMISSION_DENIED: 顾客不在当前 scope 范围内')
  }
}

/**
 * 解析顾客（clientUserId 优先，否则 clientPhone）并做越权守卫：
 * bound_store_id ∈ scope（复用 assertCustomerInScope）。返回 user_id。
 * 交易数据「跟顾客走」：子 Tab 放开数据门店过滤后，由本守卫保留顾客可见性。
 */
async function resolveCustomerInScope(clientUserId, clientPhone, scopeType, scopeId) {
  const rows = await pg.query(
    clientUserId
      ? 'SELECT user_id, bound_store_id FROM client_wechat_users WHERE user_id = $1 LIMIT 1'
      : 'SELECT user_id, bound_store_id FROM client_wechat_users WHERE phone = $1 LIMIT 1',
    [clientUserId || clientPhone],
  )
  if (rows.length === 0) {
    throw new Error('INVALID_PARAMS: 顾客不存在')
  }
  await assertCustomerInScope(rows[0].bound_store_id, scopeType, scopeId)
  return rows[0].user_id
}

// ====================================================================
// search — 默认列表 / 关键字 / 手机号（50/页分页）
// ====================================================================

async function search(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { keyword, phone, page, pageSize, scopeType, scopeId } = ctx.event.payload || {}
  validateScopeParams(scopeType, scopeId)
  validateManagementScope(ctx.auth, scopeType, scopeId)

  const fullPhone = isMgmtFullPhone(ctx.auth)

  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 50))
  const offset = (safePage - 1) * safePageSize

  let rows = []

  if (phone) {
    // 手机号精确：scope 不参与，按 phone 直接命中（仍按 scope 二次过滤）；不分页（最多 0~1 命中）
    const cs = buildClientScope(scopeType, scopeId, 'c', 2)
    rows = await pg.query(
      `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level,
              c.bound_store_id, s.store_name, c.birthday
         FROM client_wechat_users c
         LEFT JOIN stores s ON s.store_id = c.bound_store_id
        WHERE c.phone = $1
          AND ${cs.sql}`,
      [phone.trim(), ...cs.params],
    )
  } else if (keyword && keyword.trim()) {
    const cs = buildClientScope(scopeType, scopeId, 'c', 2)
    const limitIdx = 2 + cs.params.length
    const offsetIdx = limitIdx + 1
    rows = await pg.query(
      `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level,
              c.bound_store_id, s.store_name, c.birthday
         FROM client_wechat_users c
         LEFT JOIN stores s ON s.store_id = c.bound_store_id
        WHERE (c.phone LIKE $1 OR c.name LIKE $1)
          AND ${cs.sql}
        ORDER BY c.user_id ASC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [`%${keyword.trim()}%`, ...cs.params, safePageSize, offset],
    )
  } else {
    const cs = buildClientScope(scopeType, scopeId, 'c', 1)
    const limitIdx = 1 + cs.params.length
    const offsetIdx = limitIdx + 1
    rows = await pg.query(
      `SELECT c.user_id, c.phone, c.name, c.customer_id, c.member_level,
              c.bound_store_id, s.store_name, c.birthday
         FROM client_wechat_users c
         LEFT JOIN stores s ON s.store_id = c.bound_store_id
        WHERE ${cs.sql}
        ORDER BY c.user_id ASC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...cs.params, safePageSize, offset],
    )
  }

  const customers = rows.map((r) => ({
    id: r.customer_id || null,
    clientUserId: r.user_id,
    customerNo: r.customer_id || null,
    name: r.name ? r.name.trim() : '',
    phone: fullPhone ? (r.phone || '') : maskPhone(r.phone),
    phoneMasked: maskPhone(r.phone),
    memberLevel: r.member_level || null,
    storeName: r.store_name ? r.store_name.trim() : '',
    birthday: r.birthday || null,
    tier: null,
    lastServiceDate: null,
    lastPurchaseName: null,
    source: r.customer_id ? 'both' : 'miniprogram',
  }))

  // 补 tier / lastServiceDate / lastPurchaseName（按 scope 过滤）
  const allClientUserIds = customers.map((c) => c.clientUserId).filter(Boolean)

  if (allClientUserIds.length > 0) {
    const yearStart = `${new Date().getFullYear()}-01-01`

    // 年消费（scope 过滤）
    const sc1 = buildSaleScope(scopeType, scopeId, 'o', 3)
    const spendRows = await pg.query(
      `SELECT o.client_user_id,
              COALESCE(SUM(o.total_amount::numeric), 0) AS annual_spend
         FROM sale_orders o
        WHERE o.client_user_id = ANY($1)
          AND o.status = '已支付'
          AND o.paid_at >= $2::date
          AND ${sc1.sql}
        GROUP BY o.client_user_id`,
      [allClientUserIds, yearStart, ...sc1.params],
    )
    const spendMap = {}
    for (const r of spendRows) {
      const amt = Number(r.annual_spend)
      spendMap[r.client_user_id] =
        amt >= 20000 ? 'diamond' : amt >= 5000 ? 'iron' : amt > 0 ? 'fan' : null
    }

    // 最近服务日期（scope 过滤）
    const sc2 = buildSaleScope(scopeType, scopeId, 'so', 2)
    const svcDateRows = await pg.query(
      `SELECT DISTINCT ON (so.client_user_id)
              so.client_user_id, so.service_date
         FROM service_orders so
        WHERE so.client_user_id = ANY($1)
          AND so.status = '已完成'
          AND ${sc2.sql}
        ORDER BY so.client_user_id, so.service_date DESC`,
      [allClientUserIds, ...sc2.params],
    )
    const svcDateMap = {}
    for (const r of svcDateRows) {
      svcDateMap[r.client_user_id] = r.service_date
    }

    // 最近购买商品（scope 过滤）
    const sc3 = buildSaleScope(scopeType, scopeId, 'o', 2)
    const lastPurchaseRows = await pg.query(
      `SELECT DISTINCT ON (o.client_user_id)
              o.client_user_id, si.product_name AS last_product_name
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
        WHERE o.client_user_id = ANY($1)
          AND o.status IN ('已支付', '已完成')
          AND si.item_direction = '购买'
          AND ${sc3.sql}
        ORDER BY o.client_user_id, o.paid_at DESC NULLS LAST, si.sale_item_id ASC`,
      [allClientUserIds, ...sc3.params],
    )
    const lastPurchaseMap = {}
    for (const r of lastPurchaseRows) {
      lastPurchaseMap[r.client_user_id] = r.last_product_name
    }

    for (const item of customers) {
      if (item.clientUserId) {
        item.tier = spendMap[item.clientUserId] || null
        item.lastServiceDate = svcDateMap[item.clientUserId] || null
        item.lastPurchaseName = lastPurchaseMap[item.clientUserId] || null
      }
    }
  }

  const scopeName = await resolveScopeName(scopeType, scopeId)

  ctx.result = {
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    customers,
    page: safePage,
    pageSize: safePageSize,
    hasMore: phone ? false : customers.length === safePageSize,
  }
}

// ====================================================================
// detail — 顾客档案详情（含越权防护）
// ====================================================================

async function detail(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { id, phone: queryPhone, clientUserId: queryClientUserId, scopeType, scopeId } =
    ctx.event.payload || {}
  if (!id && !queryPhone && !queryClientUserId) {
    throw new Error('INVALID_PARAMS: 缺少 id、phone 或 clientUserId 参数')
  }
  validateScopeParams(scopeType, scopeId)
  validateManagementScope(ctx.auth, scopeType, scopeId)

  const fullPhone = isMgmtFullPhone(ctx.auth)

  const selectCols = `c.user_id, c.phone, c.name, c.customer_id, c.member_level,
    c.bound_employee_id, c.skin_type, c.improvement_focus, c.gender, c.notes,
    c.bound_store_id, s.store_name, c.birthday`

  const fromClause = `FROM client_wechat_users c
    LEFT JOIN stores s ON s.store_id = c.bound_store_id`

  let pgUser = null
  if (id) {
    const rows = await pg.query(
      `SELECT ${selectCols} ${fromClause} WHERE c.customer_id = $1 LIMIT 1`,
      [id],
    )
    if (rows.length > 0) pgUser = rows[0]
  }
  if (!pgUser && queryClientUserId) {
    const rows = await pg.query(
      `SELECT ${selectCols} ${fromClause} WHERE c.user_id = $1 LIMIT 1`,
      [queryClientUserId],
    )
    if (rows.length > 0) pgUser = rows[0]
  }
  if (!pgUser && queryPhone && queryPhone.trim()) {
    const rows = await pg.query(
      `SELECT ${selectCols} ${fromClause} WHERE c.phone = $1 LIMIT 1`,
      [queryPhone.trim()],
    )
    if (rows.length > 0) pgUser = rows[0]
  }

  if (!pgUser) {
    throw new Error('INVALID_PARAMS: 顾客不存在')
  }

  // 越权防护：bound_store_id ∈ scope
  await assertCustomerInScope(pgUser.bound_store_id, scopeType, scopeId)

  const phone = pgUser.phone || ''

  // 姓名回退
  let name = pgUser.name || ''
  if (!name && phone) {
    const nameRows = await pg.query(
      `SELECT customer_name FROM sale_orders
         WHERE client_phone = $1 AND customer_name IS NOT NULL AND customer_name != ''
         ORDER BY created_at DESC LIMIT 1`,
      [phone],
    )
    if (nameRows.length > 0) name = nameRows[0].customer_name
  }

  // 美容师名称
  let preferredStaffName = null
  if (pgUser.bound_employee_id) {
    const staffRows = await pg.query(
      'SELECT name FROM staff_wechat_users WHERE employee_id = $1',
      [pgUser.bound_employee_id],
    )
    if (staffRows.length > 0) preferredStaffName = staffRows[0].name || null
  }

  const clientUserId = pgUser.user_id
  const { totalConsumption, yearConsumption } = await getConsumptionStatsScoped(
    clientUserId,
    scopeType,
    scopeId,
  )
  const [visitInfo, topProduct] = await Promise.all([
    getVisitInfoScoped(clientUserId, scopeType, scopeId),
    getTopProductScoped(clientUserId, scopeType, scopeId),
  ])

  ctx.result = {
    id: pgUser.customer_id || null,
    clientUserId,
    name,
    gender: pgUser.gender || null,
    phone: fullPhone ? phone : maskPhone(phone),
    phoneMasked: maskPhone(phone),
    memberLevel: pgUser.member_level || null,
    storeName: pgUser.store_name ? pgUser.store_name.trim() : '',
    preferredStaffName,
    skinType: pgUser.skin_type || null,
    focusAreas: pgUser.improvement_focus || null,
    notes: pgUser.notes || null,
    lastServiceDate: visitInfo.lastServiceDate,
    visitFrequency: visitInfo.visitFrequency,
    topProductName: topProduct,
    totalConsumption,
    yearConsumption,
    birthday: pgUser.birthday || null,
    source: pgUser.customer_id ? 'both' : 'miniprogram',
  }
}

// ====================================================================
// calendar — 月度消费日历（按 sale_orders.store_id ∈ scope）
// ====================================================================

async function calendar(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { clientUserId, clientPhone, year, month, scopeType, scopeId } =
    ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }
  if (!year || !month) {
    throw new Error('INVALID_PARAMS: 缺少 year 或 month')
  }
  validateScopeParams(scopeType, scopeId)
  validateManagementScope(ctx.auth, scopeType, scopeId)

  const startDate = new Date(year, month - 1, 1)
  const endDate = new Date(year, month, 1)

  // 交易数据跟顾客走：解析顾客 + 越权守卫，放开门店过滤、按顾客查全量
  const resolvedUserId = await resolveCustomerInScope(clientUserId, clientPhone, scopeType, scopeId)
  const params = [startDate, endDate, resolvedUserId]
  const whereClause = `o.status = '已支付' AND o.paid_at >= $1 AND o.paid_at < $2 AND o.client_user_id = $3`

  // 2026-05-20 P0-5/P1-8 修复：
  //   1. dailySummary 原 INNER JOIN sale_items 会漏掉 sale_orders.received>0 但无 sale_items 行的订单
  //      （如 FY-XSD-WX-2605190001/0002/9103/0003 这类测试数据/缺明细订单），整日在日历中消失。
  //   2. dailySummary 取 SUM(si.received) 与 orderRows 取 o.total_amount 双口径不一致。
  //   现统一改为 sale_orders.received - refunded_amount（与 storeRevenue / salesData 同口径），
  //   不再 JOIN sale_items；明细行展示由 paidOrders action 单独提供。
  const netRevExpr = `(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric)`

  const rows = await pg.query(
    `SELECT
       DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai') AS pay_date,
       COUNT(DISTINCT o.sale_order_id) AS order_count,
       COALESCE(SUM(${netRevExpr}), 0) AS total_received
     FROM sale_orders o
     WHERE ${whereClause}
     GROUP BY DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai')
     ORDER BY pay_date`,
    params,
  )

  const orderRows = await pg.query(
    `SELECT
       o.sale_order_id, o.sale_order_type, o.store_id, o.payment_method,
       o.paid_at, o.client_phone, o.customer_name,
       DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai') AS pay_date,
       ${netRevExpr} AS total_received
     FROM sale_orders o
     WHERE ${whereClause}
     ORDER BY o.paid_at DESC`,
    params,
  )

  ctx.result = {
    year,
    month,
    dailySummary: rows.map((r) => ({
      date: r.pay_date,
      orderCount: parseInt(r.order_count),
      totalReceived: parseFloat(r.total_received),
    })),
    orders: orderRows.map((r) => ({
      saleOrderId: r.sale_order_id,
      orderType: r.sale_order_type,
      storeId: r.store_id,
      paymentMethod: r.payment_method,
      paidAt: r.paid_at,
      payDate: r.pay_date,
      clientPhone: r.client_phone,
      customerName: r.customer_name,
      totalReceived: parseFloat(r.total_received),
    })),
  }
}

// ====================================================================
// paidOrders — 有效收款订单含明细（疗程卡 Tab 可核销卡数据源；交易数据跟顾客走）
// ====================================================================

async function paidOrders(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { clientUserId, clientPhone, scopeType, scopeId } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }
  validateScopeParams(scopeType, scopeId)
  validateManagementScope(ctx.auth, scopeType, scopeId)

  // 交易数据跟顾客走：解析顾客 + 越权守卫（bound_store_id ∈ scope），放开门店过滤、按顾客查全量
  // 状态口径：有效收款订单（已支付 + 部分支付 + 已完成），部分支付疗程卡按 paid_sessions 限额核销。
  const resolvedUserId = await resolveCustomerInScope(clientUserId, clientPhone, scopeType, scopeId)
  const params = [resolvedUserId]
  const whereClause = `o.status IN ('已支付', '部分支付', '已完成') AND o.client_user_id = $1`

  const orders = await pg.query(
    `SELECT o.sale_order_id, o.status, o.paid_at, o.store_id, s.store_name, o.sale_order_type
       FROM sale_orders o
       LEFT JOIN stores s ON s.store_id = o.store_id
      WHERE ${whereClause}
      ORDER BY o.paid_at DESC`,
    params,
  )

  if (orders.length === 0) {
    const scopeName = await resolveScopeName(scopeType, scopeId)
    ctx.result = {
      scope: { type: scopeType, id: scopeId || null, name: scopeName },
      orders: [],
    }
    return
  }

  const orderIds = orders.map((o) => o.sale_order_id)
  const items = await pg.query(
    `SELECT
       si.sale_order_id, si.sale_item_id, si.store_id,
       si.session_count, si.remaining_sessions, si.paid_sessions,
       si.sku_id, si.product_type, si.product_name,
       si.unit_real_price,
       pc.category_name, pc.product_kind,
       COALESCE(pc_parent.display_color, pc.display_color) AS category_color
     FROM sale_items si
     JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
     LEFT JOIN product_skus ps ON si.sku_id = ps.sku_id
     LEFT JOIN product_categories pc ON ps.category_id = pc.category_id
     LEFT JOIN product_categories pc_parent ON pc_parent.category_name = pc.product_kind AND pc_parent.product_kind IS NULL
     WHERE si.sale_order_id = ANY($1)
       AND (
         si.item_direction = '购买'
         OR (o.sale_order_type = '转换单' AND si.item_direction = '转入')
       )
       AND (
         si.paid_sessions IS NULL
         OR si.paid_sessions > (si.session_count - si.remaining_sessions)
       )
     ORDER BY si.sale_item_id`,
    [orderIds],
  )

  const itemsByOrder = {}
  for (const item of items) {
    if (!itemsByOrder[item.sale_order_id]) itemsByOrder[item.sale_order_id] = []
    itemsByOrder[item.sale_order_id].push({
      saleItemId: item.sale_item_id,
      storeId: item.store_id,
      itemName: item.product_name || '',
      spec: '',
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      totalSessions: item.session_count,
      paidSessions: item.paid_sessions,
      productType: item.product_type || '',
      unitRealPrice: item.unit_real_price != null ? Number(item.unit_real_price).toFixed(2) : '',
      category: item.category_name || '',
      categoryColor: item.category_color || '',
      productKind: item.product_kind || '',
    })
  }

  const scopeName = await resolveScopeName(scopeType, scopeId)
  ctx.result = {
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    orders: orders.map((o) => ({
      orderId: o.sale_order_id,
      saleOrderId: o.sale_order_id,
      status: o.status,
      paidAt: o.paid_at,
      storeId: o.store_id,
      storeName: o.store_name || '',
      saleOrderType: o.sale_order_type || '',
      items: itemsByOrder[o.sale_order_id] || [],
    })),
  }
}

// ====================================================================
// orderHistory — 顾客消费记录（全状态 + 跨门店，仅展示用）
// 与 paidOrders 解耦：paidOrders 供疗程卡 Tab 可核销卡（已支付/部分支付，按 paid_sessions 限额核销），
// 本 action 查全部状态供消费记录列表展示，items 不参与核销。
// ====================================================================

async function orderHistory(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { clientUserId, clientPhone, scopeType, scopeId } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }
  validateScopeParams(scopeType, scopeId)
  validateManagementScope(ctx.auth, scopeType, scopeId)

  // 交易数据跟顾客走：解析顾客 + 越权守卫（bound_store_id ∈ scope），放开门店 + 不限状态
  const resolvedUserId = await resolveCustomerInScope(clientUserId, clientPhone, scopeType, scopeId)
  const params = [resolvedUserId]
  const whereClause = `o.client_user_id = $1`

  // 待支付订单 paid_at 为 NULL，按 COALESCE(paid_at, created_at) 排序避免乱序
  const orders = await pg.query(
    `SELECT o.sale_order_id, o.status, o.paid_at, o.created_at,
            o.payable_amount, o.received, o.store_id, s.store_name, o.remark
       FROM sale_orders o
       LEFT JOIN stores s ON s.store_id = o.store_id
      WHERE ${whereClause}
      ORDER BY COALESCE(o.paid_at, o.created_at) DESC`,
    params,
  )

  // 注：返回纯数组（与 customer.orderHistory 一致），前端 (...||[]).map 直接消费
  if (orders.length === 0) {
    ctx.result = []
    return
  }

  // 消费记录仅展示商品名，不做 paidOrders 的退款冻结/可核销过滤
  const orderIds = orders.map((o) => o.sale_order_id)
  const items = await pg.query(
    `SELECT si.sale_order_id, si.sale_item_id, si.product_name, si.product_type
     FROM sale_items si
     WHERE si.sale_order_id = ANY($1)
     ORDER BY si.sale_item_id`,
    [orderIds],
  )

  const itemsByOrder = {}
  for (const item of items) {
    if (!itemsByOrder[item.sale_order_id]) itemsByOrder[item.sale_order_id] = []
    itemsByOrder[item.sale_order_id].push({
      saleItemId: item.sale_item_id,
      itemName: item.product_name || '',
      spec: '',
      productType: item.product_type || '',
    })
  }

  ctx.result = orders.map((o) => ({
    orderId: o.sale_order_id,
    saleOrderId: o.sale_order_id,
    status: o.status,
    payableAmount: o.payable_amount,
    received: o.received,
    paidAt: o.paid_at,
    createdAt: o.created_at,
    storeId: o.store_id,
    storeName: o.store_name || '',
    remark: o.remark || '',
    items: itemsByOrder[o.sale_order_id] || [],
  }))
}

// ====================================================================
// serviceHistory — 服务记录（交易数据跟顾客走：跨门店 + 不限状态）
// ====================================================================

async function serviceHistory(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { clientUserId, clientPhone, scopeType, scopeId } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }
  validateScopeParams(scopeType, scopeId)
  validateManagementScope(ctx.auth, scopeType, scopeId)

  // 交易数据跟顾客走：解析顾客 + 越权守卫（bound_store_id ∈ scope），放开门店 + 不限状态
  const resolvedUserId = await resolveCustomerInScope(clientUserId, clientPhone, scopeType, scopeId)

  const serviceOrders = await pg.query(
    `SELECT so.service_order_id, so.status, so.service_date,
            so.assigned_employee_id, so.client_user_id, so.appointment_id,
            so.started_at, so.completed_at, so.created_at,
            so.store_id, s.store_name
       FROM service_orders so
       LEFT JOIN stores s ON s.store_id = so.store_id
      WHERE so.client_user_id = $1
      ORDER BY so.service_date DESC, so.created_at DESC`,
    [resolvedUserId],
  )

  if (serviceOrders.length === 0) {
    ctx.result = []
    return
  }

  // 批量查询服务明细摘要（项目名）
  const soIds = serviceOrders.map((s) => s.service_order_id)
  const itemsSummary = await pg.query(
    `SELECT si.service_order_id, COALESCE(sli.product_name, '') AS product_name
       FROM service_items si
       LEFT JOIN sale_items sli ON si.sale_item_id = sli.sale_item_id
      WHERE si.service_order_id = ANY($1)
      ORDER BY si.sale_item_id`,
    [soIds],
  )
  const itemsMap = {}
  for (const i of itemsSummary) {
    if (!itemsMap[i.service_order_id]) itemsMap[i.service_order_id] = []
    itemsMap[i.service_order_id].push({
      itemName: i.product_name,
      spec: '',
    })
  }

  // 批量查询员工姓名
  const staffWfIds = [...new Set(serviceOrders.map((s) => s.assigned_employee_id).filter(Boolean))]
  const staffNameMap = {}
  if (staffWfIds.length > 0) {
    const staffRows = await pg.query(
      'SELECT employee_id, name FROM staff_wechat_users WHERE employee_id = ANY($1)',
      [staffWfIds],
    )
    for (const r of staffRows) staffNameMap[r.employee_id] = r.name || ''
  }

  ctx.result = serviceOrders.map((so) => ({
    id: so.service_order_id,
    serviceOrderId: so.service_order_id,
    status: so.status,
    serviceTime: so.service_date,
    startTime: so.started_at,
    completedTime: so.completed_at,
    staffName: staffNameMap[so.assigned_employee_id] || '',
    appointmentId: so.appointment_id,
    storeId: so.store_id,
    storeName: so.store_name || '',
    items: itemsMap[so.service_order_id] || [],
  }))
}

// ====================================================================
// giftHistory — 赠送记录（按 sale_orders.store_id ∈ scope）
// ====================================================================

async function giftHistory(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { clientUserId, clientPhone, scopeType, scopeId } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }
  validateScopeParams(scopeType, scopeId)
  validateManagementScope(ctx.auth, scopeType, scopeId)

  // 交易数据跟顾客走：解析顾客 + 越权守卫，放开门店过滤、按顾客查全量
  const resolvedUserId = await resolveCustomerInScope(clientUserId, clientPhone, scopeType, scopeId)
  const params = [resolvedUserId]
  const whereClause = `o.client_user_id = $1`

  // 组合套餐订单（保留 customer.js 的 TODO 占位逻辑）
  const promoOrders = await pg.query(
    `SELECT o.sale_order_id, o.status, o.sale_order_type, o.total_amount,
            o.created_at, o.paid_at
       FROM sale_orders o
      WHERE ${whereClause}
        AND FALSE -- TODO: 组合套餐已合并为销售单，需另行标记
        AND o.status IN ('已支付', '已完成')
      ORDER BY o.created_at DESC`,
    params,
  )

  // 套餐内赠品（从未收款的明细行：received=0 且 pending_received=0）。
  // 2026-06-08 received 转净额后：pending_received>0 但 received=0 是「全额退款后净额归零」，非赠品，须用 pending_received=0 排除。
  const giftItems = await pg.query(
    `SELECT si.sale_item_id, si.sale_order_id, si.product_name,
            si.quantity, si.session_count, si.remaining_sessions, si.paid_sessions,
            si.received, o.created_at, o.paid_at
       FROM sale_items si
       JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
      WHERE ${whereClause}
        AND o.status IN ('已支付', '已完成')
        AND o.sale_order_type NOT IN ('内部单', '转换单', '寄存单')
        AND si.item_direction = '购买'
        AND si.received::numeric = 0
        AND si.pending_received::numeric = 0
      ORDER BY o.created_at DESC`,
    params,
  )

  const promoOrderIds = promoOrders.map((o) => o.sale_order_id)
  let promoItems = []
  if (promoOrderIds.length > 0) {
    promoItems = await pg.query(
      `SELECT si.sale_order_id, si.sale_item_id, si.product_name,
              si.quantity, si.session_count, si.remaining_sessions, si.paid_sessions, si.received
         FROM sale_items si WHERE si.sale_order_id = ANY($1) ORDER BY si.sale_item_id`,
      [promoOrderIds],
    )
  }

  const promoItemsByOrder = {}
  for (const i of promoItems) {
    if (!promoItemsByOrder[i.sale_order_id]) promoItemsByOrder[i.sale_order_id] = []
    promoItemsByOrder[i.sale_order_id].push({
      productName: i.product_name,
      specName: null,
      quantity: i.quantity,
      sessionCount: i.session_count,
      remainingSessions: i.remaining_sessions,
      paidSessions: i.paid_sessions,
    })
  }

  const scopeName = await resolveScopeName(scopeType, scopeId)
  ctx.result = {
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    promoOrders: promoOrders.map((o) => ({
      saleOrderId: o.sale_order_id,
      type: o.sale_order_type,
      status: o.status,
      totalAmount: Number(o.total_amount),
      createdAt: o.created_at,
      paidAt: o.paid_at,
      items: promoItemsByOrder[o.sale_order_id] || [],
    })),
    giftItems: giftItems.map((i) => ({
      saleItemId: i.sale_item_id,
      saleOrderId: i.sale_order_id,
      productName: i.product_name,
      specName: null,
      quantity: i.quantity,
      sessionCount: i.session_count,
      remainingSessions: i.remaining_sessions,
      paidSessions: i.paid_sessions,
      createdAt: i.created_at,
    })),
  }
}

// ====================================================================
// refundHistory — 退换记录（按 sale_orders.store_id ∈ scope）
// ====================================================================

async function refundHistory(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { clientUserId, clientPhone, scopeType, scopeId } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }
  validateScopeParams(scopeType, scopeId)
  validateManagementScope(ctx.auth, scopeType, scopeId)

  // 交易数据跟顾客走：解析顾客 + 越权守卫，放开门店过滤、按顾客查全量
  const resolvedUserId = await resolveCustomerInScope(clientUserId, clientPhone, scopeType, scopeId)
  const params = [resolvedUserId]
  const whereClause = `o.client_user_id = $1`

  // 退款数据源：sale_order_payments[change_type='退款']（refund_reason / audit_* / note 已在主表）
  const refundRows = await pg.query(
    `SELECT
       sop.id AS payment_id,
       sop.sale_order_id,
       sop.amount,
       sop.status,
       sop.created_at,
       sop.paid_at,
       sop.payment_method,
       sop.refund_reason,
       sop.audit_at,
       sop.audit_remark,
       sop.note AS detail_note
     FROM sale_order_payments sop
     JOIN sale_orders o ON o.sale_order_id = sop.sale_order_id
    WHERE ${whereClause}
      AND sop.change_type = '退款'
    ORDER BY sop.created_at DESC`,
    params,
  )

  // 转换单（仍保留 sale_orders 路径）
  const convOrders = await pg.query(
    `SELECT o.sale_order_id, o.status, o.sale_order_type, o.total_amount,
            o.created_at, o.paid_at
       FROM sale_orders o
      WHERE ${whereClause}
        AND o.sale_order_type = '转换单'
      ORDER BY o.created_at DESC`,
    params,
  )

  if (refundRows.length === 0 && convOrders.length === 0) {
    const scopeName = await resolveScopeName(scopeType, scopeId)
    ctx.result = {
      scope: { type: scopeType, id: scopeId || null, name: scopeName },
      orders: [],
    }
    return
  }

  // 转换单的明细
  const convOrderIds = convOrders.map(o => o.sale_order_id)
  let convItems = []
  if (convOrderIds.length > 0) {
    convItems = await pg.query(
      `SELECT si.sale_order_id, si.sale_item_id, si.item_direction,
              si.product_name, si.quantity, si.received
         FROM sale_items si WHERE si.sale_order_id = ANY($1) ORDER BY si.sale_item_id`,
      [convOrderIds],
    )
  }
  const convItemsByOrder = {}
  for (const i of convItems) {
    if (!convItemsByOrder[i.sale_order_id]) convItemsByOrder[i.sale_order_id] = []
    convItemsByOrder[i.sale_order_id].push({
      saleItemId: i.sale_item_id,
      direction: i.item_direction,
      productName: i.product_name,
      specName: null,
      quantity: i.quantity,
      received: Number(i.received),
    })
  }

  const refunds = refundRows.map(r => {
    let parsedDetail = null
    if (r.detail_note) {
      try {
        parsedDetail = typeof r.detail_note === 'string' ? JSON.parse(r.detail_note) : r.detail_note
      } catch (_) {}
    }
    return {
      paymentId: r.payment_id,
      saleOrderId: r.sale_order_id,
      type: '退款',
      status: r.status,
      totalAmount: Number(r.amount),
      refundReason: r.refund_reason,
      handlingFee: parsedDetail?.handlingFee ?? null,
      refOrderId: r.sale_order_id,
      paymentMethod: r.payment_method,
      createdAt: r.created_at,
      paidAt: r.paid_at,
      approvedAt: r.audit_at,
      rejectedReason: r.status === '已作废' ? r.audit_remark : null,
      items: parsedDetail?.items || [],
    }
  })

  const conversions = convOrders.map(o => ({
    saleOrderId: o.sale_order_id,
    type: o.sale_order_type,
    status: o.status,
    totalAmount: Number(o.total_amount),
    createdAt: o.created_at,
    paidAt: o.paid_at,
    items: convItemsByOrder[o.sale_order_id] || [],
  }))

  const scopeName = await resolveScopeName(scopeType, scopeId)
  ctx.result = {
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    orders: [...refunds, ...conversions].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ),
  }
}

module.exports = {
  search,
  detail,
  calendar,
  paidOrders,
  orderHistory,
  serviceHistory,
  giftHistory,
  refundHistory,
}
