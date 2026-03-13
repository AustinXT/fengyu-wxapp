/**
 * 员工模块路由（员工端）
 * staff.list — 门店员工列表
 * staff.departments — 部门列表（含可分配员工）
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

/**
 * 员工列表
 * 从 PG staff_wechat_users 查询指定门店的在职员工
 * 美容师不可看到客户完整手机号，此接口不返回手机号
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeName } = ctx.event.payload || {}

  // 默认用当前员工的门店
  const targetStore = storeName || ctx.auth.storeName
  if (!targetStore) {
    throw new Error('INVALID_PARAMS: 缺少 storeName 参数')
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
      AND s.store_name = $1
      AND u.employee_id IS NOT NULL
    ORDER BY d.name, u.name
  `, [targetStore])

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
 * 用于营业额分配界面的员工选择
 * 按部门分组返回员工列表
 */
async function departments(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeName } = ctx.event.payload || {}
  const targetStore = storeName || ctx.auth.storeName

  if (!targetStore) {
    throw new Error('INVALID_PARAMS: 缺少 storeName 参数')
  }

  // 查询美容部（含店长）— 按门店筛选
  const beautyRows = await pg.query(`
    SELECT
      u.employee_id,
      u.name,
      u.position_name AS position,
      d.name AS department
    FROM staff_wechat_users u
    LEFT JOIN stores s ON u.store_id = s.store_id
    LEFT JOIN org_nodes d ON u.org_node_id = d.id
    WHERE u.is_resigned = false
      AND s.store_name = $1
      AND d.name = '美容部'
      AND u.employee_id IS NOT NULL
    ORDER BY u.name
  `, [targetStore])

  // 查询其他部门（推广部等，按市场查询）
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

  // 美容部
  if (beautyRows.length > 0) {
    deptMap['美容部'] = beautyRows.map(r => ({
      staffWfId: r.employee_id,
      name: r.name || '',
      position: r.position || '',
      department: '美容部'
    }))
  }

  // 其他部门
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
 * 统计当前员工今日的营业额分配金额、订单数、服务单数
 * 店长额外返回门店今日总营收
 * 入账口径：仅已支付订单，按 paid_at 统计
 */
async function todayCommission(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { staffWfId, storeName, position } = ctx.auth
  const isManager = position === '门店经理'

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayEnd = new Date(todayStart)
  todayEnd.setDate(todayEnd.getDate() + 1)
  const todayStr = todayStart.toISOString().slice(0, 10)

  // 今日分成金额 + 订单数
  const commissionRows = await pg.query(`
    SELECT
      COALESCE(SUM(ra.total_amount::numeric), 0) AS today_amount,
      COUNT(DISTINCT o.order_no) AS order_count
    FROM revenue_allocations ra
    JOIN orders o ON o.order_no = ra.order_no
    WHERE ra.employee_id = $1
      AND ra.is_void = false
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
  if (isManager && storeName) {
    const storeRows = await pg.query(`
      SELECT COALESCE(SUM(oi.received::numeric), 0) AS store_revenue
      FROM order_items oi
      JOIN orders o ON o.order_no = oi.order_no
      WHERE o.store_name = $1
        AND o.status = '已支付'
        AND o.paid_at >= $2
        AND o.paid_at < $3
    `, [storeName, todayStart, todayEnd])
    result.storeTodayRevenue = Number(storeRows[0].store_revenue).toFixed(2)
  }

  ctx.result = result
}

/**
 * 月度业绩日历
 * 按日汇总当前员工的营业额分配金额
 * payload: { yearMonth: '2026-02' }
 * 入账口径：仅已支付订单，按 paid_at 统计
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
      SUM(ra.total_amount::numeric) AS amount
    FROM revenue_allocations ra
    JOIN orders o ON o.order_no = ra.order_no
    WHERE ra.employee_id = $1
      AND ra.is_void = false
      AND o.status = '已支付'
      AND o.paid_at >= $2
      AND o.paid_at < $3
    GROUP BY DATE(o.paid_at)
    ORDER BY DATE(o.paid_at)
  `, [staffWfId, monthStart, monthEnd])

  // 月度汇总
  const totalRows = await pg.query(`
    SELECT
      COALESCE(SUM(ra.total_amount::numeric), 0) AS total_amount,
      COUNT(DISTINCT o.order_no) AS total_order_count
    FROM revenue_allocations ra
    JOIN orders o ON o.order_no = ra.order_no
    WHERE ra.employee_id = $1
      AND ra.is_void = false
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
 * 美容师：自己的待确认预约 + 待推进服务单
 * 店长：门店全部待确认预约 + 门店服务单 + 待确认收款订单 + 待支付订单
 */
async function todoList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { staffWfId, storeName, position } = ctx.auth
  const isManager = position === '门店经理'

  // 待确认预约
  let appointmentCount
  if (isManager) {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE store_name = $1 AND status = '待确认'`,
      [storeName]
    )
  } else {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE employee_id = $1 AND status = '待确认'`,
      [staffWfId]
    )
  }

  // 待推进服务单（待服务 + 服务中）
  let serviceCount
  if (isManager) {
    serviceCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM service_orders WHERE store_name = $1 AND status IN ('待服务', '服务中')`,
      [storeName]
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

  // 店长专属：待确认收款 + 待支付订单（排除员工开单）
  if (isManager) {
    const offlineRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM orders WHERE store_name = $1 AND status = '待确认收款'`,
      [storeName]
    )
    const createRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM orders WHERE store_name = $1 AND status = '待支付' AND order_source != 'staff'`,
      [storeName]
    )
    result.pendingOfflineOrderCount = Number(offlineRows[0].cnt)
    result.pendingCreateOrderCount = Number(createRows[0].cnt)

    const unbindRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM store_unbind_requests WHERE from_store_name = $1 AND status = 'pending'`,
      [storeName]
    )
    result.pendingUnbindCount = Number(unbindRows[0].cnt)

    // 待提成分配订单
    const allocRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM orders WHERE store_name = $1 AND status = '已支付' AND allocation_status = 'pending'`,
      [storeName]
    )
    result.pendingAllocationCount = Number(allocRows[0].cnt)
  }

  ctx.result = result
}

/**
 * 切换工作门店
 * 仅做门店存在性校验（从 PG stores 表），返回门店名称供前端本地存储
 */
async function bindStore(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { storeId } = ctx.event.payload || {}
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少 storeId 参数')
  }

  // 从 PG stores 表验证门店存在
  const storeRows = await pg.query(
    'SELECT store_name FROM stores WHERE store_name = $1 AND is_closed = false',
    [storeId]
  )

  if (storeRows.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在或已关闭')
  }

  const storeName = storeRows[0].store_name

  ctx.result = {
    success: true,
    storeName
  }
}

module.exports = { list, departments, todayCommission, monthlyCalendar, todoList, bindStore }
