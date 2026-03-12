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
  const { serviceOrderNo } = ctx.event.payload || {}

  if (!serviceOrderNo) {
    throw new Error('INVALID_PARAMS: 缺少 serviceOrderNo 参数')
  }

  // 查询服务单主表
  const serviceOrders = await pg.query(`
    SELECT
      service_order_no,
      status,
      market_name,
      store_name,
      service_date,
      service_duration,
      assigned_employee_id,
      remark,
      created_at,
      updated_at
    FROM service_orders
    WHERE service_order_no = $1 AND client_user_id = $2
  `, [serviceOrderNo, userId])

  if (serviceOrders.length === 0) {
    throw new Error('INVALID_PARAMS: 服务单不存在')
  }

  const serviceOrder = serviceOrders[0]

  // 查询服务明细
  const items = await pg.query(`
    SELECT
      si.service_item_id,
      si.item_flow_no,
      si.session_used,
      si.employee_id,
      p.name AS spu_name,
      m.sku_display_name
    FROM service_items si
    LEFT JOIN order_items oi ON si.item_flow_no = oi.item_flow_no
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE si.service_order_no = $1
    ORDER BY si.service_item_id
  `, [serviceOrderNo])

  ctx.result = {
    serviceOrder,
    items
  }
}

module.exports = {
  detail
}
