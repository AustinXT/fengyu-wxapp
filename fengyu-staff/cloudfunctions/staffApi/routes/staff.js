/**
 * 员工模块路由（员工端）
 * staff.list — 门店员工列表
 * staff.departments — 部门列表（含可分配员工）
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

/**
 * 员工列表
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId: payloadStoreId } = ctx.event.payload || {}
  const targetStoreId = payloadStoreId || ctx.auth.storeId

  if (!targetStoreId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  const staffRows = await pg.query(`
    SELECT
      u.employee_id,
      u.name,
      u.position_name AS position,
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
    ORDER BY d.name, u.name
  `, [targetStoreId])

  ctx.result = {
    staffList: staffRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      position: r.position || '',
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
  const targetStoreId = payloadStoreId || ctx.auth.storeId

  if (!targetStoreId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  // 查询美容部
  const beautyRows = await pg.query(`
    SELECT
      u.employee_id,
      u.name,
      u.position_name AS position,
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
  const marketName = ctx.auth.marketName
  let otherDeptRows = []

  if (marketName) {
    otherDeptRows = await pg.query(`
      SELECT
        u.employee_id,
        u.name,
        u.position_name AS position,
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

  const result = {
    todayAmount: Number(commissionRows[0].today_amount).toFixed(2),
    orderCount: Number(commissionRows[0].order_count),
    serviceCount: Number(serviceRows[0].service_count),
  }

  // 店长：门店今日总营收
  if (isManager && storeId) {
    const storeRows = await pg.query(`
      SELECT COALESCE(SUM(si.received::numeric), 0) AS store_revenue
      FROM sale_items si
      JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
      WHERE o.store_id = $1
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
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '待确认收款'`,
      [storeId]
    )
    const createRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '待支付' AND sale_order_source != 'staff'`,
      [storeId]
    )
    result.pendingOfflineOrderCount = Number(offlineRows[0].cnt)
    result.pendingCreateOrderCount = Number(createRows[0].cnt)

    const unbindRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM store_unbind_requests WHERE from_store_id = $1 AND status = 'pending'`,
      [storeId]
    )
    result.pendingUnbindCount = Number(unbindRows[0].cnt)

    // 待提成分配订单
    const allocRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM sale_orders WHERE store_id = $1 AND status = '已支付' AND allocation_status = 'pending'`,
      [storeId]
    )
    result.pendingAllocationCount = Number(allocRows[0].cnt)
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

  const storeRows = await pg.query(
    'SELECT store_id, store_name FROM stores WHERE store_id = $1 AND is_closed = false',
    [storeId]
  )

  if (storeRows.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在或已关闭')
  }

  ctx.result = {
    success: true,
    storeId: storeRows[0].store_id,
    storeName: storeRows[0].store_name
  }
}

module.exports = { list, departments, todayCommission, monthlyCalendar, todoList, bindStore }
