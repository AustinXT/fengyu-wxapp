/**
 * 员工模块路由（员工端）
 * staff.list — 门店员工列表
 * staff.departments — 部门列表（含可分配员工）
 * staff.uploadAvatar — 员工头像上传（HTTPS POST 转发到 clientApi 写入 client env COS）
 */

const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')
const { URL } = require('url')
const pg = require('../db/pg')
const { requireStaffBound, invalidateAuthCache } = require('../middleware/auth')
const { assertEmployeeInScope, isStoreInScope } = require('../utils/scope')

// 跨 env 转上传相关 env vars：
// - CLIENT_API_HTTP_URL：clientApi 的 HTTP 触发器 URL（部署 clientApi 后 tcb fn detail 拿）
// - CLIENT_SECRET：与 clientApi 共享的 HMAC 密钥，已存在（原本给 wxacode.js 用）
//
// 不再用 wx-server-sdk 的 new Cloud({resourceEnv})（实测 v3.0.4 静默忽略 resourceEnv）；
// 也不引 @cloudbase/node-sdk（避免多套 SDK 凭证管理）。
// 直接 https.request 到 clientApi HTTP 触发器，clientApi 在自己 env 内上传 + getTempFileURL 返回 HTTPS URL。
// 这个 URL 与 admin 写入的 products.cover_image 完全同 shape，三端 `<image src>` 透明渲染。
const CLIENT_API_HTTP_URL = process.env.CLIENT_API_HTTP_URL
const CLIENT_SECRET = process.env.CLIENT_SECRET

/**
 * HTTPS POST JSON helper（同 utils/wxacode.js 的 httpGet 同款风格，本地 Promise 包装）
 * 返回 { status, json, raw }
 */
function postJson(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const data = Buffer.from(body, 'utf-8')
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8')
        let json = null
        try { json = JSON.parse(text) } catch (_) {}
        resolve({ status: res.statusCode, json, raw: text })
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

/**
 * 员工列表
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId: payloadStoreId } = ctx.event.payload || {}
  const targetStoreId = payloadStoreId || ctx.auth.effectiveStoreId

  if (!targetStoreId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  // Scope guard: 防止任意员工通过 payloadStoreId 枚举跨店员工
  // admin/headquarters 永远放行；其他角色必须在自己 scopeStoreIds 内
  if (!isStoreInScope(ctx.auth, targetStoreId)) {
    throw new Error('PERMISSION_DENIED: 不在权限范围内的门店')
  }

  // 严格按 skills 数组含 '美容师' 判定美容师身份 ——
  // 与 clientApi/routes/staff.js + admin orders/services/customers picker 单源对齐。
  // 经理/督导/财智部等岗位即使 store_id 匹配也不应进入美容师选择列表。
  const staffRows = await pg.query(`
    SELECT
      u.employee_id,
      u.name,
      u.position_name AS position,
      u.avatar_url,
      d.name AS department,
      s.store_name,
      m.name AS market_name
    FROM staff_wechat_users u
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes so ON s.org_node_id = so.id
    LEFT JOIN org_nodes m ON so.parent_id = m.id
    LEFT JOIN org_nodes d ON u.org_node_id = d.id
    WHERE u.is_resigned = false
      AND u.store_id = $1
      AND u.employee_id IS NOT NULL
      AND '美容师' = ANY(u.skills)
    ORDER BY d.name, u.name
  `, [targetStoreId])

  ctx.result = {
    staffList: staffRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      position: r.position || '',
      avatarUrl: r.avatar_url || null,
      department: r.department || '',
      storeName: r.store_name || '',
      marketName: r.market_name || '',
      isManager: r.position === '门店经理'
    }))
  }
}

/**
 * 部门列表（含可分配业绩员工）
 */
async function departments(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId: payloadStoreId } = ctx.event.payload || {}
  const targetStoreId = payloadStoreId || ctx.auth.effectiveStoreId

  if (!targetStoreId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  // Scope guard: 同 list，防止跨店枚举
  if (!isStoreInScope(ctx.auth, targetStoreId)) {
    throw new Error('PERMISSION_DENIED: 不在权限范围内的门店')
  }

  // 查询美容部
  const beautyRows = await pg.query(`
    SELECT
      u.employee_id,
      u.name,
      u.position_name AS position,
      u.skills,
      u.avatar_url,
      d.name AS department
    FROM staff_wechat_users u
    LEFT JOIN org_nodes d ON u.org_node_id = d.id
    WHERE u.is_resigned = false
      AND u.store_id = $1
      AND d.name = '美容部'
      AND u.employee_id IS NOT NULL
    ORDER BY u.name
  `, [targetStoreId])

  // 查询其他部门（按市场查询）
  // 仅总部 / 市场级可见整个市场的人员名单；门店级（store_manager / store_staff）跳过
  const marketName = ctx.auth.marketName
  const canSeeMarket = ctx.auth.staffLevel === 'headquarters' || ctx.auth.staffLevel === 'market'
  let otherDeptRows = []

  if (marketName && canSeeMarket) {
    otherDeptRows = await pg.query(`
      SELECT
        u.employee_id,
        u.name,
        u.position_name AS position,
        u.skills,
        u.avatar_url,
        d.name AS department,
        s.store_name
      FROM staff_wechat_users u
      LEFT JOIN stores s ON u.store_id = s.store_id
      LEFT JOIN org_nodes so ON s.org_node_id = so.id
      LEFT JOIN org_nodes m ON so.parent_id = m.id
      LEFT JOIN org_nodes d ON u.org_node_id = d.id
      WHERE u.is_resigned = false
        AND m.name = $1
        AND d.name IS NOT NULL
        AND d.name != '美容部'
        AND d.name != ''
        AND u.employee_id IS NOT NULL
      ORDER BY d.name, u.name
    `, [marketName])
  }

  // 按部门分组
  const deptMap = {}

  if (beautyRows.length > 0) {
    deptMap['美容部'] = beautyRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      position: r.position || '',
      skills: Array.isArray(r.skills) ? r.skills : [],
      avatarUrl: r.avatar_url || null,
      department: '美容部'
    }))
  }

  for (const r of otherDeptRows) {
    const dept = r.department || '其他'
    if (!deptMap[dept]) deptMap[dept] = []
    deptMap[dept].push({
      staffWfId: r.employee_id,
      name: r.name || '',
      position: r.position || '',
      skills: Array.isArray(r.skills) ? r.skills : [],
      avatarUrl: r.avatar_url || null,
      department: dept,
      storeName: r.store_name || ''
    })
  }

  const departments = Object.entries(deptMap).map(([name, members]) => ({
    departmentName: name,
    members
  }))

  ctx.result = { departments }
}

/**
 * 今日分成
 */
async function todayCommission(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { staffWfId, storeId, roles } = ctx.auth
  const isManager = roles.includes('manager')

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayEnd = new Date(todayStart)
  todayEnd.setDate(todayEnd.getDate() + 1)
  const todayStr = todayStart.toISOString().slice(0, 10)

  // 今日分成金额 + 订单数
  const commissionRows = await pg.query(`
    SELECT
      COALESCE(SUM(sa.total_amount::numeric), 0) AS today_amount,
      COUNT(DISTINCT si.sale_order_id) AS order_count
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE sa.employee_id = $1
      AND sa.is_void = false
      AND o.status = '已支付'
      AND o.paid_at >= $2
      AND o.paid_at < $3
  `, [staffWfId, todayStart, todayEnd])

  // 今日服务单数
  const serviceRows = await pg.query(`
    SELECT COUNT(*) AS service_count
    FROM service_orders
    WHERE assigned_employee_id = $1
      AND service_date = $2
  `, [staffWfId, todayStr])

  // 上月时间范围
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  // 上月分成金额 + 订单数
  const lastMonthCommRows = await pg.query(`
    SELECT
      COALESCE(SUM(sa.total_amount::numeric), 0) AS amount,
      COUNT(DISTINCT si.sale_order_id) AS order_count
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE sa.employee_id = $1
      AND sa.is_void = false
      AND o.status = '已支付'
      AND o.paid_at >= $2
      AND o.paid_at < $3
  `, [staffWfId, lastMonthStart, lastMonthEnd])

  // 上月服务单数
  const lastMonthSvcRows = await pg.query(`
    SELECT COUNT(*) AS service_count
    FROM service_orders
    WHERE assigned_employee_id = $1
      AND service_date >= $2
      AND service_date < $3
  `, [staffWfId, lastMonthStart.toISOString().slice(0, 10), lastMonthEnd.toISOString().slice(0, 10)])

  const result = {
    todayAmount: Number(commissionRows[0].today_amount).toFixed(2),
    orderCount: Number(commissionRows[0].order_count),
    serviceCount: Number(serviceRows[0].service_count),
    lastMonthAmount: Number(lastMonthCommRows[0].amount).toFixed(2),
    lastMonthOrderCount: Number(lastMonthCommRows[0].order_count),
    lastMonthServiceCount: Number(lastMonthSvcRows[0].service_count),
  }

  // 店长：门店今日总营收（2026-04-26 refactor：业绩口径 = received - refunded_amount）
  if (isManager && storeId) {
    const storeRows = await pg.query(`
      SELECT COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric), 0) AS store_revenue
      FROM sale_orders o
      WHERE o.store_id = $1
        AND o.sale_order_type IN ('销售单', '转换单')
        AND o.status = '已支付'
        AND o.paid_at >= $2
        AND o.paid_at < $3
    `, [storeId, todayStart, todayEnd])
    result.storeTodayRevenue = Number(storeRows[0].store_revenue).toFixed(2)
  }

  ctx.result = result
}

/**
 * 月度业绩日历
 */
async function monthlyCalendar(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { staffWfId } = ctx.auth
  const { yearMonth } = ctx.event.payload || {}

  const now = new Date()
  const defaultYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const ym = yearMonth || defaultYm

  const [y, m] = ym.split('-').map(Number)
  const monthStart = new Date(y, m - 1, 1)
  const monthEnd = new Date(y, m, 1)
  const monthStartStr = monthStart.toISOString().slice(0, 10)
  const monthEndStr = monthEnd.toISOString().slice(0, 10)

  // 按日汇总分成金额
  const dailyRows = await pg.query(`
    SELECT
      DATE(o.paid_at) AS date,
      SUM(sa.total_amount::numeric) AS amount
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE sa.employee_id = $1
      AND sa.is_void = false
      AND o.status = '已支付'
      AND o.paid_at >= $2
      AND o.paid_at < $3
    GROUP BY DATE(o.paid_at)
    ORDER BY DATE(o.paid_at)
  `, [staffWfId, monthStart, monthEnd])

  // 月度汇总
  const totalRows = await pg.query(`
    SELECT
      COALESCE(SUM(sa.total_amount::numeric), 0) AS total_amount,
      COUNT(DISTINCT si.sale_order_id) AS total_order_count
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE sa.employee_id = $1
      AND sa.is_void = false
      AND o.status = '已支付'
      AND o.paid_at >= $2
      AND o.paid_at < $3
  `, [staffWfId, monthStart, monthEnd])

  // 月度服务单数
  const svcRows = await pg.query(`
    SELECT COUNT(*) AS total_service_count
    FROM service_orders
    WHERE assigned_employee_id = $1
      AND service_date >= $2
      AND service_date < $3
  `, [staffWfId, monthStartStr, monthEndStr])

  const dailyData = dailyRows.map(r => ({
    date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
    amount: Number(r.amount),
  }))

  ctx.result = {
    dailyData,
    totalAmount: Number(totalRows[0].total_amount),
    totalOrderCount: Number(totalRows[0].total_order_count),
    totalServiceCount: Number(svcRows[0].total_service_count),
  }
}

/**
 * 待处理事项汇总
 */
async function todoList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { staffWfId, storeId, roles } = ctx.auth
  const isManager = roles.includes('manager')

  // 待确认预约
  let appointmentCount
  if (isManager) {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE store_id = $1 AND status = '待确认'`,
      [storeId]
    )
  } else {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE employee_id = $1 AND status = '待确认'`,
      [staffWfId]
    )
  }

  // 待推进服务单
  let serviceCount
  if (isManager) {
    serviceCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM service_orders WHERE store_id = $1 AND status IN ('待服务', '服务中')`,
      [storeId]
    )
  } else {
    serviceCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM service_orders WHERE assigned_employee_id = $1 AND status IN ('待服务', '服务中')`,
      [staffWfId]
    )
  }

  const result = {
    pendingAppointmentCount: Number(appointmentCount[0].cnt),
    pendingServiceCount: Number(serviceCount[0].cnt),
  }

  // 店长专属
  if (isManager) {
    const offlineRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '待支付' AND payment_method = '线下'`,
      [storeId]
    )
    const createRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '待支付' AND opened_by IS NULL`,
      [storeId]
    )
    result.pendingOfflineOrderCount = Number(offlineRows[0].cnt)
    result.pendingCreateOrderCount = Number(createRows[0].cnt)

    const unbindRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM store_unbind_requests WHERE from_store_id = $1 AND status = '待处理'`,
      [storeId]
    )
    result.pendingUnbindCount = Number(unbindRows[0].cnt)

    // 待提成分配订单
    const allocRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '已支付' AND allocation_status = '待分配'`,
      [storeId]
    )
    result.pendingAllocationCount = Number(allocRows[0].cnt)

    // 待审批退款流水（2026-04-26 sale-order-domain-refactor：从 sale_order_payments 推断）
    const refundRows = await pg.query(
      `SELECT COUNT(*) AS cnt
         FROM sale_order_payments sop
         JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
        WHERE so.store_id = $1 AND sop.change_type = '退款' AND sop.status = '待审批'`,
      [storeId]
    )
    result.pendingRefundCount = Number(refundRows[0].cnt)
  }

  ctx.result = result
}

/**
 * 切换工作门店
 */
async function bindStore(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId } = ctx.event.payload || {}
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 参数')
  }

  // Scope guard: 总部可任意切店；其他角色（market / store_manager / store_staff）
  // 必须在自己 scopeStoreIds 内，禁止绕过 scope 切到任意门店
  if (ctx.auth.staffLevel !== 'headquarters') {
    if (!isStoreInScope(ctx.auth, storeId)) {
      throw new Error('PERMISSION_DENIED: 不在权限范围内的门店')
    }
  }

  const storeRows = await pg.query(
    'SELECT store_id, store_name FROM stores WHERE store_id = $1 AND is_closed = false',
    [storeId]
  )

  if (storeRows.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在或已关闭')
  }

  // 持久化到 staff_wechat_users.store_id，否则刷新后 auth 中间件依然读旧值
  await pg.query(
    'UPDATE staff_wechat_users SET store_id = $1, updated_at = NOW() WHERE employee_id = $2',
    [storeRows[0].store_id, ctx.auth.staffWfId]
  )

  // 清除 OPENID → authData 缓存，避免 5 分钟内仍返回旧 storeId
  invalidateAuthCache(ctx.auth.openid)

  ctx.result = {
    success: true,
    storeId: storeRows[0].store_id,
    storeName: storeRows[0].store_name
  }
}

/**
 * 员工绩效明细
 * 返回指定时段的分配明细 + 服务提成明细
 * payload: { startDate, endDate, employeeId? (店长可查他人), salesCategory?, page, pageSize }
 */
async function performanceDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { startDate, endDate, employeeId: queryEmployeeId, salesCategory, filterType, page = 1, pageSize = 20 } = ctx.event.payload || {}
  const isManager = ctx.auth.roles.includes('manager')

  // 美容师只能查自己
  const targetEmployeeId = (isManager && queryEmployeeId) ? queryEmployeeId : ctx.auth.staffWfId

  // Scope guard: when querying another employee, verify they're within current scope
  // assertEmployeeInScope 自查（staffWfId === targetEmployeeId）直接放行，无需 DB
  await assertEmployeeInScope(pg, ctx.auth, targetEmployeeId)

  if (!startDate || !endDate) {
    throw new Error('INVALID_PARAMS: 缺少 startDate 或 endDate')
  }

  const start = new Date(startDate.replace(/-/g, '/'))
  const end = new Date(endDate.replace(/-/g, '/'))
  end.setDate(end.getDate() + 1)

  // 销售提成明细（基于 sale_allocations）
  const allocParams = [targetEmployeeId, start, end]
  let allocWhere = ''
  if (salesCategory) {
    allocParams.push(salesCategory)
    allocWhere = ` AND si.sales_category = $${allocParams.length}`
  }

  const allocRows = await pg.query(`
    SELECT
      sa.total_amount AS alloc_amount,
      sa.allocation_ratio,
      sa.department_name,
      si.product_name,
      si.sku_spec_name,
      si.sales_category,
      si.unit_real_price,
      si.received,
      o.sale_order_id,
      o.customer_name,
      o.client_phone,
      o.paid_at,
      o.store_id
    FROM sale_allocations sa
    JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
    JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
    WHERE sa.employee_id = $1
      AND sa.is_void = false
      AND o.status = '已支付'
      AND o.paid_at >= $2
      AND o.paid_at < $3
      ${allocWhere}
    ORDER BY o.paid_at DESC
  `, allocParams)

  // 服务提成明细（基于 service_commissions 表）
  // 口径：commission_amount = fixed_fee + consume_amount
  //       fixed_fee = sale_items.service_fee × session_used （固定手工费快照）
  //       consume_amount = unit_real_price × session_used × commission_rate （消耗提成）
  // 旧实现曾用 unit_real_price × session_used 作为"服务提成"，这是消耗业绩金额口径，
  // 导致员工看到的数字虚高 3-5 倍，已修复。
  const svcParams = [targetEmployeeId, startDate, endDate.replace(/-/g, '/')]
  let svcWhere = ''
  if (salesCategory) {
    svcParams.push(salesCategory)
    svcWhere = ` AND si.sales_category = $${svcParams.length}`
  }

  const svcRows = await pg.query(`
    SELECT
      sc.commission_amount,
      sc.fixed_fee,
      sc.consume_amount,
      sc.role_type,
      sc.commission_rate,
      sit.session_used,
      sit.unit_real_price AS service_unit_price,
      si.product_name,
      si.sku_spec_name,
      si.sales_category,
      so.service_order_id,
      so.service_date,
      so.created_at AS service_created_at,
      so.store_id,
      cu.name AS customer_name,
      cu.phone AS client_phone
    FROM service_commissions sc
    JOIN service_items sit ON sit.service_item_id = sc.service_item_id
    JOIN service_orders so ON so.service_order_id = sit.service_order_id
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    LEFT JOIN client_wechat_users cu ON cu.user_id = so.client_user_id
    WHERE sc.employee_id = $1
      AND sc.is_void = false
      AND sc.voided_at IS NULL
      AND so.status = '已完成'
      AND so.service_date >= $2
      AND so.service_date <= $3
      ${svcWhere}
    ORDER BY so.service_date DESC
  `, svcParams)

  // 汇总
  let totalSalesAlloc = 0
  let totalServiceCommission = 0
  const categorySummary = {}

  for (const r of allocRows) {
    totalSalesAlloc += Number(r.alloc_amount)
    const cat = r.sales_category || '未分类'
    if (!categorySummary[cat]) categorySummary[cat] = { sales: 0, service: 0 }
    categorySummary[cat].sales += Number(r.alloc_amount)
  }

  for (const r of svcRows) {
    const amount = Number(r.commission_amount)
    totalServiceCommission += amount
    const cat = r.sales_category || '未分类'
    if (!categorySummary[cat]) categorySummary[cat] = { sales: 0, service: 0 }
    categorySummary[cat].service += amount
  }

  // 合并为时间线，按 filterType 过滤，分页
  const saleItems = allocRows.map(r => ({
    type: 'sale',
    productName: r.product_name,
    specName: r.sku_spec_name,
    salesCategory: r.sales_category,
    amount: Number(r.alloc_amount),
    ratio: Number(r.allocation_ratio),
    businessAmount: Number(r.received),
    customerName: r.customer_name,
    clientPhone: r.client_phone,
    orderId: r.sale_order_id,
    date: r.paid_at,
    department: r.department_name,
  }))

  const serviceItems = svcRows.map(r => ({
    type: 'service',
    productName: r.product_name,
    specName: r.sku_spec_name,
    salesCategory: r.sales_category,
    roleType: r.role_type,
    amount: Number(r.commission_amount),
    fixedFee: Number(r.fixed_fee || 0),
    consumeAmount: Number(r.consume_amount || 0),
    commissionRate: Number(r.commission_rate || 0),
    sessionUsed: r.session_used,
    servicePrice: Number(r.service_unit_price || 0),
    customerName: r.customer_name,
    clientPhone: r.client_phone,
    orderId: r.service_order_id,
    date: r.service_created_at || r.service_date,
  }))

  let allItems
  if (filterType === 'sale') allItems = saleItems
  else if (filterType === 'service') allItems = serviceItems
  else allItems = [...saleItems, ...serviceItems]

  allItems.sort((a, b) => new Date(b.date) - new Date(a.date))

  const offset = (page - 1) * pageSize
  const paged = allItems.slice(offset, offset + pageSize)

  const roundedServiceCommission = Math.round(totalServiceCommission * 100) / 100

  ctx.result = {
    totalSalesAlloc: Math.round(totalSalesAlloc * 100) / 100,
    totalServiceCommission: roundedServiceCommission,
    // 向后兼容：保留 totalServiceFee 字段名供老版本前端使用（1-2 发布周期后下线）
    totalServiceFee: roundedServiceCommission,
    totalCommission: Math.round((totalSalesAlloc + totalServiceCommission) * 100) / 100,
    categorySummary,
    items: paged,
    total: allItems.length,
    page,
    pageSize,
  }
}

/**
 * 数据看板（简单指标）
 * 返回客流/客量/新会员/业绩/消耗
 * payload: { startDate, endDate }
 */
async function dashboard(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { startDate, endDate } = ctx.event.payload || {}
  const isManagerRole = ctx.auth.roles.includes('manager')
  const storeId = ctx.auth.effectiveStoreId
  const employeeId = ctx.auth.staffWfId

  if (!startDate || !endDate) {
    throw new Error('INVALID_PARAMS: 缺少 startDate 或 endDate')
  }

  const start = startDate
  const end = endDate

  // 域过滤：美容师仅看自己，店长看整店
  let scopeFilter, scopeParams

  if (isManagerRole) {
    scopeFilter = 'so.store_id = $1'
    scopeParams = [storeId]
  } else {
    scopeFilter = 'so.assigned_employee_id = $1'
    scopeParams = [employeeId]
  }

  // 1. 客流：服务单数量（一人一天算一次）
  const footfallRows = await pg.query(`
    SELECT COUNT(DISTINCT (so.client_user_id, so.service_date)) AS footfall
    FROM service_orders so
    WHERE ${scopeFilter}
      AND so.status = '已完成'
      AND so.service_date >= $${scopeParams.length + 1}
      AND so.service_date <= $${scopeParams.length + 2}
  `, [...scopeParams, start, end])

  // 2. 客量：按月+顾客去重（一人一月算一次）
  const headcountRows = await pg.query(`
    SELECT COUNT(DISTINCT so.client_user_id) AS headcount
    FROM service_orders so
    WHERE ${scopeFilter}
      AND so.status = '已完成'
      AND so.service_date >= $${scopeParams.length + 1}
      AND so.service_date <= $${scopeParams.length + 2}
      AND so.client_user_id IS NOT NULL
  `, [...scopeParams, start, end])

  // 3. 业绩：收款金额汇总（已支付）
  // 2026-04-26 sale-order-domain-refactor：sale_order_type 5→3（销售单/内部单/转换单）
  // 业绩口径 = received - refunded_amount（直接读 sale_orders 冗余列，与 admin getDashboardStats 对齐）
  let revenueRows
  if (isManagerRole) {
    // 店长看整店业绩
    revenueRows = await pg.query(`
      SELECT COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric), 0) AS revenue
      FROM sale_orders o
      WHERE o.store_id = $1
        AND o.sale_order_type IN ('销售单', '转换单')
        AND o.status = '已支付'
        AND o.paid_at >= $2::date
        AND o.paid_at < ($3::date + INTERVAL '1 day')
    `, [storeId, start, end])
  } else {
    // 美容师看基于 sale_allocations 的分配业绩
    revenueRows = await pg.query(`
      SELECT COALESCE(SUM(sa.total_amount::numeric), 0) AS revenue
      FROM sale_allocations sa
      JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
      WHERE sa.employee_id = $1
        AND sa.is_void = false
        AND o.status = '已支付'
        AND o.paid_at >= $2::date
        AND o.paid_at < ($3::date + INTERVAL '1 day')
    `, [employeeId, start, end])
  }

  // 4. 消耗：服务单划卡单价汇总（per-session = unit_real_price × quantity / session_count）
  //    sale_items.unit_real_price 是 per-card 价格（如 5次卡=3500），
  //    必须按 quantity/session_count 折算到每次消耗，否则卡多次商品会过报。
  const consumeRows = await pg.query(`
    SELECT COALESCE(SUM(sit.unit_real_price::numeric * si.quantity / NULLIF(si.session_count, 0) * sit.session_used), 0) AS consume
    FROM service_items sit
    JOIN service_orders so ON so.service_order_id = sit.service_order_id
    JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
    WHERE ${scopeFilter}
      AND so.status = '已完成'
      AND so.service_date >= $${scopeParams.length + 1}
      AND so.service_date <= $${scopeParams.length + 2}
  `, [...scopeParams, start, end])

  // 5. 新会员（2026-04-25 起，全公司"新会员"统一为"首次成为会员客"语义）
  //    判定字段：c.became_member_at IS NOT NULL ∩ became_member_at IN [start, end]
  //    归属：店长按 c.bound_store_id；美容师按 c.bound_employee_id
  //    与 metrics.md 「新会员」行 + mgmtDashboard.summary/queryNewMembers + storeRanking/staffRanking 的 newMember 严格对齐。
  //
  //    旧口径（已废弃）："首次消费达 system_configs.new_member_threshold"（基于 sale_orders + 阈值），
  //    与 mgmt 看板/排行榜数字不一致，导致店长/美容师困惑。本次统一为 customer_type 跃迁到"会员客"的时间戳口径。
  let newMemberFilter, newMemberParams
  if (isManagerRole) {
    newMemberFilter = 'c.bound_store_id = $1'
    newMemberParams = [storeId]
  } else {
    newMemberFilter = 'c.bound_employee_id = $1'
    newMemberParams = [employeeId]
  }

  const newMemberRows = await pg.query(`
    SELECT COUNT(*) AS new_members
    FROM client_wechat_users c
    WHERE ${newMemberFilter}
      AND c.became_member_at IS NOT NULL
      AND c.became_member_at::date >= $${newMemberParams.length + 1}::date
      AND c.became_member_at::date <= $${newMemberParams.length + 2}::date
  `, [...newMemberParams, start, end])

  ctx.result = {
    footfall: Number(footfallRows[0].footfall),
    headcount: Number(headcountRows[0].headcount),
    revenue: Math.round(Number(revenueRows[0].revenue) * 100) / 100,
    consume: Math.round(Number(consumeRows[0].consume) * 100) / 100,
    newMembers: Number(newMemberRows[0].new_members),
  }
}

/**
 * 头像上传（员工本人自助）
 *
 * 流程：
 *   1. 本函数前置校验参数（与 clientApi.auth.uploadStaffAvatar 重复一份，让 base64 损坏/超 2MB
 *      等错误更早抛出，节省一次跨 env HTTPS 往返）
 *   2. HMAC-SHA256(body, CLIENT_SECRET) 签 body，HTTPS POST 到 clientApi HTTP 触发器
 *   3. clientApi 在 client env 内 cloud.uploadFile + getTempFileURL，返回 HTTPS URL
 *   4. 本函数把 HTTPS URL 写入 PG staff_wechat_users.avatar_url
 *
 * 为什么不直接在 staff env 写 staff env COS：
 *   - 客户端小程序读 staff env URL 需要额外配域名白名单 + staff env COS 还得改公共读策略
 *   - 复用 admin → client env COS 的已有写路径（products.cover_image 已实证）最一致
 *
 * 为什么不用 wx-server-sdk 跨 env：
 *   - wx-server-sdk@3.0.4 的 new Cloud({resourceEnv}) 实测被静默忽略（fileID 仍落 staff env）
 *   - 不用 @cloudbase/node-sdk：避免再引一套 SDK + 腾讯云 secret 凭证管理
 *
 * 安全：HMAC 防伪 + timestamp 防重放 + clientApi HTTP 入口 allowlist 仅 uploadStaffAvatar
 */
async function uploadAvatar(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { base64, ext } = ctx.event.payload || {}
  const { OPENID } = cloud.getWXContext()
  const employeeId = ctx.auth.staffWfId

  // 前置参数校验
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('INVALID_PARAMS: 缺少 base64 参数')
  }
  const normalizedExt = String(ext || 'jpg').toLowerCase()
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(normalizedExt)) {
    throw new Error('INVALID_PARAMS: 不支持的图片格式')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) {
    throw new Error('INVALID_PARAMS: 头像数据解析失败')
  }
  if (buffer.length > 2 * 1024 * 1024) {
    throw new Error('INVALID_PARAMS: 图片大小超过 2MB')
  }
  if (!employeeId) {
    throw new Error('UNAUTHORIZED: 员工档案未关联')
  }
  if (!CLIENT_API_HTTP_URL || !CLIENT_SECRET) {
    throw new Error('INVALID_STATE: CLIENT_API_HTTP_URL/CLIENT_SECRET 未配置')
  }

  // 签 + 发
  const body = JSON.stringify({
    action: 'auth.uploadStaffAvatar',
    payload: { base64, ext: normalizedExt, employeeId },
    timestamp: Date.now(),
  })
  const sig = crypto.createHmac('sha256', CLIENT_SECRET).update(body).digest('hex')

  let resp
  try {
    resp = await postJson(CLIENT_API_HTTP_URL, body, { 'x-fengyu-signature': sig })
  } catch (err) {
    throw new Error(`INVALID_STATE: 跨 env 上传请求失败：${err.message}`)
  }

  if (resp.status !== 200 || !resp.json) {
    throw new Error(`INVALID_STATE: 跨 env 上传 HTTP status=${resp.status}, body=${(resp.raw || '').slice(0, 200)}`)
  }
  if (resp.json.code !== 0) {
    // clientApi 已 buildErrorResponse，errorType 已是 9 项白名单之一；message 含前缀
    throw new Error(resp.json.message || 'INVALID_STATE: 跨 env 上传失败')
  }

  const httpsUrl = resp.json.data && resp.json.data.avatarUrl
  const fileID = resp.json.data && resp.json.data.fileID
  if (!httpsUrl) {
    throw new Error('INVALID_STATE: clientApi 未返回 avatarUrl')
  }

  await pg.query(
    'UPDATE staff_wechat_users SET avatar_url = $1, updated_at = NOW() WHERE employee_id = $2',
    [httpsUrl, employeeId]
  )

  // 清除 auth 缓存，下一次 login/任意接口能读到新头像
  invalidateAuthCache(OPENID)

  ctx.result = { fileID, avatarUrl: httpsUrl }
}

module.exports = { list, departments, todayCommission, monthlyCalendar, todoList, bindStore, performanceDetail, dashboard, uploadAvatar }
