/**
 * 管理层 - 顾客档案子页（mgmt-customer-list / mgmt-customer-detail）路由
 *
 * 入口：mgmt-dashboard 首页"顾客档案"卡片（entry === 'customers'）
 *
 * 9 个 action：
 *   mgmtCustomer.search         — 默认列表 / 关键字 / 手机号（scope=bound_store_id；50/页分页）
 *   mgmtCustomer.detail         — 顾客档案详情（含越权防护：bound_store_id ∈ scope）
 *   mgmtCustomer.calendar       — 月度消费日历（scope=sale_orders.store_id）
 *   mgmtCustomer.paidOrders     — 已支付订单含明细（scope=sale_orders.store_id）
 *   mgmtCustomer.orderHistory   — 消费记录（全状态，仅展示不参与核销）
 *   mgmtCustomer.serviceHistory — 服务记录
 *   mgmtCustomer.giftHistory    — 赠送记录（scope=sale_orders.store_id）
 *   mgmtCustomer.refundHistory  — 退换记录(scope=sale_orders.store_id)
 *   mgmtCustomer.homeProducts   — 家居产品资产（跟顾客走，跨店全量；与 customer.homeProducts 同口径）
 *
 * 决策点：
 *   D-mgmt-phone-mask     — 拥有数据中心权限的管理层手机号不脱敏
 *   D-customer-scope-source — 顾客主键过滤用 bound_store_id（确定性主键）
 *   D-detail-record-scope — 详情消费/服务/赠送/退换均按 sale_orders.store_id ∈ scope 过滤
 *   D-cross-scope-customer — 顾客 bound 不在 scope → 详情接口 403
 *   D-search-pagination   — search 默认/关键字分支按 user_id ASC 排序 + 50/页分页（hasMore 由 rows.length===pageSize 推断）
 */

const pg = require('../db/pg')
const { requireManagementLevel } = require('../middleware/auth')
const { validateManagementScope, buildManagementStoreScope } = require('../utils/scope')
const { maskPhone } = require('../utils/pii')
const { excludeDepositRefundSql } = require('../utils/consume-filter')
const { shanghaiDateStr } = require('../utils/datetime')
const { assertPaymentAttributionReady } = require('../utils/attribution-guard')

// ====================================================================
// 共享 helper（buildSaleScope/buildClientScope 为与 mgmt-product.js 一致的本地副本；
// scope 校验已统一抽取到 utils/scope.js::validateManagementScope，避免 4 路由拷贝漂移）
// ====================================================================

/**
 * 构造 sale/service 表的 store_id scope 过滤片段
 */
function buildSaleScope(scopeType, scopeId, alias, startIdx) {
  return buildManagementStoreScope(scopeType, scopeId, `${alias}.store_id`, startIdx)
}

/** client_wechat_users.bound_store_id scope */
function buildClientScope(scopeType, scopeId, alias, startIdx) {
  return buildManagementStoreScope(scopeType, scopeId, `${alias}.bound_store_id`, startIdx)
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
 *  数据中心权限是管理层视图及其 scope 内数据的唯一准入条件。 */
function isMgmtFullPhone(auth) {
  return !!auth.hasDataCenterDashboard
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
 * 消费和实耗统计（交易数据跟顾客走，累计 + 年度）。
 * 仅销售单、转换单计入消费；寄存单只是剩余服务权益初始化，不能重复计入。
 */
async function getConsumptionStatsScoped(clientUserId, scopeType, scopeId) {
  if (!clientUserId) {
    return {
      totalConsumption: 0,
      yearConsumption: 0,
      totalActualConsumption: 0,
      yearActualConsumption: 0,
    }
  }
  // 年度消费直读款项归属日期：未迁库时首次支付行 100% 为 NULL，三值逻辑会把正数主体
  // 全部吞掉、只剩退款负数（dev 实测年度消费变 −425801.66）。宁可报错也不给运营看负数。
  // ⚠ 放在空值短路**之后**：无 clientUserId 时本就零查询直接返回 0，不该为此打探针。
  await assertPaymentAttributionReady(pg)
  const yearStart = `${shanghaiDateStr().slice(0, 4)}-01-01`
  // $1=clientUserId, $2=yearStart。交易数据跟顾客走：消费统计不按门店过滤
  const rows = await pg.query(
    `WITH order_stats AS (
       SELECT
       COALESCE(SUM(
         CASE
           WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_order_id = o.sale_order_id)
           THEN (SELECT SUM(si2.received::numeric) FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
           ELSE o.received::numeric
         END
       ), 0) AS total
       FROM sale_orders o
       WHERE o.status IN ('已支付', '部分支付', '已完成')
         AND o.sale_order_type IN ('销售单', '转换单')
         AND o.client_user_id = $1
     ), year_payment_stats AS (
       SELECT COALESCE(SUM(
         sop.amount::numeric
       ), 0) AS year_total
       FROM sale_order_payments sop
       JOIN sale_orders o ON o.sale_order_id = sop.sale_order_id
       WHERE sop.status = '已支付'
         AND o.sale_order_type IN ('销售单', '转换单')
         AND o.client_user_id = $1
         AND o.legacy_source IS DISTINCT FROM 'workfine'
         AND sop.performance_attribution_date >= $2::date
         AND sop.performance_attribution_date < ($2::date + INTERVAL '1 year')
     ), legacy_year_stats AS (
       SELECT
       COALESCE(SUM(
         CASE
           WHEN EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_order_id = o.sale_order_id)
           THEN (SELECT SUM(si2.received::numeric) FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
           ELSE o.received::numeric
         END
       ), 0) AS year_total
       FROM sale_orders o
       WHERE o.status IN ('已支付', '部分支付', '已完成')
         AND o.sale_order_type IN ('销售单', '转换单')
         AND o.client_user_id = $1
         AND o.legacy_source = 'workfine'
         AND o.performance_attribution_date >= $2::date
         AND o.performance_attribution_date < ($2::date + INTERVAL '1 year')
     ), actual_stats AS (
       SELECT
         COALESCE(SUM(sit.unit_real_price::numeric * sit.session_used), 0) AS total_actual_consumption,
         COALESCE(SUM(CASE WHEN so.service_date >= $2::date
           THEN sit.unit_real_price::numeric * sit.session_used ELSE 0 END), 0) AS year_actual_consumption
       FROM service_orders so
       JOIN service_items sit ON sit.service_order_id = so.service_order_id
       WHERE so.client_user_id = $1
         AND so.status = '已完成'
         AND ${excludeDepositRefundSql('so')}
     )
     SELECT order_stats.total,
            year_payment_stats.year_total + legacy_year_stats.year_total AS year_total,
            actual_stats.total_actual_consumption, actual_stats.year_actual_consumption
       FROM order_stats
       CROSS JOIN year_payment_stats
       CROSS JOIN legacy_year_stats
       CROSS JOIN actual_stats`,
    [clientUserId, yearStart],
  )
  const stats = rows[0] || {}
  return {
    totalConsumption: Number(stats.total || 0),
    yearConsumption: Number(stats.year_total || 0),
    totalActualConsumption: Number(stats.total_actual_consumption || 0),
    yearActualConsumption: Number(stats.year_actual_consumption || 0),
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
  // market：按递归组织树验证，覆盖任意层级下属门店。
  const storeScope = buildManagementStoreScope('market', scopeId, 's.store_id', 2)
  const rows = await pg.query(
    `SELECT 1 FROM stores s
      WHERE s.store_id = $1 AND ${storeScope.sql}
      LIMIT 1`,
    [boundStoreId, ...storeScope.params],
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
    birthday: r.birthday ?? null,
    tier: null,
    lastServiceDate: null,
    lastPurchaseName: null,
    source: r.customer_id ? 'both' : 'miniprogram',
  }))

  // 补 tier / lastServiceDate / lastPurchaseName（按 scope 过滤）
  const allClientUserIds = customers.map((c) => c.clientUserId).filter(Boolean)

  if (allClientUserIds.length > 0) {
    // ⚠ 与详情（getConsumptionStatsScoped）用同一算法取年份：
    // `new Date().getFullYear()` 依赖进程时区，容器 TZ 丢失时上海 1/1 08:00 前会取到上一年，
    // 与详情的 shanghaiDateStr() 分叉。
    const yearStart = `${shanghaiDateStr().slice(0, 4)}-01-01`

    // 年消费（scope 过滤）—— 只用于下面的 tier 徽章分档，列表不直接展示该金额
    // 订单级归属日期由 0009 起全量回填、实测 NULL 率 0（legacy 16248 单亦然），
    // 本不受未迁库影响；但与详情同页展示，口径未就绪时一起挡住更一致（#141）
    await assertPaymentAttributionReady(pg)
    // 日期口径：订单级业绩归属日期（#141），与详情的落年口径一致。
    // ⚠ 必须是**半开区间** [yearStart, yearStart+1year)：
    // 改前按 paid_at 时无上界是无害的（实付日不可能落到未来），但归属日期可被人工
    // 调整到订单日 ±7 天（见 order.js 的 min/max_performance_date 校验），
    // 跨年那 7 天的订单会被计进今年 —— 而详情用半开区间会把它排除，两处再次分叉。
    // 金额公式与详情不同是**有意的**：详情 SUM(sop.amount) 是款项级实收，
    // 这里 SUM(o.total_amount) 是订单级应付总额，只服务于徽章分档。
    const sc1 = buildSaleScope(scopeType, scopeId, 'o', 3)
    const spendRows = await pg.query(
      `SELECT o.client_user_id,
              COALESCE(SUM(o.total_amount::numeric), 0) AS annual_spend
         FROM sale_orders o
        WHERE o.client_user_id = ANY($1)
          AND o.status = '已支付'
          AND o.performance_attribution_date >= $2::date
          AND o.performance_attribution_date < ($2::date + INTERVAL '1 year')
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
    c.bound_employee_id, c.skin_type, c.improvement_focus,
    c.skin_issue, c.wellness_preference, c.gender, c.notes, c.customer_source,
    COALESCE(promoter.name, c.promoter_employee_name) AS promoter_employee_name,
    c.inviter_user_id, c.invited_at, c.customer_type,
    c.spending_tier, c.monthly_activity, c.customer_status, c.birthday,
    c.occupation, c.is_married, c.wechat_name, c.points_balance,
    c.bound_store_id, s.store_name, inviter.name AS inviter_name,
    inviter.phone AS inviter_phone`

  const fromClause = `FROM client_wechat_users c
    LEFT JOIN stores s ON s.store_id = c.bound_store_id
    LEFT JOIN staff_wechat_users promoter ON promoter.employee_id = c.promoter_employee_id
    LEFT JOIN client_wechat_users inviter ON inviter.user_id = c.inviter_user_id`

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
  const {
    totalConsumption,
    yearConsumption,
    totalActualConsumption,
    yearActualConsumption,
  } = await getConsumptionStatsScoped(
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
    customerSource: pgUser.customer_source || null,
    promoterEmployeeName: pgUser.promoter_employee_name || null,
    inviterName: pgUser.inviter_name || null,
    inviterPhone: fullPhone ? (pgUser.inviter_phone || '') : maskPhone(pgUser.inviter_phone || ''),
    invitedAt: pgUser.invited_at || null,
    customerType: pgUser.customer_type || null,
    spendingTier: pgUser.spending_tier || null,
    monthlyActivity: pgUser.monthly_activity || null,
    customerStatus: pgUser.customer_status || null,
    occupation: pgUser.occupation || null,
    isMarried: pgUser.is_married,
    wechatName: pgUser.wechat_name || null,
    skinType: pgUser.skin_type || null,
    focusAreas: pgUser.improvement_focus || null,
    skinIssue: pgUser.skin_issue || null,
    wellnessPreference: pgUser.wellness_preference || null,
    notes: pgUser.notes || null,
    pointsBalance: Number(pgUser.points_balance) || 0,
    lastServiceDate: visitInfo.lastServiceDate,
    visitFrequency: visitInfo.visitFrequency,
    topProductName: topProduct,
    totalConsumption,
    yearConsumption,
    totalActualConsumption,
    yearActualConsumption,
    birthday: pgUser.birthday ?? null,
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
  // WorkFine 历史导入及退款归零后的销售单都可能是 '已完成'，仍须计入有效订单。
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
       -- 行级欠款：仅「订单确实未付清」且「该卡未买满次数」时才算。
       -- 订单已付清但行 received 不足的是行级分摊缺口（已知数据问题），不是顾客欠款；
       -- 寄存单 total_amount<=0 → paid_sessions=session_count，天然不进此分支（其 sale_amount 只是原价快照）。
       CASE
         WHEN o.status = '部分支付'
          AND si.paid_sessions IS NOT NULL
          AND si.paid_sessions < si.session_count
          AND NOT EXISTS (
            SELECT 1 FROM sale_order_payments sop
            WHERE sop.sale_order_id = si.sale_order_id
              AND sop.change_type = '退款' AND sop.status = '已支付'
          )
          -- 1 元阈值：瀑布分摊的 ROUND 尾差会造出 ¥0.01 的假欠款，不值得推给顾客
          AND (si.sale_amount::numeric - si.received::numeric) >= 1
         THEN GREATEST(0, si.sale_amount::numeric - si.received::numeric)::numeric(12, 2)
         ELSE NULL
       END AS unpaid_amount,
       COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
       ps.category_id,
       pc.category_name, pc.product_kind,
       COALESCE(pc_parent.display_color, pc.display_color) AS category_color
     FROM sale_items si
     JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
     LEFT JOIN product_skus ps ON si.sku_id = ps.sku_id
     LEFT JOIN product_categories pc ON ps.category_id = pc.category_id
     LEFT JOIN product_categories pc_parent ON pc_parent.category_name = pc.product_kind AND pc_parent.product_kind IS NULL
     WHERE si.sale_order_id = ANY($1)
       AND si.product_type = '疗程卡'
       AND (
         si.item_direction = '购买'
         OR (o.sale_order_type = '转换单' AND si.item_direction = '转入')
       )
       -- issue #122：改按物理剩余次数下发，与门店视图 customer.paidOrders 同口径。
       -- 部分支付导致 paid_sessions=0 的卡以前被整行剔除，管理层同样看不到这张卡。
       AND (
         si.paid_sessions IS NULL
         OR si.remaining_sessions > 0
       )
       -- ⚠ 退款不减 remaining_sessions（Model X）：paid_sessions 是"已退卡从卡包消失"的唯一机制，
       -- 放宽展示门槛必须补回这条守卫，否则已退款的卡会重新出现。
       AND (
         NOT EXISTS (
           SELECT 1 FROM sale_order_payments sop
           WHERE sop.sale_order_id = si.sale_order_id
             AND sop.change_type = '退款' AND sop.status = '已支付'
         )
         OR si.paid_sessions IS NULL
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
      unit: item.unit || (item.product_type === '家居产品' ? '盒' : '次'),
      unitRealPrice: item.unit_real_price != null ? Number(item.unit_real_price).toFixed(2) : '',
      // 仅订单未付清且该卡未买满次数时有值；已付清/寄存单/NULL 卡一律 null
      unpaidAmount: item.unpaid_amount != null ? Number(item.unpaid_amount) : null,
      categoryId: item.category_id || '',
      categoryName: item.category_name || '',
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
            si.received, o.created_at, o.paid_at,
            COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit
       FROM sale_items si
       JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
       LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
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
              si.quantity, si.session_count, si.remaining_sessions, si.paid_sessions, si.received,
              COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit
         FROM sale_items si
         LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
        WHERE si.sale_order_id = ANY($1) ORDER BY si.sale_item_id`,
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
      unit: i.unit || '次',
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
      unit: i.unit || '次',
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

// ====================================================================
// homeProducts — 顾客已购家居产品资产（管理层视图）
//
// 与 customer.homeProducts 的关系：SQL 主体字节同义（跨端 snapshot 守护），
// 差异仅在入口鉴权 —— 门店版走 assertCustomerProfileVisible（顾客分配关系），
// 本版走 requireManagementLevel + resolveCustomerInScope（bound_store_id ∈ scope）。
// 交易数据跟顾客走：解析出顾客后不再按订单门店过滤，跨店家居资产全量展示。
// ====================================================================

function mapHomeProductRow(row) {
  const pickedQuantity = Number(row.picked_quantity || 0)
  const refundedQuantity = Number(row.refunded_quantity || 0)
  const convertedQuantity = Number(row.converted_quantity || 0)
  const remainingQuantity = Number(row.remaining_quantity || 0)
  const paidQuantity = Number(row.paid_quantity || 0)
  const pendingPickupQuantity = Number(row.pending_pickup_quantity || 0)
  // 待付清行的欠款金额：received 是行级净实收（已扣该行退款），故对退过款的行
  // sale_amount - received 会把"退掉的钱"误算成欠款；寄存单行 SQL 已置 NULL。
  const unpaidAmount =
    refundedQuantity > 0 || row.unpaid_amount == null ? null : Number(row.unpaid_amount)
  let status
  if (row.refund_pending) status = '退款处理中'
  else if (pendingPickupQuantity > 0) status = pickedQuantity > 0 ? '部分提货' : '待提货'
  // 「待付清」必须与欠款金额绑定：只有真的算得出欠款才这么标。
  // 否则寄存单（金额列留空）和退款后仍有剩余的行会被误标成待付清/已完成。
  else if (unpaidAmount > 0) status = '待付清'
  // 还有未交付份额但算不出欠款（寄存单、退款后剩余）——是待提，不是已完成。
  else if (remainingQuantity > 0) status = '待提货'
  // #125：整行折抵后 settled=purchased，于是 pending=0、remaining=0、refunded=0，
  // 不看 convertedQuantity 会把「已转走」误判成「已提货」。
  else status = (refundedQuantity > 0 || convertedQuantity > 0) ? '已完成' : '已提货'

  return {
    saleItemId: row.sale_item_id,
    saleItemGroupId: row.sale_item_group_id || null,
    saleOrderId: row.sale_order_id,
    productName: row.product_name || '家居产品',
    unit: row.unit || '盒',
    purchasedQuantity: Number(row.purchased_quantity || 0),
    paidQuantity,
    pickedQuantity,
    refundedQuantity,
    convertedQuantity,
    remainingQuantity,
    pendingPickupQuantity,
    unpaidAmount,
    status,
    storeId: row.store_id,
    storeName: row.store_name || null,
    purchasedAt: row.purchased_at,
  }
}

async function homeProducts(ctx) {
  await requireManagementLevel()(ctx, async () => {})

  const { clientUserId, clientPhone, scopeType, scopeId } = ctx.event.payload || {}
  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }
  validateScopeParams(scopeType, scopeId)
  validateManagementScope(ctx.auth, scopeType, scopeId)

  const resolvedUserId = await resolveCustomerInScope(clientUserId, clientPhone, scopeType, scopeId)

  const rows = await pg.query(
    `WITH pickup_totals AS (
       SELECT sale_item_id, SUM(pickup_quantity)::int AS picked_quantity
         FROM pickup_records
        GROUP BY sale_item_id
     ), conversion_totals AS (
       -- 2026-09-14 #125：家居转出数量并入 picked_up_quantity（"已结算"），这里单独聚合出来，
       -- 避免把"已转换"算进"已退款"。只有「已关闭」完成过 rollback（数量已退回），故只排除它；
       -- 其余状态（含"支付失败"）扣减仍然生效，必须计入已转换。删除订单的转出行已随主单消失。
       SELECT out_item.ref_sale_item_id AS sale_item_id,
              SUM(out_item.quantity)::int AS converted_quantity,
              -- #145/#153：折抵额度按金额结算，件数用于展示「已转换 N 件」，
              -- 金额用于算「剩余已付」（折 4 件可能带走 ¥450 而非 ¥400，用件数推算会失真）。
              SUM(GREATEST(0, -out_item.received::numeric)) AS converted_amount
         FROM sale_items out_item
         JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
        WHERE out_item.item_direction = '转出'
          AND out_item.product_type = '家居产品'
          AND out_item.ref_sale_item_id IS NOT NULL
          AND conv_order.status <> '已关闭'
        GROUP BY out_item.ref_sale_item_id
     ), home_product_rows AS (
       SELECT COALESCE(si.sale_item_group_id, si.sale_item_id) AS sale_item_group_id,
              si.sale_item_id,
              si.sale_order_id,
              COALESCE(si.product_name, '家居产品') AS product_name,
              COALESCE(ps.unit, '盒') AS unit,
              si.quantity::int AS purchased_quantity,
              LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0)))::int AS settled_quantity,
              LEAST(
                LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0))),
                GREATEST(0, COALESCE(pt.picked_quantity, 0))
              )::int AS picked_quantity,
              LEAST(
                LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0))),
                GREATEST(0, COALESCE(ct.converted_quantity, 0))
              )::int AS converted_quantity,
              -- #145/#153：行级可提件数 = min(物理未结算, floor(剩余已付 / 单价))，与折抵额度同一口径。
              -- 剩余已付 = 行实收 − 已提货金额 − 已转走金额；退款不在此处扣（received 已扣过）。
              -- 必须按金额算而非「已付件数 − 已提 − 已折抵件数」：折抵金额含余数时两者不等，
              -- 折 4 件带走 ¥450 后再回款 ¥50，按件数会多放出 1 件（累计兑现超实收）。
              CASE
                WHEN o.sale_order_type = '寄存单' OR si.sale_amount <= 0
                  THEN GREATEST(0, si.quantity - LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0))))
                ELSE LEAST(
                  GREATEST(0, si.quantity - LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0)))),
                  GREATEST(0, FLOOR((GREATEST(0, si.received::numeric)
                    - GREATEST(0, COALESCE(pt.picked_quantity, 0)) * si.unit_real_price::numeric
                    - COALESCE(ct.converted_amount, 0)) / NULLIF(si.unit_real_price::numeric, 0)))::int
                )
              END AS row_pending_pickup,
              CASE
                -- 寄存单：货本就属于顾客，全额可提（sale_amount 只是原价快照，received 不代表欠款）。
                -- 判据与 #120 展示侧 is_deposit 同源；刻意不用疗程卡那条 total_amount<=0——后者会连带覆盖
                -- 转换单/零总额单，且 total_amount 无 CHECK 约束，负值会静默放行。
                WHEN o.sale_order_type = '寄存单' THEN si.quantity
                WHEN si.sale_amount <= 0 THEN si.quantity
                ELSE LEAST(
                  si.quantity,
                  FLOOR(GREATEST(0, si.received::numeric) * si.quantity / NULLIF(si.sale_amount::numeric, 0))::int
                )
              END AS paid_quantity,
              si.sale_amount::numeric AS row_sale_amount,
              GREATEST(0, si.received::numeric) AS row_received,
              (o.sale_order_type = '寄存单') AS is_deposit,
              o.store_id,
              s.store_name,
              COALESCE(o.paid_at, o.sale_order_datetime, o.created_at) AS purchased_at,
              EXISTS (
                SELECT 1 FROM sale_order_payments sop
                 WHERE sop.sale_order_id = o.sale_order_id
                   AND sop.change_type = '退款'
                   AND sop.status = '待审批'
              ) AS refund_pending
         FROM sale_items si
         JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
         LEFT JOIN stores s ON s.store_id = o.store_id
         LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
         LEFT JOIN pickup_totals pt ON pt.sale_item_id = si.sale_item_id
         LEFT JOIN conversion_totals ct ON ct.sale_item_id = si.sale_item_id
        WHERE o.client_user_id = $1
          AND o.status IN ('已支付', '部分支付', '已完成')
          -- #145/#153：转换单换入的家居与购买行同权（与疗程卡侧放行写法同源）。
          -- sale_amount>0 的转入行，received 已由 paid-sessions STEP 1.6 重建为「转出旧卡
          -- 价值 + 本单净到账」，FLOOR(received × qty / sale_amount) 天然成立；sale_amount<=0
          -- 的转入行走上方赠品分支全额可提（STEP 1.6 带 sale_amount>0 过滤，刻意不碰 0 元行，
          -- 与购买侧 0 元赠品行同口径）。两类都不需要为「转入」另加满付分支。
          AND (
            si.item_direction = '购买'
            OR (o.sale_order_type = '转换单' AND si.item_direction = '转入')
          )
          AND si.product_type = '家居产品'
     ), home_products AS (
       SELECT sale_item_group_id,
              MIN(si.sale_item_id) AS sale_item_id,
              MIN(si.sale_order_id) AS sale_order_id,
              MIN(COALESCE(si.product_name, '家居产品')) AS product_name,
              MIN(si.unit) AS unit,
              SUM(si.purchased_quantity)::int AS purchased_quantity,
              SUM(si.settled_quantity)::int AS settled_quantity,
              SUM(si.picked_quantity)::int AS picked_quantity,
              SUM(si.converted_quantity)::int AS converted_quantity,
              SUM(si.row_pending_pickup)::int AS pending_pickup_quantity,
              SUM(si.paid_quantity)::int AS paid_quantity,
              SUM(si.row_sale_amount) AS sale_amount_total,
              SUM(si.row_received) AS received_total,
              BOOL_OR(si.is_deposit) AS is_deposit,
              MIN(si.store_id) AS store_id,
              MIN(si.store_name) AS store_name,
              MAX(si.purchased_at) AS purchased_at,
              BOOL_OR(si.refund_pending) AS refund_pending
         FROM home_product_rows si
      GROUP BY sale_item_group_id
     ), home_product_balances AS (
       SELECT *,
              GREATEST(0, settled_quantity - picked_quantity - converted_quantity)::int AS refunded_quantity,
              (purchased_quantity - settled_quantity)::int AS remaining_quantity,
              -- 寄存单的 sale_amount 只是原价快照、received 恒为历史值，两者相减不是欠款
              -- （寄存的货本就属于顾客）。金额列一律留空，与导出口径一致。
              CASE WHEN is_deposit THEN NULL
                   ELSE GREATEST(0, sale_amount_total - received_total)::numeric(12, 2)
              END AS unpaid_amount
         FROM home_products
     )
     SELECT *
       FROM home_product_balances
      WHERE picked_quantity > 0 OR remaining_quantity > 0 OR converted_quantity > 0
   ORDER BY (pending_pickup_quantity > 0) DESC,
            purchased_at DESC,
            sale_item_id`,
    [resolvedUserId],
  )

  const scopeName = await resolveScopeName(scopeType, scopeId)
  ctx.result = {
    scope: { type: scopeType, id: scopeId || null, name: scopeName },
    homeProducts: rows.map(mapHomeProductRow),
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
  homeProducts,
}
