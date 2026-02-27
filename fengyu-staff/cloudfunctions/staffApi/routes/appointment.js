/**
 * 预约模块路由（员工端）
 * appointment.list — 预约列表
 * appointment.confirm — 确认预约
 * appointment.checkin — 顾客到店签到
 */

const pg = require('../db/pg')
const { requireStaffBound } = require('../middleware/auth')

/**
 * 预约列表
 * 店长：查看本店所有预约
 * 美容师：查看预约美容师为自己的预约
 *
 * payload: {
 *   status: string | null,  // 筛选状态：'待确认'|'已确认'|null(全部)
 *   page: number,
 *   pageSize: number
 * }
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, page = 1, pageSize = 50 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.storeName, pageSize, offset]
  let whereExtra = ''

  if (status) {
    params.push(status)
    whereExtra += ` AND a.status = $${params.length}`
  }

  // 美容师只看指定自己的预约
  if (ctx.auth.role !== 'manager') {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND a.staff_wf_id = $${params.length}`
  }

  const appointments = await pg.query(`
    SELECT
      a.appointment_id,
      a.status,
      a.client_user_id,
      a.customer_name,
      a.staff_wf_id,
      a.staff_name,
      a.appointment_time,
      a.notes,
      a.item_flow_no,
      a.checkin_at,
      a.created_at,
      oi.order_no,
      COALESCE(p.name, '到店预约') AS service_name,
      m.sku_display_name
    FROM appointments a
    LEFT JOIN order_items oi ON a.item_flow_no = oi.item_flow_no
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE a.store_name = $1
    ${whereExtra}
    ORDER BY a.appointment_time ASC
    LIMIT $2 OFFSET $3
  `, params)

  ctx.result = {
    appointments: appointments.map(a => ({
      ...a,
      checkinAt: a.checkin_at
    })),
    page,
    pageSize
  }
}

/**
 * 确认预约
 * 店长或被预约美容师可确认
 */
async function confirm(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { appointmentId } = ctx.event.payload || {}
  if (!appointmentId) {
    throw new Error('INVALID_PARAMS: 缺少 appointmentId')
  }

  const appointments = await pg.query(
    'SELECT * FROM appointments WHERE appointment_id = $1 AND store_name = $2',
    [appointmentId, ctx.auth.storeName]
  )

  if (appointments.length === 0) {
    throw new Error('INVALID_PARAMS: 预约不存在或不属于本门店')
  }

  const appt = appointments[0]

  // 权限：店长或被预约美容师
  if (ctx.auth.role !== 'manager' && appt.staff_wf_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权确认该预约')
  }

  if (appt.status !== '待确认') {
    throw new Error(`INVALID_PARAMS: 预约当前状态为"${appt.status}"，不可确认`)
  }

  const now = new Date()
  await pg.query(
    "UPDATE appointments SET status = '已确认', updated_at = $1 WHERE appointment_id = $2",
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
 * 记录到店时间，不改变预约状态
 */
async function checkin(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { appointmentId } = ctx.event.payload || {}
  if (!appointmentId) {
    throw new Error('INVALID_PARAMS: 缺少 appointmentId')
  }

  const appointments = await pg.query(
    'SELECT * FROM appointments WHERE appointment_id = $1 AND store_name = $2',
    [appointmentId, ctx.auth.storeName]
  )

  if (appointments.length === 0) {
    throw new Error('INVALID_PARAMS: 预约不存在或不属于本门店')
  }

  const appt = appointments[0]

  if (ctx.auth.role !== 'manager' && appt.staff_wf_id !== ctx.auth.staffWfId) {
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

module.exports = { list, confirm, checkin }
