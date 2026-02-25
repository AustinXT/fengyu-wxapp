/**
 * 预约模块路由
 * 顾客发起预约、查看预约、取消预约
 */

const pg = require('../db/pg')
const { requireFields } = require('../middleware/validate')
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
    itemFlowNo, // 销售流水号,对应 order_items.item_flow_no
    staffWfId, // 预约美容师(可选)
    appointmentTime, // 预约到店时间
    notes // 备注(可选)
  } = payload

  if (!appointmentTime) {
    throw new Error('INVALID_PARAMS: 缺少预约时间')
  }

  // 查询顾客信息
  const users = await pg.query(
    'SELECT phone, store_name, market_name FROM client_wechat_users WHERE user_id = $1',
    [userId]
  )

  let orderItem = null

  if (itemFlowNo) {
    // 关联疗程卡：验证权限和剩余次数
    const orderItems = await pg.query(`
      SELECT
        oi.item_flow_no,
        oi.order_no,
        oi.remaining_sessions,
        o.client_user_id,
        o.store_name,
        o.market_name
      FROM order_items oi
      LEFT JOIN orders o ON oi.order_no = o.order_no
      WHERE oi.item_flow_no = $1
    `, [itemFlowNo])

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
       WHERE item_flow_no = $1 AND status IN ('待确认', '已确认')`,
      [itemFlowNo]
    )

    if (existingAppointments.length > 0) {
      throw new Error('INVALID_PARAMS: 该订单明细已有待确认或已确认的预约')
    }
  }

  // 门店信息：优先从订单取，否则从用户绑定门店取
  const marketName = orderItem?.market_name || users[0]?.market_name || ''
  const storeName = orderItem?.store_name || users[0]?.store_name || ''

  // 查询美容师姓名(如果指定了)
  let staffName = null
  if (staffWfId) {
    // TODO: 从 WorkFine 查询美容师姓名
    staffName = '美容师' // 临时占位
  }

  // 创建预约
  const appointmentId = generateAppointmentId()
  const now = new Date()

  await pg.query(`
    INSERT INTO appointments (
      appointment_id, status, market_name, store_name,
      client_user_id, customer_name, staff_wf_id, staff_name,
      appointment_time, notes, item_flow_no, created_at, updated_at
    ) VALUES ($1, '待确认', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
  `, [
    appointmentId, marketName, storeName,
    userId, users[0]?.phone || '', staffWfId, staffName,
    appointmentTime, notes || '', itemFlowNo || null, now
  ])

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
  const { status } = ctx.event.payload || {}

  // 构造查询条件
  let whereClause = 'WHERE a.client_user_id = $1'
  const params = [userId]

  if (status) {
    params.push(status)
    whereClause += ` AND a.status = $${params.length}`
  }

  const appointments = await pg.query(`
    SELECT
      a.appointment_id,
      a.status,
      a.store_name,
      a.staff_wf_id,
      a.staff_name,
      a.appointment_time,
      a.notes,
      a.item_flow_no,
      a.created_at,
      oi.order_no,
      COALESCE(p.name, '到店预约') AS service_name,
      m.sku_display_name
    FROM appointments a
    LEFT JOIN order_items oi ON a.item_flow_no = oi.item_flow_no
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    ${whereClause}
    ORDER BY a.appointment_time DESC
    LIMIT 100
  `, params)

  ctx.result = {
    appointments
  }
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

  // 查询预约
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

  // 更新预约状态
  const now = new Date()
  await pg.query(
    `UPDATE appointments
     SET status = '已取消', cancelled_reason = $1, updated_at = $2
     WHERE appointment_id = $3`,
    [cancelledReason || '', now, appointmentId]
  )

  ctx.result = {
    appointmentId,
    status: '已取消',
    message: '预约已取消'
  }
}

/**
 * 生成预约 ID(UUID)
 */
function generateAppointmentId() {
  return 'apt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9)
}

module.exports = {
  create,
  list,
  cancel
}
