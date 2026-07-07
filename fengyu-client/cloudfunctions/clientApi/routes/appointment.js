

const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { checkText } = require('../utils/wx-sec-check')


async function create(ctx) {
  
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload

  const {
    saleItemId, 
    staffWfId, 
    staffName: inputStaffName, 
    appointmentTime, 
    notes 
  } = payload

  if (!appointmentTime) {
    throw new Error('INVALID_PARAMS: 缺少预约时间')
  }

  
  const parsedTime = parseAppointmentTime(appointmentTime)

  
  if (parsedTime.getTime() < Date.now() - 5 * 60 * 1000) {
    throw new Error('INVALID_PARAMS: 预约时间不能为过去')
  }

  
  
  if (staffWfId) {
    const m = String(appointmentTime).match(/^(\d{4}-\d{2}-\d{2})\s+.*?(\d{2}:\d{2})-\d{2}:\d{2}$/)
    const slotStart = m ? `${m[1]} ${m[2]}:00` : null
    if (slotStart) {
      const leaveRows = await pg.query(
        `SELECT 1 FROM staff_wechat_users
         WHERE employee_id = $1
           AND leave_start IS NOT NULL AND leave_end IS NOT NULL
           AND $2::timestamp >= leave_start AND $2::timestamp <= leave_end`,
        [staffWfId, slotStart]
      )
      if (leaveRows.length > 0) {
        throw new Error('INVALID_STATE: 该美容师所选时段休假中，请另选时段或美容师')
      }
    }
  }

  
  const users = await pg.query(
    `SELECT u.phone, u.name, u.bound_store_id,
            s.store_name AS bound_store_name
     FROM client_wechat_users u
     LEFT JOIN stores s ON u.bound_store_id = s.store_id
     WHERE u.user_id = $1`,
    [userId]
  )

  const userStoreId = users[0]?.bound_store_id || ''

  let orderItem = null

  if (saleItemId) {
    
    const orderItems = await pg.query(`
      SELECT
        si.sale_item_id,
        si.sale_order_id,
        si.remaining_sessions,
        o.client_user_id,
        o.store_id
      FROM sale_items si
      LEFT JOIN sale_orders o ON si.sale_order_id = o.sale_order_id
      WHERE si.sale_item_id = $1
    `, [saleItemId])

    if (orderItems.length === 0) {
      throw new Error('INVALID_PARAMS: 订单明细不存在')
    }

    orderItem = orderItems[0]

    if (orderItem.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }

    if (orderItem.remaining_sessions <= 0) {
      throw new Error('INVALID_PARAMS: 剩余次数不足')
    }

    
    const existingAppointments = await pg.query(
      `SELECT appointment_id FROM appointments
       WHERE sale_item_id = $1 AND status IN ('待确认', '已确认')`,
      [saleItemId]
    )

    if (existingAppointments.length > 0) {
      throw new Error('INVALID_PARAMS: 该订单明细已有待确认或已确认的预约')
    }
  }

  
  const storeId = orderItem?.store_id || userStoreId
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 请先绑定门店后再预约')
  }

  
  let clientName = users[0]?.name || ''
  if (!clientName) clientName = users[0]?.phone || ''

  
  await checkText(notes, { scene: 1 })

  
  
  const appointmentId = generateAppointmentId()
  const now = new Date()

  try {
    await pg.query(`
      INSERT INTO appointments (
        appointment_id, status, store_id,
        client_user_id, client_name, employee_id, employee_name,
        appointment_time, notes, sale_item_id, created_at, updated_at
      ) VALUES ($1, '待确认', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
    `, [
      appointmentId, storeId,
      userId, clientName, staffWfId || null, inputStaffName || null,
      parsedTime, notes || '', saleItemId || null, now
    ])
  } catch (err) {
    if (err && err.code === '23505' && err.constraint === 'uq_appt_sale_item_active') {
      throw new Error('CONFLICT: 该订单明细已有待确认或已确认的预约')
    }
    throw err
  }

  ctx.result = {
    appointmentId,
    status: '待确认',
    message: '预约已提交,等待确认'
  }
}


async function list(ctx) {
  const { userId } = ctx.auth
  const { status, page: pageParam, pageSize: pageSizeParam } = ctx.event.payload || {}

  
  const pageSize = Math.min(Math.max(Number(pageSizeParam) || 20, 1), 50)
  const page = Math.max(Number(pageParam) || 1, 1)
  const offset = (page - 1) * pageSize

  let whereClause = 'WHERE a.client_user_id = $1'
  const params = [userId]

  if (status) {
    params.push(status)
    whereClause += ` AND a.status = $${params.length}`
  }

  
  const fetchLimit = pageSize + 1
  params.push(fetchLimit, offset)

  const appointments = await pg.query(`
    SELECT
      a.appointment_id,
      a.status,
      a.store_id,
      s.store_name,
      a.employee_id,
      a.employee_name,
      sw.avatar_url AS employee_avatar_url,
      a.appointment_time,
      a.notes,
      a.sale_item_id,
      a.created_at,
      si.sale_order_id,
      COALESCE(si.product_name, '到店预约') AS service_name
    FROM appointments a
    LEFT JOIN sale_items si ON a.sale_item_id = si.sale_item_id
    LEFT JOIN stores s ON a.store_id = s.store_id
    LEFT JOIN staff_wechat_users sw ON a.employee_id = sw.employee_id
    ${whereClause}
    ORDER BY a.appointment_time DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params)

  const hasMore = appointments.length > pageSize
  if (hasMore) appointments.pop()

  ctx.result = { appointments, hasMore }
}


async function cancel(ctx) {
  const { userId } = ctx.auth
  const { appointmentId, cancelledReason } = ctx.event.payload || {}

  if (!appointmentId) {
    throw new Error('INVALID_PARAMS: 缺少 appointmentId 参数')
  }

  const appointments = await pg.query(
    'SELECT * FROM appointments WHERE appointment_id = $1 AND client_user_id = $2',
    [appointmentId, userId]
  )

  if (appointments.length === 0) {
    throw new Error('INVALID_PARAMS: 预约不存在')
  }

  const appointment = appointments[0]

  if (appointment.status !== '待确认') {
    throw new Error('INVALID_PARAMS: 仅待确认的预约可取消')
  }

  
  
  
  
  const linkedService = await pg.query(
    `SELECT 1 FROM service_orders
     WHERE appointment_id = $1
       AND status NOT IN ('已取消')
     LIMIT 1`,
    [appointmentId]
  )
  if (linkedService.length > 0) {
    throw new Error('INVALID_STATE: 该预约已开始服务，无法取消')
  }

  const now = new Date()
  const cancelUpd = await pg.query(
    `UPDATE appointments
     SET status = '已取消', cancelled_reason = $1, updated_at = $2
     WHERE appointment_id = $3
       AND status = '待确认'`,
    [cancelledReason || '', now, appointmentId]
  )
  if (cancelUpd.rowCount === 0) {
    throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:appointments:${appointmentId}:→已取消`)
  }

  ctx.result = {
    appointmentId,
    status: '已取消',
    message: '预约已取消'
  }
}


function parseAppointmentTime(timeStr) {
  const match = timeStr.match(/^(\d{4}-\d{2}-\d{2})\s+.*?(\d{2}:\d{2})-\d{2}:\d{2}$/)
  if (!match) {
    throw new Error('INVALID_PARAMS: 预约时间格式不正确')
  }
  const date = new Date(`${match[1]}T${match[2]}:00+08:00`)
  if (isNaN(date.getTime())) {
    throw new Error('INVALID_PARAMS: 预约时间解析失败')
  }
  return date
}

function generateAppointmentId() {
  return 'apt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)
}

module.exports = {
  create,
  list,
  cancel
}
