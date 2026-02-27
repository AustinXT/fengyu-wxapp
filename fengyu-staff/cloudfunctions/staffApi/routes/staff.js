/**
 * 员工模块路由（员工端）
 * staff.list — 门店员工列表
 * staff.departments — 部门列表（含可分配员工）
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { requireStaffBound } = require('../middleware/auth')

/**
 * 员工列表
 * 从 WorkFine UDT_S_287 查询指定门店的在职员工
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

  const esc = (v) => String(v).replace(/'/g, "''")

  const staffRows = await mssql.query(`
    SELECT
      UDF_S_1147 AS staff_wf_id,
      UDF_S_1155 AS name,
      UDF_S_1161 AS position,
      UDF_S_1513 AS department,
      UDF_S_1163 AS store_name,
      UDF_S_1160 AS market_name
    FROM UDT_S_287
    WHERE UDF_S_1624 NOT IN ('是', '离职')
      AND UDF_S_1163 = '${esc(targetStore)}'
    ORDER BY UDF_S_1513, UDF_S_1155
  `)

  ctx.result = {
    staffList: staffRows.map(r => ({
      staffWfId: r.staff_wf_id,
      name: r.name ? r.name.trim() : '',
      position: r.position ? r.position.trim() : '',
      department: r.department ? r.department.trim() : '',
      storeName: r.store_name ? r.store_name.trim() : '',
      marketName: r.market_name ? r.market_name.trim() : '',
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

  const esc = (v) => String(v).replace(/'/g, "''")

  // 查询美容部（含店长）
  const beautyRows = await mssql.query(`
    SELECT
      UDF_S_1147 AS staff_wf_id,
      UDF_S_1155 AS name,
      UDF_S_1161 AS position,
      UDF_S_1513 AS department
    FROM UDT_S_287
    WHERE UDF_S_1624 NOT IN ('是', '离职')
      AND UDF_S_1163 = '${esc(targetStore)}'
      AND UDF_S_1513 = '美容部'
    ORDER BY UDF_S_1155
  `)

  // 查询其他部门（推广部等，按市场查询）
  // 推广部等从市场维度查询，不限门店
  const marketName = ctx.auth.marketName
  let otherDeptRows = []

  if (marketName) {
    otherDeptRows = await mssql.query(`
      SELECT
        UDF_S_1147 AS staff_wf_id,
        UDF_S_1155 AS name,
        UDF_S_1161 AS position,
        UDF_S_1513 AS department,
        UDF_S_1163 AS store_name
      FROM UDT_S_287
      WHERE UDF_S_1624 NOT IN ('是', '离职')
        AND UDF_S_1160 = '${esc(marketName)}'
        AND UDF_S_1513 != '美容部'
        AND UDF_S_1513 IS NOT NULL
        AND UDF_S_1513 != ''
      ORDER BY UDF_S_1513, UDF_S_1155
    `)
  }

  // 按部门分组
  const deptMap = {}

  // 美容部
  if (beautyRows.length > 0) {
    deptMap['美容部'] = beautyRows.map(r => ({
      staffWfId: r.staff_wf_id,
      name: r.name ? r.name.trim() : '',
      position: r.position ? r.position.trim() : '',
      department: '美容部'
    }))
  }

  // 其他部门
  for (const r of otherDeptRows) {
    const dept = r.department ? r.department.trim() : '其他'
    if (!deptMap[dept]) deptMap[dept] = []
    deptMap[dept].push({
      staffWfId: r.staff_wf_id,
      name: r.name ? r.name.trim() : '',
      position: r.position ? r.position.trim() : '',
      department: dept,
      storeName: r.store_name ? r.store_name.trim() : ''
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

  const { staffWfId, storeName, role } = ctx.auth
  const isManager = role === 'manager'

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
    WHERE assigned_staff_wf_id = $1
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
    WHERE assigned_staff_wf_id = $1
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

  const { staffWfId, storeName, role } = ctx.auth
  const isManager = role === 'manager'

  // 待确认预约
  let appointmentCount
  if (isManager) {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE store_name = $1 AND status = '待确认'`,
      [storeName]
    )
  } else {
    appointmentCount = await pg.query(
      `SELECT COUNT(*) AS cnt FROM appointments WHERE staff_wf_id = $1 AND status = '待确认'`,
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
      `SELECT COUNT(*) AS cnt FROM service_orders WHERE assigned_staff_wf_id = $1 AND status IN ('待服务', '服务中')`,
      [staffWfId]
    )
  }

  const result = {
    pendingAppointmentCount: Number(appointmentCount[0].cnt),
    pendingServiceCount: Number(serviceCount[0].cnt),
  }

  // 店长专属：待确认收款 + 待支付订单
  if (isManager) {
    const offlineRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM orders WHERE store_name = $1 AND status = '待确认收款'`,
      [storeName]
    )
    const createRows = await pg.query(
      `SELECT COUNT(*) AS cnt FROM orders WHERE store_name = $1 AND status = '待支付'`,
      [storeName]
    )
    result.pendingOfflineOrderCount = Number(offlineRows[0].cnt)
    result.pendingCreateOrderCount = Number(createRows[0].cnt)
  }

  ctx.result = result
}

module.exports = { list, departments, todayCommission, monthlyCalendar, todoList }
