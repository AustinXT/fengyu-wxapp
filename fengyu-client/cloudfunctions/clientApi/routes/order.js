/**
 * 订单模块路由
 * 客户端订单相关接口
 */

const pg = require('../db/pg')
const mssql = require('../db/mssql')
const { requireFields } = require('../middleware/validate')
const { requirePhone } = require('../middleware/auth')

/**
 * 顾客自助下单
 * 创建订单 + 订单明细
 */
async function create(ctx) {
  // 必须绑定手机号
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload

  // 参数校验
  const {
    storeName,
    marketName,
    items, // [{ skuId, quantity }]
    preferredStaffWfId, // 可选,指定美容师
    paymentMethod // 'wechat' | 'offline'
  } = payload

  if (!storeName || !marketName || !items || !Array.isArray(items) || items.length === 0 || !paymentMethod) {
    throw new Error('INVALID_PARAMS: 参数不完整')
  }

  // 检查是否已有待支付订单(部分唯一索引约束)
  const existingOrders = await pg.query(
    "SELECT order_no FROM orders WHERE client_user_id = $1 AND status = '待支付'",
    [userId]
  )
  if (existingOrders.length > 0) {
    throw new Error('INVALID_PARAMS: 您已有待支付订单,请先完成支付或取消订单')
  }

  // 生成订单号
  const orderNo = await generateOrderNo()
  const now = new Date()

  // 查询 SKU 信息并从 WorkFine 读取价格
  const orderItems = []
  let totalAmount = 0

  for (const item of items) {
    const skuInfo = await getSkuInfo(item.skuId)
    const workfinePrice = await getWorkfinePrice(skuInfo.workfineItemId, skuInfo.workfineSource)

    const unitPrice = workfinePrice.originalPrice
    const quantity = item.quantity || 1
    const saleAmount = unitPrice * quantity
    totalAmount += saleAmount

    const itemFlowNo = await generateItemFlowNo()

    orderItems.push({
      itemFlowNo,
      skuId: item.skuId,
      sessionCount: workfinePrice.sessionCount,
      remainingSessions: workfinePrice.sessionCount,
      unitPrice,
      quantity,
      unitDiscount: 0,
      saleAmount,
      receivable: saleAmount,
      received: 0,
      productType: skuInfo.productType
    })
  }

  // 使用事务创建订单
  await pg.transaction(async (client) => {
    // 创建订单主表
    await client.query(
      `INSERT INTO orders (
        order_no, status, order_type, market_name, store_name,
        order_datetime, client_user_id, payment_method, order_source,
        preferred_staff_wf_id, created_at, updated_at
      ) VALUES ($1, '待支付', '正式', $2, $3, $4, $5, $6, 'client', $7, $4, $4)`,
      [orderNo, marketName, storeName, now, userId, paymentMethod, preferredStaffWfId || null]
    )

    // 创建订单明细
    for (const orderItem of orderItems) {
      await client.query(
        `INSERT INTO order_items (
          item_flow_no, order_no, sku_id, session_count, remaining_sessions,
          unit_price, quantity, unit_discount, sale_amount, receivable, received
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          orderItem.itemFlowNo, orderNo, orderItem.skuId, orderItem.sessionCount,
          orderItem.remainingSessions, orderItem.unitPrice, orderItem.quantity,
          orderItem.unitDiscount, orderItem.saleAmount, orderItem.receivable, orderItem.received
        ]
      )
    }
  })

  ctx.result = {
    orderNo,
    totalAmount,
    status: '待支付'
  }
}

/**
 * 发起微信支付
 * 返回预支付参数(实际支付由 payNotify 云函数处理)
 */
async function pay(ctx) {
  const { userId } = ctx.auth
  const { orderNo } = ctx.event.payload || {}

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo 参数')
  }

  // 查询订单
  const orders = await pg.query(
    'SELECT * FROM orders WHERE order_no = $1 AND client_user_id = $2',
    [orderNo, userId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许支付')
  }

  if (order.payment_method !== 'wechat') {
    throw new Error('INVALID_PARAMS: 该订单不是微信支付方式')
  }

  // 计算总金额
  const items = await pg.query(
    'SELECT SUM(receivable) AS total FROM order_items WHERE order_no = $1',
    [orderNo]
  )
  const totalAmount = items[0].total || 0

  // TODO: 调用微信支付统一下单接口,生成预支付参数
  // 这里返回模拟数据,实际需要对接微信支付
  ctx.result = {
    orderNo,
    totalAmount,
    paymentParams: {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: Math.random().toString(36).substr(2),
      package: `prepay_id=wx${Date.now()}`,
      signType: 'MD5',
      paySign: 'mock_sign'
    }
  }
}

/**
 * 选择线下付款
 * 订单进入"待确认收款"状态
 */
async function offlinePay(ctx) {
  const { userId } = ctx.auth
  const { orderNo } = ctx.event.payload || {}

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo 参数')
  }

  // 查询订单
  const orders = await pg.query(
    'SELECT * FROM orders WHERE order_no = $1 AND client_user_id = $2',
    [orderNo, userId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许付款')
  }

  if (order.payment_method !== 'offline') {
    throw new Error('INVALID_PARAMS: 该订单不是线下付款方式')
  }

  // 更新订单状态
  const now = new Date()
  await pg.query(
    "UPDATE orders SET status = '待确认收款', updated_at = $1 WHERE order_no = $2",
    [now, orderNo]
  )

  ctx.result = {
    orderNo,
    status: '待确认收款',
    message: '已提交,等待店长确认收款'
  }
}

/**
 * 订单列表
 * 包含体验单
 */
async function list(ctx) {
  const { userId } = ctx.auth
  const { status } = ctx.event.payload || {}

  // 构造查询条件
  let whereClause = 'WHERE client_user_id = $1'
  const params = [userId]

  if (status) {
    params.push(status)
    whereClause += ` AND status = $${params.length}`
  }

  const orders = await pg.query(`
    SELECT
      order_no,
      status,
      order_type,
      market_name,
      store_name,
      order_datetime,
      payment_method,
      preferred_staff_wf_id,
      created_at
    FROM orders
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT 100
  `, params)

  ctx.result = {
    orders
  }
}

/**
 * 订单详情
 * 包含明细 + 剩余次数
 */
async function detail(ctx) {
  const { userId } = ctx.auth
  const { orderNo } = ctx.event.payload || {}

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 orderNo 参数')
  }

  // 查询订单主表
  const orders = await pg.query(
    'SELECT * FROM orders WHERE order_no = $1 AND client_user_id = $2',
    [orderNo, userId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 查询订单明细
  const items = await pg.query(`
    SELECT
      oi.item_flow_no,
      oi.sku_id,
      oi.session_count,
      oi.remaining_sessions,
      oi.unit_price,
      oi.quantity,
      oi.sale_amount,
      oi.receivable,
      oi.received,
      oi.expire_date,
      p.name AS spu_name,
      m.sku_display_name,
      m.product_type
    FROM order_items oi
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE oi.order_no = $1
    ORDER BY oi.item_flow_no
  `, [orderNo])

  ctx.result = {
    order,
    items
  }
}

/**
 * 获取可预约项目列表
 * 查询已支付订单中有剩余次数的项目(疗程卡/单品)
 * 性能优化:一次查询获取所有可预约项目,无需 order.list + order.detail 组合
 */
async function appointableItems(ctx) {
  const { userId } = ctx.auth

  // 查询已支付订单中有剩余次数的项目
  const items = await pg.query(`
    SELECT
      o.order_no,
      o.status AS order_status,
      o.store_name,
      o.market_name,
      o.preferred_staff_wf_id,
      oi.item_flow_no,
      oi.sku_id,
      oi.session_count,
      oi.remaining_sessions,
      oi.unit_price,
      oi.sale_amount,
      oi.expire_date,
      p.spu_id,
      p.name AS spu_name,
      p.category,
      p.big_category,
      m.sku_display_name,
      m.product_type,
      m.workfine_item_id,
      m.workfine_source
    FROM orders o
    INNER JOIN order_items oi ON o.order_no = oi.order_no
    LEFT JOIN product_spu_sku_map m ON oi.sku_id = m.sku_id
    LEFT JOIN product_spu p ON m.spu_id = p.spu_id
    WHERE o.client_user_id = $1
      AND o.status = '已支付'
      AND oi.remaining_sessions > 0
      AND (oi.expire_date IS NULL OR oi.expire_date > CURRENT_DATE)
      AND m.product_type IN ('疗程卡', '单品')
    ORDER BY o.paid_at DESC, oi.item_flow_no
  `, [userId])

  // 按订单号分组
  const orderMap = new Map()
  for (const item of items) {
    if (!orderMap.has(item.order_no)) {
      orderMap.set(item.order_no, {
        orderNo: item.order_no,
        orderStatus: item.order_status,
        storeName: item.store_name,
        marketName: item.market_name,
        preferredStaffWfId: item.preferred_staff_wf_id,
        items: []
      })
    }
    orderMap.get(item.order_no).items.push({
      itemFlowNo: item.item_flow_no,
      skuId: item.sku_id,
      spuId: item.spu_id,
      spuName: item.spu_name,
      category: item.category,
      bigCategory: item.big_category,
      skuDisplayName: item.sku_display_name,
      productType: item.product_type,
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      unitPrice: item.unit_price,
      saleAmount: item.sale_amount,
      expireDate: item.expire_date,
      workfineItemId: item.workfine_item_id,
      workfineSource: item.workfine_source
    })
  }

  ctx.result = {
    orders: Array.from(orderMap.values())
  }
}

// ========== 辅助函数 ==========

/**
 * 生成订单号
 * 格式: FY-XSD-WX-{YYMMDD}{序号}
 */
async function generateOrderNo() {
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')

  // 查询今日最大序号
  const result = await pg.query(`
    SELECT order_no FROM orders
    WHERE order_no LIKE 'FY-XSD-WX-${dateStr}%'
    ORDER BY order_no DESC
    LIMIT 1
  `)

  let seq = 1
  if (result.length > 0) {
    const lastNo = result[0].order_no
    seq = parseInt(lastNo.slice(-4)) + 1
  }

  return `FY-XSD-WX-${dateStr}${String(seq).padStart(4, '0')}`
}

/**
 * 生成销售流水号
 * 格式: XSLSH-WX-{YYYYMMDD}{序号}
 */
async function generateItemFlowNo() {
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')

  // 查询今日最大序号
  const result = await pg.query(`
    SELECT item_flow_no FROM order_items
    WHERE item_flow_no LIKE 'XSLSH-WX-${dateStr}%'
    ORDER BY item_flow_no DESC
    LIMIT 1
  `)

  let seq = 1
  if (result.length > 0) {
    const lastNo = result[0].item_flow_no
    seq = parseInt(lastNo.slice(-4)) + 1
  }

  return `XSLSH-WX-${dateStr}${String(seq).padStart(4, '0')}`
}

/**
 * 获取 SKU 信息
 */
async function getSkuInfo(skuId) {
  const result = await pg.query(
    'SELECT sku_id, workfine_item_id, workfine_source, product_type FROM product_spu_sku_map WHERE sku_id = $1',
    [skuId]
  )

  if (result.length === 0) {
    throw new Error(`INVALID_PARAMS: SKU ${skuId} 不存在`)
  }

  return result[0]
}

/**
 * 从 WorkFine 读取价格信息
 */
async function getWorkfinePrice(workfineItemId, workfineSource) {
  let sql = ''

  if (workfineSource === 'UDT_M_1281') {
    sql = `
      SELECT
        UDF_M_14508 AS original_price,
        UDF_M_14506 AS session_count
      FROM UDT_M_1281
      WHERE UDF_M_14503 = '${workfineItemId}'
    `
  } else if (workfineSource === 'UDT_M_1383') {
    sql = `
      SELECT
        UDF_M_14508 AS original_price,
        UDF_M_14506 AS session_count
      FROM UDT_M_1383
      WHERE UDF_M_14503 = '${workfineItemId}'
    `
  } else if (workfineSource === 'UDT_M_341') {
    sql = `
      SELECT
        UDF_M_1875 AS original_price,
        NULL AS session_count
      FROM UDT_M_341
      WHERE UDF_M_1870 = '${workfineItemId}'
    `
  }

  const result = await mssql.query(sql)

  if (result.length === 0) {
    throw new Error(`INVALID_PARAMS: WorkFine 项目 ${workfineItemId} 不存在`)
  }

  return {
    originalPrice: result[0].original_price,
    sessionCount: result[0].session_count
  }
}

module.exports = {
  create,
  pay,
  offlinePay,
  list,
  detail,
  appointableItems
}
