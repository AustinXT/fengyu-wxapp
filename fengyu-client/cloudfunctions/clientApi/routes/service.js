

const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { loadServiceItems, finalizeServiceOrder } = require('../utils/service-finalize')
const { checkText } = require('../utils/wx-sec-check')

const MAX_COMMENT_LENGTH = 500


async function detail(ctx) {
  const { userId } = ctx.auth
  const { serviceOrderId, serviceOrderNo } = ctx.event.payload || {}

  
  const id = serviceOrderId || serviceOrderNo
  if (!id) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId 参数')
  }

  
  const serviceOrders = await pg.query(`
    SELECT
      so.service_order_id,
      so.status,
      so.service_order_type,
      so.market_name,
      so.store_id,
      s.store_name,
      so.service_date,
      so.assigned_employee_id,
      so.remark,
      so.appointment_id,
      so.started_at,
      so.completed_at,
      so.created_at,
      so.updated_at
    FROM service_orders so
    LEFT JOIN stores s ON so.store_id = s.store_id
    WHERE so.service_order_id = $1 AND so.client_user_id = $2
  `, [id, userId])

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在')
  }

  const serviceOrder = serviceOrders[0]

  
  const items = await pg.query(`
    SELECT
      si_svc.service_item_id,
      si_svc.sale_item_id,
      si_svc.session_used,
      si_svc.employee_id,
      si_svc.service_duration,
      si_svc.unit_real_price,
      si_sale.product_name
    FROM service_items si_svc
    LEFT JOIN sale_items si_sale ON si_svc.sale_item_id = si_sale.sale_item_id
    WHERE si_svc.service_order_id = $1
    ORDER BY si_svc.service_item_id
  `, [id])

  ctx.result = {
    serviceOrder,
    items
  }
}


async function list(ctx) {
  const { userId } = ctx.auth
  const { page = 1, pageSize = 20 } = ctx.event.payload || {}

  const offset = (page - 1) * pageSize

  const records = await pg.query(`
    SELECT
      so.service_order_id,
      so.status,
      so.service_date,
      so.store_id,
      s.store_name,
      so.assigned_employee_id,
      sw.name AS employee_name,
      so.started_at,
      so.completed_at,
      so.created_at,
      sr.rating AS review_rating,
      sr.comment AS review_comment,
      (sr.service_order_id IS NOT NULL) AS reviewed
    FROM service_orders so
    LEFT JOIN stores s ON so.store_id = s.store_id
    LEFT JOIN staff_wechat_users sw ON so.assigned_employee_id = sw.employee_id
    LEFT JOIN service_reviews sr ON so.service_order_id = sr.service_order_id
    WHERE so.client_user_id = $1
    ORDER BY so.created_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, pageSize, offset])

  
  if (records.length > 0) {
    const orderIds = records.map(r => r.service_order_id)
    const items = await pg.query(`
      SELECT
        si.service_order_id,
        si.service_item_id,
        si.session_used,
        si.service_duration,
        si.unit_real_price,
        sal.product_name
      FROM service_items si
      LEFT JOIN sale_items sal ON si.sale_item_id = sal.sale_item_id
      WHERE si.service_order_id = ANY($1)
      ORDER BY si.service_item_id
    `, [orderIds])

    const itemMap = {}
    for (const item of items) {
      if (!itemMap[item.service_order_id]) itemMap[item.service_order_id] = []
      itemMap[item.service_order_id].push(item)
    }

    for (const record of records) {
      record.items = itemMap[record.service_order_id] || []
    }
  }

  ctx.result = { records }
}


async function createReview(ctx) {
  
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const { serviceOrderId, rating, comment } = ctx.event.payload || {}

  if (!serviceOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId 参数')
  }

  
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('INVALID_PARAMS: 评分必须为 1-5 的整数')
  }

  
  let normalizedComment = null
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== 'string') {
      throw new Error('INVALID_PARAMS: 评价内容格式不正确')
    }
    const trimmed = comment.trim()
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new Error(`INVALID_PARAMS: 评价内容不能超过 ${MAX_COMMENT_LENGTH} 字`)
    }
    normalizedComment = trimmed || null
  }

  
  const orders = await pg.query(
    `SELECT service_order_id, status, client_user_id, assigned_employee_id
     FROM service_orders
     WHERE service_order_id = $1`,
    [serviceOrderId]
  )

  if (orders.length === 0 || orders[0].client_user_id !== userId) {
    throw new Error('PERMISSION_DENIED: 无权评价该服务单')
  }

  const order = orders[0]
  if (order.status !== '已完成') {
    throw new Error('INVALID_STATE: 服务未完成不可评价')
  }

  
  await checkText(normalizedComment, { scene: 2 })

  try {
    await pg.query(
      `INSERT INTO service_reviews (service_order_id, employee_id, client_user_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)`,
      [serviceOrderId, order.assigned_employee_id, userId, rating, normalizedComment]
    )
  } catch (err) {
    
    if (err.code === '23505' || err.cause?.code === '23505') {
      throw new Error('CONFLICT: 该服务已评价过')
    }
    throw err
  }

  ctx.result = { serviceOrderId, rating, comment: normalizedComment }
}


async function confirm(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const { serviceOrderId, serviceOrderNo } = ctx.event.payload || {}
  const id = serviceOrderId || serviceOrderNo
  if (!id) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId 参数')
  }

  const orders = await pg.query(
    `SELECT * FROM service_orders WHERE service_order_id = $1`,
    [id]
  )

  if (orders.length === 0 || orders[0].client_user_id !== userId) {
    throw new Error('PERMISSION_DENIED: 无权确认该服务单')
  }

  const so = orders[0]

  
  if (so.status === '已完成') {
    ctx.result = { serviceOrderId: id, status: '已完成', message: '服务已完成（幂等）' }
    return
  }

  if (so.status !== '待客户确认') {
    throw new Error('INVALID_STATE: 服务单当前状态不可确认')
  }

  
  const pendRefund = await pg.query(
    `SELECT 1 FROM service_items sit
       JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
       JOIN sale_order_payments sop ON sop.sale_order_id = si.sale_order_id
      WHERE sit.service_order_id = $1 AND sop.change_type = '退款' AND sop.status = '待审批' LIMIT 1`,
    [id]
  )
  if (pendRefund.length > 0) {
    throw new Error('INVALID_STATE: 关联订单退款审批中，暂不可确认')
  }

  const items = await loadServiceItems(id)
  const now = new Date()

  let finalized = false
  await pg.transaction(async (client) => {
    finalized = await finalizeServiceOrder(client, so, items, now)
  })

  ctx.result = {
    serviceOrderId: id,
    status: '已完成',
    message: finalized ? '服务已确认完成' : '服务已完成（幂等）'
  }
}

module.exports = {
  detail,
  list,
  confirm,
  createReview
}
