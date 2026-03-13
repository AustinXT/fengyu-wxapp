/**
 * 服务单模块路由
 * 顾客查询服务单状态(只读)
 */

const pg = require('../db/pg')

/**
 * 服务单详情
 * 查询服务单状态和明细
 */
async function detail(ctx) {
  const { userId } = ctx.auth
  const { serviceOrderId, serviceOrderNo } = ctx.event.payload || {}

  // 兼容旧参数名
  const id = serviceOrderId || serviceOrderNo
  if (!id) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderId 参数')
  }

  // 查询服务单主表
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

  // 查询服务明细（使用 sale_items 快照字段）
  const items = await pg.query(`
    SELECT
      si_svc.service_item_id,
      si_svc.sale_item_id,
      si_svc.session_used,
      si_svc.employee_id,
      si_svc.service_duration,
      si_svc.unit_real_price,
      si_sale.product_name,
      si_sale.sku_spec_name
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

module.exports = {
  detail
}
