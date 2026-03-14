/**
 * 预约模块路由（员工端）
 * appointment.list — 预约列表
 * appointment.detail — 预约详情
 * appointment.confirm — 确认预约
 * appointment.checkin — 顾客到店签到
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

/**
 * 格式化时间为北京时间可读格式：M月D日 HH:mm
 */
function formatDateTime(date) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return String(date)
  const offset = 8 * 60 * 60 * 1000
  const beijing = new Date(d.getTime() + offset)
  const m = beijing.getUTCMonth() + 1
  const day = beijing.getUTCDate()
  const h = String(beijing.getUTCHours()).padStart(2, '0')
  const min = String(beijing.getUTCMinutes()).padStart(2, '0')
  return `${m}月${day}日 ${h}:${min}`
}

// 预约状态映射
const STATUS_CN_TO_EN = {
  '待确认': 'pending',
  '已确认': 'confirmed',
  '已完成': 'completed',
  '已取消': 'cancelled',
  '已关闭': 'closed',
}
const STATUS_EN_TO_CN = {}
for (const [cn, en] of Object.entries(STATUS_CN_TO_EN)) {
  STATUS_EN_TO_CN[en] = cn
}

/**
 * 预约列表
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, todayOnly, page = 1, pageSize = 50 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.storeId, pageSize, offset]
  let whereExtra = ''

  if (status && status !== 'all') {
    const cnStatus = STATUS_EN_TO_CN[status] || status
    params.push(cnStatus)
    whereExtra += ` AND a.status = $${params.length}`
  }

  if (todayOnly) {
    const today = new Date().toISOString().slice(0, 10)
    params.push(today)
    whereExtra += ` AND DATE(a.appointment_time) = $${params.length}::date`
  }

  // 美容师只看指定自己的预约
  if (!ctx.auth.roles.includes('manager')) {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND a.employee_id = $${params.length}`
  }

  const appointments = await pg.query(`
    SELECT
      a.appointment_id,
      a.status,
      a.client_user_id,
      a.client_name,
      a.employee_id,
      a.employee_name,
      a.appointment_time,
      a.notes,
      a.sale_item_id,
      a.checkin_at,
      a.created_at,
      si.sale_order_id,
      COALESCE(si.product_name, '到店预约') AS service_name,
      si.sku_spec_name,
      wu.phone AS customer_phone
    FROM appointments a
    LEFT JOIN sale_items si ON a.sale_item_id = si.sale_item_id
    LEFT JOIN client_wechat_users wu ON a.client_user_id = wu.user_id
    WHERE a.store_id = $1
    ${whereExtra}
    ORDER BY a.appointment_time ASC
    LIMIT $2 OFFSET $3
  `, params)

  ctx.result = appointments.map(a => ({
    id: a.appointment_id,
    customerName: a.client_name,
    customerPhone: a.customer_phone || '',
    clientUserId: a.client_user_id,
    staffName: a.employee_name,
    appointmentTime: formatDateTime(a.appointment_time),
    status: STATUS_CN_TO_EN[a.status] || a.status,
    statusText: a.status,
    serviceItemName: a.service_name || a.sku_spec_name || '',
    remark: a.notes || '',
    checkinAt: a.checkin_at,
  }))
}

/**
 * 预约详情
 */
async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { id } = ctx.event.payload || {}
  if (!id) {
    throw new Error('INVALID_PARAMS: 缺少 id 参数')
  }

  const appointments = await pg.query(`
    SELECT
      a.appointment_id,
      a.status,
      a.client_user_id,
      a.client_name,
      a.employee_id,
      a.employee_name,
      a.appointment_time,
      a.notes,
      a.sale_item_id,
      a.checkin_at,
      COALESCE(si.product_name, '到店预约') AS service_name,
      si.sku_spec_name,
      wu.phone AS customer_phone,
      so.service_order_id AS service_order_id
    FROM appointments a
    LEFT JOIN sale_items si ON a.sale_item_id = si.sale_item_id
    LEFT JOIN client_wechat_users wu ON a.client_user_id = wu.user_id
    LEFT JOIN service_orders so ON so.appointment_id = a.appointment_id
    WHERE a.appointment_id = $1 AND a.store_id = $2
  `, [id, ctx.auth.storeId])

  if (appointments.length === 0) {
    throw new Error('INVALID_PARAMS: 预约不存在或不属于本门店')
  }

  const a = appointments[0]

  // 美容师只能查看指定自己的预约
  if (!ctx.auth.roles.includes('manager') && a.employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权查看该预约')
  }

  ctx.result = {
    id: a.appointment_id,
    customerName: a.client_name,
    customerPhone: a.customer_phone || '',
    clientUserId: a.client_user_id,
    staffName: a.employee_name,
    appointmentTime: formatDateTime(a.appointment_time),
    status: STATUS_CN_TO_EN[a.status] || a.status,
    statusText: a.status,
    serviceItemName: a.service_name || a.sku_spec_name || '',
    remark: a.notes || '',
    serviceOrderId: a.service_order_id || null,
    checkinAt: a.checkin_at,
  }
}

/**
 * 确认预约
 */
async function confirm(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { appointmentId } = ctx.event.payload || {}
  if (!appointmentId) {
    throw new Error('INVALID_PARAMS: 缺少 appointmentId')
  }

  const appointments = await pg.query(
    'SELECT * FROM appointments WHERE appointment_id = $1 AND store_id = $2',
    [appointmentId, ctx.auth.storeId]
  )

  if (appointments.length === 0) {
    throw new Error('INVALID_PARAMS: 预约不存在或不属于本门店')
  }

  const appt = appointments[0]

  if (!ctx.auth.roles.includes('manager') && appt.employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权确认该预约')
  }

  if (appt.status !== '待确认') {
    throw new Error(`INVALID_PARAMS: 预约当前状态为"${appt.status}"，不可确认`)
  }

  const now = new Date()
  await pg.query(
    "UPDATE appointments SET status = '已确认', confirmed_at = $1, updated_at = $1 WHERE appointment_id = $2",
    [now, appointmentId]
  )

  ctx.result = {
    appointmentId,
    status: '已确认',
    message: '预约已确认'
  }
}

/**
 * 顾客到店签到
 */
async function checkin(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { appointmentId } = ctx.event.payload || {}
  if (!appointmentId) {
    throw new Error('INVALID_PARAMS: 缺少 appointmentId')
  }

  const appointments = await pg.query(
    'SELECT * FROM appointments WHERE appointment_id = $1 AND store_id = $2',
    [appointmentId, ctx.auth.storeId]
  )

  if (appointments.length === 0) {
    throw new Error('INVALID_PARAMS: 预约不存在或不属于本门店')
  }

  const appt = appointments[0]

  if (!ctx.auth.roles.includes('manager') && appt.employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权操作该预约')
  }

  if (!['待确认', '已确认'].includes(appt.status)) {
    throw new Error(`INVALID_PARAMS: 预约状态"${appt.status}"不支持签到`)
  }

  const now = new Date()
  await pg.query(
    'UPDATE appointments SET checkin_at = $1, updated_at = $1 WHERE appointment_id = $2',
    [now, appointmentId]
  )

  ctx.result = {
    appointmentId,
    checkinAt: now,
    message: '顾客已到店，请准备服务'
  }
}

module.exports = { list, detail, confirm, checkin }
