/**
 * 预约模块路由（员工端）
 * appointment.list — 预约列表
 * appointment.detail — 预约详情
 * appointment.confirm — 确认预约
 * appointment.checkin — 顾客到店签到
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')
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

/**
 * 批量查询 WorkFine 顾客姓名（按手机号）
 */
async function batchLookupCustomerNames(phones) {
  if (!phones || phones.length === 0) return {}
  try {
    const esc = v => String(v).replace(/'/g, "''")
    const inClause = phones.map(p => `'${esc(p)}'`).join(',')
    const rows = await mssql.query(`
      SELECT UDF_S_1476 AS name, UDF_S_1478 AS phone
      FROM UDT_S_311
      WHERE UDF_S_1478 IN (${inClause})
    `)
    const map = {}
    for (const r of rows) {
      if (r.name && r.phone) map[r.phone.trim()] = r.name.trim()
    }
    return map
  } catch (_) {
    return {}
  }
}

// 预约状态映射：中文 → 英文（前端使用英文状态键）
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
 * 店长：查看本店所有预约
 * 美容师：查看预约美容师为自己的预约
 *
 * payload: {
 *   status: string | null,  // 筛选状态：'pending'|'confirmed'|null(全部)
 *   todayOnly: boolean,     // 仅今日预约
 *   page: number,
 *   pageSize: number
 * }
 *
 * 返回平铺数组，状态为英文键
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, todayOnly, page = 1, pageSize = 50 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.storeName, pageSize, offset]
  let whereExtra = ''

  if (status && status !== 'all') {
    // 将前端英文状态映射为中文
    const cnStatus = STATUS_EN_TO_CN[status] || status
    params.push(cnStatus)
    whereExtra += ` AND a.status = $${params.length}`
  }

  // 今日预约筛选
  if (todayOnly) {
    const today = new Date().toISOString().slice(0, 10)
    params.push(today)
    whereExtra += ` AND DATE(a.appointment_time) = $${params.length}::date`
  }

  // 美容师只看指定自己的预约
  if (ctx.auth.position !== '门店经理') {
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
      m.sku_display_name,
      wu.phone AS customer_phone
    FROM appointments a
    LEFT JOIN order_items oi ON a.item_flow_no = oi.item_flow_no
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    LEFT JOIN client_wechat_users wu ON a.client_user_id = wu.user_id
    WHERE a.store_name = $1
    ${whereExtra}
    ORDER BY a.appointment_time ASC
    LIMIT $2 OFFSET $3
  `, params)

  // 批量查询 WorkFine 顾客真实姓名
  const phones = [...new Set(appointments.map(a => a.customer_phone).filter(Boolean))]
  const phoneToName = await batchLookupCustomerNames(phones)

  ctx.result = appointments.map(a => ({
    id: a.appointment_id,
    customerName: phoneToName[a.customer_phone] || a.customer_name,
    customerPhone: a.customer_phone || '',
    clientUserId: a.client_user_id,
    staffName: a.staff_name,
    appointmentTime: formatDateTime(a.appointment_time),
    status: STATUS_CN_TO_EN[a.status] || a.status,
    statusText: a.status,
    serviceItemName: a.service_name || a.sku_display_name || '',
    remark: a.notes || '',
    checkinAt: a.checkin_at,
  }))
}

/**
 * 预约详情
 * 含关联的服务单信息
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
      a.customer_name,
      a.staff_wf_id,
      a.staff_name,
      a.appointment_time,
      a.notes,
      a.item_flow_no,
      a.checkin_at,
      COALESCE(p.name, '到店预约') AS service_name,
      m.sku_display_name,
      wu.phone AS customer_phone,
      so.service_order_no AS service_order_id
    FROM appointments a
    LEFT JOIN order_items oi ON a.item_flow_no = oi.item_flow_no
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    LEFT JOIN client_wechat_users wu ON a.client_user_id = wu.user_id
    LEFT JOIN service_orders so ON so.appointment_id = a.appointment_id
    WHERE a.appointment_id = $1 AND a.store_name = $2
  `, [id, ctx.auth.storeName])

  if (appointments.length === 0) {
    throw new Error('INVALID_PARAMS: 预约不存在或不属于本门店')
  }

  const a = appointments[0]

  // 查询 WorkFine 顾客真实姓名
  const phone = a.customer_phone || ''
  const phoneToName = await batchLookupCustomerNames(phone ? [phone] : [])

  ctx.result = {
    id: a.appointment_id,
    customerName: phoneToName[phone] || a.customer_name,
    customerPhone: phone,
    clientUserId: a.client_user_id,
    staffName: a.staff_name,
    appointmentTime: formatDateTime(a.appointment_time),
    status: STATUS_CN_TO_EN[a.status] || a.status,
    statusText: a.status,
    serviceItemName: a.service_name || a.sku_display_name || '',
    remark: a.notes || '',
    serviceOrderId: a.service_order_id || null,
    checkinAt: a.checkin_at,
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
  if (ctx.auth.position !== '门店经理' && appt.staff_wf_id !== ctx.auth.staffWfId) {
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

  if (ctx.auth.position !== '门店经理' && appt.staff_wf_id !== ctx.auth.staffWfId) {
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
