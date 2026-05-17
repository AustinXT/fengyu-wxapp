/**
 * 预约模块路由
 * 顾客发起预约、查看预约、取消预约
 */

const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')

/**
 * 发起预约
 * 顾客针对已支付订单的次数余额发起预约
 */
async function create(ctx) {
  // 必须绑定手机号
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload

  const {
    saleItemId, // 销售明细ID,对应 sale_items.sale_item_id（可选）
    staffWfId, // 预约美容师(可选)
    staffName: inputStaffName, // 美容师姓名(前端传入)
    appointmentTime, // 预约到店时间
    notes // 备注(可选)
  } = payload

  if (!appointmentTime) {
    throw new Error('INVALID_PARAMS: 缺少预约时间')
  }

  // 解析前端传入的时段字符串
  const parsedTime = parseAppointmentTime(appointmentTime)

  // 校验预约时间不能为过去（允许 5 分钟容差，避免网络延迟误拒）
  if (parsedTime.getTime() < Date.now() - 5 * 60 * 1000) {
    throw new Error('INVALID_PARAMS: 预约时间不能为过去')
  }

  // 查询顾客信息
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
    // 关联疗程卡：验证权限和剩余次数
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

    // 检查是否已有待确认或已确认的预约
    const existingAppointments = await pg.query(
      `SELECT appointment_id FROM appointments
       WHERE sale_item_id = $1 AND status IN ('待确认', '已确认')`,
      [saleItemId]
    )

    if (existingAppointments.length > 0) {
      throw new Error('INVALID_PARAMS: 该订单明细已有待确认或已确认的预约')
    }
  }

  // 门店信息：优先从订单取，否则从用户绑定门店取
  const storeId = orderItem?.store_id || userStoreId
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 请先绑定门店后再预约')
  }

  // 顾客姓名从 client_wechat_users
  let clientName = users[0]?.name || ''
  if (!clientName) clientName = users[0]?.phone || ''

  // 创建预约
  // partial unique uq_appt_sale_item_active 兜底 TOCTOU：同 sale_item 双发 create
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
      userId, clientName, staffWfId || null, inputStaffName || '',
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

/**
 * 预约列表
 * 查询顾客的所有预约
 */
async function list(ctx) {
  const { userId } = ctx.auth
  const { status, page: pageParam, pageSize: pageSizeParam } = ctx.event.payload || {}

  // 分页参数（默认 20 条/页，上限 50）
  const pageSize = Math.min(Math.max(Number(pageSizeParam) || 20, 1), 50)
  const page = Math.max(Number(pageParam) || 1, 1)
  const offset = (page - 1) * pageSize

  let whereClause = 'WHERE a.client_user_id = $1'
  const params = [userId]

  if (status) {
    params.push(status)
    whereClause += ` AND a.status = $${params.length}`
  }

  // 多取 1 条用于判断是否有下一页
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
      a.appointment_time,
      a.notes,
      a.sale_item_id,
      a.created_at,
      si.sale_order_id,
      COALESCE(si.product_name, '到店预约') AS service_name,
      si.sku_spec_name
    FROM appointments a
    LEFT JOIN sale_items si ON a.sale_item_id = si.sale_item_id
    LEFT JOIN stores s ON a.store_id = s.store_id
    ${whereClause}
    ORDER BY a.appointment_time DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params)

  const hasMore = appointments.length > pageSize
  if (hasMore) appointments.pop()

  ctx.result = { appointments, hasMore }
}

/**
 * 取消预约
 * 顾客可取消待确认或已确认状态的预约
 */
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

  if (!['待确认', '已确认'].includes(appointment.status)) {
    throw new Error('INVALID_PARAMS: 预约状态不允许取消')
  }

  const now = new Date()
  const cancelUpd = await pg.query(
    `UPDATE appointments
     SET status = '已取消', cancelled_reason = $1, updated_at = $2
     WHERE appointment_id = $3
       AND status IN ('待确认', '已确认')`,
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

/**
 * 解析前端时段字符串为 Date 对象
 */
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
