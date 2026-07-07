

const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')
const { URL } = require('url')
const pg = require('../db/pg')
const { requireStaffBound, invalidateAuthCache } = require('../middleware/auth')
const { assertEmployeeInScope, isStoreInScope, buildStoreScopeCondition } = require('../utils/scope')
const { shanghaiDateStr } = require('../utils/datetime')









const CLIENT_API_HTTP_URL = process.env.CLIENT_API_HTTP_URL
const CLIENT_SECRET = process.env.CLIENT_SECRET


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


async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId: payloadStoreId } = ctx.event.payload || {}
  const targetStoreId = payloadStoreId || ctx.auth.effectiveStoreId

  if (!targetStoreId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  
  
  if (!isStoreInScope(ctx.auth, targetStoreId)) {
    throw new Error('PERMISSION_DENIED: 不在权限范围内的门店')
  }

  
  
  
  
  
  const staffRows = await pg.query(`
    SELECT
      u.employee_id,
      u.name,
      u.position_name AS position,
      u.skills,
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
      AND u.skills && ARRAY['美容师','养生师']::text[]
    ORDER BY d.name, u.name
  `, [targetStoreId])

  ctx.result = {
    staffList: staffRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      position: r.position || '',
      skills: r.skills || [],
      avatarUrl: r.avatar_url || null,
      department: r.department || '',
      storeName: r.store_name || '',
      marketName: r.market_name || '',
      isManager: r.position === '门店经理'
    }))
  }
}


async function departments(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId: payloadStoreId } = ctx.event.payload || {}
  const targetStoreId = payloadStoreId || ctx.auth.effectiveStoreId

  if (!targetStoreId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  
  if (!isStoreInScope(ctx.auth, targetStoreId)) {
    throw new Error('PERMISSION_DENIED: 不在权限范围内的门店')
  }

  
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


async function todayCommission(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { staffWfId, roles } = ctx.auth
  const isManager = roles.includes('manager')

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayEnd = new Date(todayStart)
  todayEnd.setDate(todayEnd.getDate() + 1)
  const todayStr = shanghaiDateStr(todayStart)

  
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

  
  const serviceRows = await pg.query(`
    SELECT COUNT(*) AS service_count
    FROM service_orders
    WHERE assigned_employee_id = $1
      AND service_date = $2
  `, [staffWfId, todayStr])

  
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  
  const thisMonthCommRows = await pg.query(`
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
  `, [staffWfId, thisMonthStart, thisMonthEnd])

  
  const thisMonthSvcRows = await pg.query(`
    SELECT COUNT(*) AS service_count
    FROM service_orders
    WHERE assigned_employee_id = $1
      AND service_date >= $2
      AND service_date < $3
  `, [staffWfId, shanghaiDateStr(thisMonthStart), shanghaiDateStr(thisMonthEnd)])

  
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)

  
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

  
  const lastMonthSvcRows = await pg.query(`
    SELECT COUNT(*) AS service_count
    FROM service_orders
    WHERE assigned_employee_id = $1
      AND service_date >= $2
      AND service_date < $3
  `, [staffWfId, shanghaiDateStr(lastMonthStart), shanghaiDateStr(lastMonthEnd)])

  const result = {
    todayAmount: Number(commissionRows[0].today_amount).toFixed(2),
    orderCount: Number(commissionRows[0].order_count),
    serviceCount: Number(serviceRows[0].service_count),
    thisMonthAmount: Number(thisMonthCommRows[0].amount).toFixed(2),
    thisMonthOrderCount: Number(thisMonthCommRows[0].order_count),
    thisMonthServiceCount: Number(thisMonthSvcRows[0].service_count),
    lastMonthAmount: Number(lastMonthCommRows[0].amount).toFixed(2),
    lastMonthOrderCount: Number(lastMonthCommRows[0].order_count),
    lastMonthServiceCount: Number(lastMonthSvcRows[0].service_count),
  }

  
  
  const eff = ctx.auth.effectiveStoreId
  if (isManager && eff) {
    const sc = buildStoreScopeCondition(ctx.auth, 'o.store_id', 1)
    const storeRows = await pg.query(`
      SELECT COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric), 0) AS store_revenue
      FROM sale_orders o
      WHERE ${sc.sql}
        AND o.sale_order_type IN ('销售单', '转换单')
        AND o.status = '已支付'
        AND o.legacy_source IS DISTINCT FROM 'workfine'
        AND o.paid_at >= $${sc.params.length + 1}
        AND o.paid_at < $${sc.params.length + 2}
    `, [...sc.params, todayStart, todayEnd])
    result.storeTodayRevenue = Number(storeRows[0].store_revenue).toFixed(2)
  }

  ctx.result = result
}


async function monthlyCalendar(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { yearMonth } = ctx.event.payload || {}

  const now = new Date()
  const defaultYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const ym = yearMonth || defaultYm

  const [y, m] = ym.split('-').map(Number)
  const monthStart = new Date(y, m - 1, 1)
  const monthEnd = new Date(y, m, 1)
  const monthStartStr = shanghaiDateStr(monthStart)
  const monthEndStr = shanghaiDateStr(monthEnd)

  const sc = buildStoreScopeCondition(ctx.auth, 'o.store_id', 1)

  
  const dailyRows = await pg.query(`
    SELECT
      DATE(o.paid_at) AS date,
      SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric) AS amount
    FROM sale_orders o
    WHERE ${sc.sql}
      AND o.sale_order_type IN ('销售单', '转换单')
      AND o.status = '已支付'
      AND o.legacy_source IS DISTINCT FROM 'workfine'
      AND o.paid_at >= $${sc.params.length + 1}
      AND o.paid_at < $${sc.params.length + 2}
    GROUP BY DATE(o.paid_at)
    ORDER BY DATE(o.paid_at)
  `, [...sc.params, monthStart, monthEnd])

  
  const totalRows = await pg.query(`
    SELECT
      COALESCE(SUM(o.received::numeric - COALESCE(o.refunded_amount, 0)::numeric), 0) AS total_amount,
      COUNT(*) AS total_order_count
    FROM sale_orders o
    WHERE ${sc.sql}
      AND o.sale_order_type IN ('销售单', '转换单')
      AND o.status = '已支付'
      AND o.legacy_source IS DISTINCT FROM 'workfine'
      AND o.paid_at >= $${sc.params.length + 1}
      AND o.paid_at < $${sc.params.length + 2}
  `, [...sc.params, monthStart, monthEnd])

  
  const svcSc = buildStoreScopeCondition(ctx.auth, 'store_id', 1)
  const svcRows = await pg.query(`
    SELECT COUNT(*) AS total_service_count
    FROM service_orders
    WHERE ${svcSc.sql}
      AND service_date >= $${svcSc.params.length + 1}
      AND service_date < $${svcSc.params.length + 2}
  `, [...svcSc.params, monthStartStr, monthEndStr])

  const dailyData = dailyRows.map(r => ({
    date: r.date instanceof Date ? shanghaiDateStr(r.date) : String(r.date).slice(0, 10),
    amount: Number(r.amount),
  }))

  ctx.result = {
    dailyData,
    totalAmount: Number(totalRows[0].total_amount),
    totalOrderCount: Number(totalRows[0].total_order_count),
    totalServiceCount: Number(svcRows[0].total_service_count),
  }
}


async function todoList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { staffWfId, roles, effectiveStoreId } = ctx.auth
  const isManager = roles.includes('manager')

  
  let appointmentCount
  if (isManager) {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE store_id = $1 AND status = '待确认'`,
      [effectiveStoreId]
    )
  } else {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE employee_id = $1 AND status = '待确认'`,
      [staffWfId]
    )
  }

  
  let serviceCount
  if (isManager) {
    serviceCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM service_orders WHERE store_id = $1 AND status IN ('待服务', '服务中')`,
      [effectiveStoreId]
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

  
  if (isManager) {
    
    
    const offlineRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status IN ('待支付', '部分支付') AND payment_method = '线下'`,
      [effectiveStoreId]
    )
    const createRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '待支付' AND opened_by IS NULL`,
      [effectiveStoreId]
    )
    result.pendingOfflineOrderCount = Number(offlineRows[0].cnt)
    result.pendingCreateOrderCount = Number(createRows[0].cnt)

    const unbindRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM store_unbind_requests WHERE from_store_id = $1 AND status = '待处理'`,
      [effectiveStoreId]
    )
    result.pendingUnbindCount = Number(unbindRows[0].cnt)

    
    const allocRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '已支付' AND allocation_status = '待分配'
         AND sale_order_type IN ('销售单', '转换单') AND legacy_source IS DISTINCT FROM 'workfine'`,
      [effectiveStoreId]
    )
    result.pendingAllocationCount = Number(allocRows[0].cnt)

    
    const refundRows = await pg.query(
      `SELECT COUNT(*) AS cnt
         FROM sale_order_payments sop
         JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
        WHERE so.store_id = $1 AND sop.change_type = '退款' AND sop.status = '待审批'`,
      [effectiveStoreId]
    )
    result.pendingRefundCount = Number(refundRows[0].cnt)
  }

  ctx.result = result
}


async function bindStore(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId } = ctx.event.payload || {}
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 参数')
  }

  
  
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

  
  await pg.query(
    'UPDATE staff_wechat_users SET store_id = $1, updated_at = NOW() WHERE employee_id = $2',
    [storeRows[0].store_id, ctx.auth.staffWfId]
  )

  
  invalidateAuthCache(ctx.auth.openid)

  ctx.result = {
    success: true,
    storeId: storeRows[0].store_id,
    storeName: storeRows[0].store_name
  }
}


async function performanceDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { startDate, endDate, employeeId: queryEmployeeId, salesCategory, filterType, page = 1, pageSize = 20 } = ctx.event.payload || {}
  const isManager = ctx.auth.roles.includes('manager')

  
  const targetEmployeeId = (isManager && queryEmployeeId) ? queryEmployeeId : ctx.auth.staffWfId

  
  
  await assertEmployeeInScope(pg, ctx.auth, targetEmployeeId)

  if (!startDate || !endDate) {
    throw new Error('INVALID_PARAMS: 缺少 startDate 或 endDate')
  }

  const start = new Date(startDate.replace(/-/g, '/'))
  const end = new Date(endDate.replace(/-/g, '/'))
  end.setDate(end.getDate() + 1)

  
  const allocParams = [targetEmployeeId, start, end]
  let allocWhere = ''
  if (salesCategory) {
    allocParams.push(salesCategory)
    allocWhere = ` AND si.sales_category = $${allocParams.length}`
  }

  const allocRows = await pg.query(`
    SELECT
      sa.total_amount AS alloc_amount,
      COALESCE(sa.commission_amount, 0) AS commission_amount,
      sa.commission_rate,
      sa.allocation_ratio,
      sa.department_name,
      si.product_name,
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

  
  let totalSalesAlloc = 0
  let totalServiceCommission = 0
  const categorySummary = {}

  for (const r of allocRows) {
    
    totalSalesAlloc += Number(r.commission_amount)
    const cat = r.sales_category || '未分类'
    if (!categorySummary[cat]) categorySummary[cat] = { sales: 0, service: 0 }
    categorySummary[cat].sales += Number(r.commission_amount)
  }

  for (const r of svcRows) {
    const amount = Number(r.commission_amount)
    totalServiceCommission += amount
    const cat = r.sales_category || '未分类'
    if (!categorySummary[cat]) categorySummary[cat] = { sales: 0, service: 0 }
    categorySummary[cat].service += amount
  }

  
  const saleItems = allocRows.map(r => ({
    type: 'sale',
    productName: r.product_name,
    specName: r.product_name,
    salesCategory: r.sales_category,
    amount: Number(r.commission_amount), 
    allocAmount: Number(r.alloc_amount), 
    commissionRate: Number(r.commission_rate || 0), 
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
    specName: r.product_name,
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
    
    totalServiceFee: roundedServiceCommission,
    totalCommission: Math.round((totalSalesAlloc + totalServiceCommission) * 100) / 100,
    categorySummary,
    items: paged,
    total: allItems.length,
    page,
    pageSize,
  }
}


async function uploadAvatar(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { base64, ext } = ctx.event.payload || {}
  const { OPENID } = cloud.getWXContext()
  const employeeId = ctx.auth.staffWfId

  
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

  
  invalidateAuthCache(OPENID)

  ctx.result = { fileID, avatarUrl: httpsUrl }
}


async function skillTags(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const rows = await pg.query(
    'SELECT name FROM skill_tags WHERE is_valid = true ORDER BY sort_order, name'
  )

  ctx.result = { skillTags: rows.map(r => r.name) }
}

module.exports = { list, departments, todayCommission, monthlyCalendar, todoList, bindStore, performanceDetail, uploadAvatar, skillTags }
