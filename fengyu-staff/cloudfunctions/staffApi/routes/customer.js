/**
 * 顾客档案模块路由（员工端）
 * customer.search — 搜索顾客
 * customer.calendar — 顾客消费日历
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { requireStaffBound } = require('../middleware/auth')

/**
 * 搜索顾客
 * 从 WorkFine UDT_S_311 按姓名或手机号搜索
 * 美容师不可查看完整手机号
 */
async function search(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { keyword } = ctx.event.payload || {}

  if (!keyword || keyword.trim().length < 1) {
    throw new Error('INVALID_PARAMS: 搜索关键词不能为空')
  }

  const esc = (v) => String(v).replace(/'/g, "''")
  const k = esc(keyword.trim())
  const isManager = ctx.auth.role === 'manager'

  const customerRows = await mssql.query(`
    SELECT TOP 20
      UDF_S_1475 AS customer_no,
      UDF_S_1476 AS name,
      UDF_S_1478 AS phone,
      UDF_S_1477 AS member_level,
      UDF_S_6443 AS store_name,
      UDF_S_6444 AS main_staff_id,
      UDF_S_1474 AS register_date
    FROM UDT_S_311
    WHERE (
      UDF_S_1476 LIKE '%${k}%'
      OR UDF_S_1478 LIKE '%${k}%'
    )
    ORDER BY UDF_S_1474 DESC
  `)

  ctx.result = {
    customers: customerRows.map(r => ({
      customerNo: r.customer_no,
      name: r.name ? r.name.trim() : '',
      // 美容师只能看到手机号后4位
      phone: isManager
        ? (r.phone || '')
        : maskPhone(r.phone),
      memberLevel: r.member_level,
      storeName: r.store_name ? r.store_name.trim() : '',
      mainStaffId: r.main_staff_id,
      registerDate: r.register_date
    }))
  }
}

/**
 * 顾客消费日历
 * 查询 PG 数据库中该顾客已支付订单，按日期汇总金额
 *
 * 入账口径：仅 '已支付' 状态订单，按 paid_at 日期统计
 */
async function calendar(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { clientUserId, clientPhone, year, month } = ctx.event.payload || {}

  if (!clientUserId && !clientPhone) {
    throw new Error('INVALID_PARAMS: 缺少 clientUserId 或 clientPhone')
  }

  if (!year || !month) {
    throw new Error('INVALID_PARAMS: 缺少 year 或 month')
  }

  // 构建查询条件（按月查询）
  const startDate = new Date(year, month - 1, 1)
  const endDate = new Date(year, month, 1)

  let whereClause
  const params = [startDate, endDate]

  if (clientUserId) {
    params.push(clientUserId)
    whereClause = `
      o.status = '已支付'
      AND o.paid_at >= $1
      AND o.paid_at < $2
      AND o.client_user_id = $3
    `
  } else {
    params.push(clientPhone)
    whereClause = `
      o.status = '已支付'
      AND o.paid_at >= $1
      AND o.paid_at < $2
      AND o.client_phone = $3
    `
  }

  // 按日期汇总消费金额（实收金额）
  const rows = await pg.query(`
    SELECT
      DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai') AS pay_date,
      COUNT(DISTINCT o.order_no) AS order_count,
      COALESCE(SUM(oi.received), 0) AS total_received
    FROM orders o
    INNER JOIN order_items oi ON o.order_no = oi.order_no
    WHERE ${whereClause}
    GROUP BY DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai')
    ORDER BY pay_date
  `, params)

  // 查询当月的订单详情（用于展开查看）
  const orderRows = await pg.query(`
    SELECT
      o.order_no,
      o.order_type,
      o.store_name,
      o.payment_method,
      o.paid_at,
      o.client_phone,
      o.customer_name,
      DATE(o.paid_at AT TIME ZONE 'Asia/Shanghai') AS pay_date,
      COALESCE((
        SELECT SUM(oi2.received)
        FROM order_items oi2
        WHERE oi2.order_no = o.order_no
      ), 0) AS total_received
    FROM orders o
    WHERE ${whereClause}
    ORDER BY o.paid_at DESC
  `, params)

  ctx.result = {
    year,
    month,
    dailySummary: rows.map(r => ({
      date: r.pay_date,
      orderCount: parseInt(r.order_count),
      totalReceived: parseFloat(r.total_received)
    })),
    orders: orderRows.map(r => ({
      orderNo: r.order_no,
      orderType: r.order_type,
      storeName: r.store_name,
      paymentMethod: r.payment_method,
      paidAt: r.paid_at,
      payDate: r.pay_date,
      clientPhone: r.client_phone,
      customerName: r.customer_name,
      totalReceived: parseFloat(r.total_received)
    }))
  }
}

/**
 * 手机号脱敏：显示后4位，其余替换为 *
 */
function maskPhone(phone) {
  if (!phone) return ''
  const p = String(phone).trim()
  if (p.length <= 4) return '****'
  return '*'.repeat(p.length - 4) + p.slice(-4)
}

module.exports = { search, calendar }
