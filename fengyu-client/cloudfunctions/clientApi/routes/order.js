/**
 * 订单模块路由
 * 客户端订单相关接口
 */

const pg = require('../db/pg')
const { requireFields } = require('../middleware/validate')
const { requirePhone } = require('../middleware/auth')

/**
 * 扫码查看订单详情（员工开单订单专用）
 * 不要求 client_user_id 匹配，仅限 sale_order_source = 'staff' 的订单
 */
async function scanDetail(ctx) {
  const { orderNo, saleOrderId } = ctx.event.payload || {}
  const targetOrderId = saleOrderId || orderNo
  if (!targetOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    `SELECT o.*, s.store_name
     FROM sale_orders o
     LEFT JOIN stores s ON o.store_id = s.store_id
     WHERE o.sale_order_id = $1 AND o.sale_order_source = 'staff'`,
    [targetOrderId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 非待支付状态返回提示
  if (order.status !== '待支付') {
    const statusMsgMap = {
      '已支付': '该订单已完成支付',
      '已完成': '该订单已完成',
      '待确认收款': '该订单正在等待店长确认收款',
      '已关闭': '该订单已关闭',
      '支付失败': '该订单支付失败，请联系店员'
    }
    ctx.result = {
      orderNo: order.sale_order_id,
      status: order.status,
      statusMsg: statusMsgMap[order.status] || `订单状态为「${order.status}」`
    }
    return
  }

  // 查询商品明细（使用 sale_items 快照字段）
  const items = await pg.query(`
    SELECT
      si.sale_item_id, si.unit_price, si.quantity, si.received,
      si.product_name, si.sku_spec_name
    FROM sale_items si
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [targetOrderId])

  ctx.result = {
    order: {
      orderNo: order.sale_order_id,
      status: order.status,
      storeId: order.store_id,
      storeName: order.store_name || '',
      orderType: order.sale_order_type,
      totalAmount: order.total_amount
    },
    items: items.map(i => ({
      saleItemId: i.sale_item_id,
      productName: i.product_name,
      skuSpecName: i.sku_spec_name,
      unitPrice: i.unit_price,
      quantity: i.quantity,
      received: i.received
    }))
  }
}

/**
 * 顾客自助下单
 * 创建订单 + 订单明细
 */
async function create(ctx) {
  // 必须绑定手机号
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload

  const {
    storeId,
    items, // [{ skuId, quantity }]
    preferredStaffWfId, // 可选,指定美容师
    paymentMethod, // 'wechat' | 'offline'
    orderType: orderTypeParam, // 可选, 'promo' | undefined
    couponId: inputCouponId // 可选, 优惠券ID
  } = payload

  if (!storeId || !items || !Array.isArray(items) || items.length === 0 || !paymentMethod) {
    throw new Error('INVALID_PARAMS: 参数不完整')
  }

  // 查询门店信息（获取 market_name 快照）
  const storeRows = await pg.query(
    `SELECT s.store_id, s.store_name, pm.name AS market_name
     FROM stores s
     LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
     LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
     WHERE s.store_id = $1`,
    [storeId]
  )
  if (storeRows.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在')
  }
  const marketName = storeRows[0].market_name || ''

  // 先清理过期的待支付订单（10分钟超时）
  await pg.query(
    `UPDATE sale_orders SET status = '已关闭', updated_at = NOW()
     WHERE client_user_id = $1 AND status = '待支付'
     AND sale_order_datetime < NOW() - INTERVAL '10 minutes'`,
    [userId]
  )

  // 检查是否已有待支付订单(部分唯一索引约束)
  const existingOrders = await pg.query(
    "SELECT sale_order_id FROM sale_orders WHERE client_user_id = $1 AND status = '待支付'",
    [userId]
  )
  if (existingOrders.length > 0) {
    const err = new Error('INVALID_PARAMS: 您已有待支付订单，请先完成支付或取消订单')
    err.data = { pendingOrderNo: existingOrders[0].sale_order_id }
    throw err
  }

  const now = new Date()

  // 查询 SKU 信息（价格/次数直接从 PG product_skus 读取）
  const skuIds = items.map(i => i.skuId)
  const skuResults = await pg.query(`
    SELECT
      sk.sku_id, sk.product_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      p.name AS product_name, p.sales_category
    FROM product_skus sk
    JOIN products p ON sk.product_id = p.product_id
    WHERE sk.sku_id = ANY($1)
  `, [skuIds])

  // 构建 SKU 映射
  const skuMap = {}
  for (const sku of skuResults) {
    skuMap[sku.sku_id] = sku
  }

  // 验证所有 SKU 存在
  for (const item of items) {
    if (!skuMap[item.skuId]) {
      throw new Error(`INVALID_PARAMS: SKU ${item.skuId} 不存在`)
    }
  }

  // 预计算明细数据
  let totalAmount = 0
  const itemsData = items.map(item => {
    const sku = skuMap[item.skuId]
    const unitPrice = Number(sku.price)
    const unitRealPrice = Number(sku.special_price || sku.price)
    const quantity = item.quantity || 1
    const saleAmount = unitRealPrice * quantity
    totalAmount += saleAmount
    return {
      skuId: item.skuId,
      productName: sku.product_name,
      skuSpecName: sku.spec_name,
      productType: sku.product_type,
      sessionCount: sku.session_count,
      remainingSessions: sku.session_count,
      unitPrice,
      unitRealPrice,
      quantity,
      saleAmount,
      received: saleAmount,
      salesCategory: sku.sales_category || null
    }
  })

  // ========== 优惠券处理 ==========
  let couponDiscount = 0
  let couponInfo = null
  if (inputCouponId) {
    // 验证券有效性
    const couponRows = await pg.query(
      `SELECT uc.coupon_id, uc.user_id, uc.expire_at,
              ct.coupon_type, ct.discount_value, ct.min_spend,
              ct.applicable_category_ids, ct.applicable_store_ids
       FROM user_coupons uc
       JOIN coupon_templates ct ON uc.template_id = ct.template_id
       WHERE uc.coupon_id = $1 AND uc.user_id = $2
         AND uc.status = '未使用' AND uc.expire_at > NOW()
         AND ct.is_active = true`,
      [inputCouponId, userId]
    )
    if (couponRows.length === 0) {
      throw new Error('INVALID_PARAMS: 优惠券已失效')
    }
    couponInfo = couponRows[0]

    // 门店匹配
    if (couponInfo.applicable_store_ids && couponInfo.applicable_store_ids.length > 0) {
      if (!couponInfo.applicable_store_ids.includes(storeId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此门店')
      }
    }

    // 品项分类匹配
    const skuCats = await pg.query(
      `SELECT ps.sku_id, p.category_id
       FROM product_skus ps JOIN products p ON ps.product_id = p.product_id
       WHERE ps.sku_id = ANY($1)`,
      [skuIds]
    )
    const catMap = new Map()
    for (const r of skuCats) catMap.set(r.sku_id, r.category_id)

    let eligibleItems
    if (couponInfo.applicable_category_ids && couponInfo.applicable_category_ids.length > 0) {
      eligibleItems = itemsData.filter(d =>
        couponInfo.applicable_category_ids.includes(catMap.get(d.skuId))
      )
    } else {
      eligibleItems = itemsData
    }
    if (eligibleItems.length === 0) {
      throw new Error('INVALID_PARAMS: 该优惠券不适用于当前商品')
    }

    const eligibleTotal = eligibleItems.reduce((s, d) => s + d.saleAmount, 0)
    const minSpend = Number(couponInfo.min_spend) || 0
    if (eligibleTotal < minSpend) {
      throw new Error(`INVALID_PARAMS: 未满足使用条件（满${minSpend}可用）`)
    }

    // 计算抵扣金额
    if (couponInfo.coupon_type === '现金券' || couponInfo.coupon_type === '项目券') {
      couponDiscount = Math.min(Number(couponInfo.discount_value), eligibleTotal)
    }
    couponDiscount = Math.round(couponDiscount * 100) / 100

    // 按比例分摊到各行的 received
    for (const item of eligibleItems) {
      const share = couponDiscount * (item.saleAmount / eligibleTotal)
      const roundedShare = Math.round(share * 100) / 100
      item.received -= roundedShare
      item.received = Math.round(item.received * 100) / 100
    }

    totalAmount = itemsData.reduce((s, d) => s + d.received, 0)
    totalAmount = Math.round(totalAmount * 100) / 100
  }

  // 从 PG 查询顾客姓名
  let customerName = null
  if (ctx.auth.phone) {
    const nameRows = await pg.query(
      'SELECT name FROM client_wechat_users WHERE user_id = $1',
      [userId]
    )
    if (nameRows.length > 0 && nameRows[0].name) {
      customerName = nameRows[0].name
    }
  }

  // 使用事务创建订单（订单号+流水号在事务内原子生成）
  let orderNo
  await pg.transaction(async (client) => {
    // 获取 advisory lock 防止并发生成重复序号
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    // 生成订单号（在事务+锁内，防并发重复）
    const dateStrOrder = now.toISOString().slice(2, 10).replace(/-/g, '')
    const orderSeqResult = await client.query(
      `SELECT sale_order_id FROM sale_orders
       WHERE sale_order_id LIKE $1
       ORDER BY sale_order_id DESC LIMIT 1`,
      [`FY-XSD-WX-${dateStrOrder}%`]
    )
    let orderSeq = 1
    if (orderSeqResult.rows.length > 0) {
      orderSeq = parseInt(orderSeqResult.rows[0].sale_order_id.slice(-4)) + 1
    }
    orderNo = `FY-XSD-WX-${dateStrOrder}${String(orderSeq).padStart(4, '0')}`

    // 在事务内查询今日最大序号
    const today = new Date()
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')
    const maxResult = await client.query(
      `SELECT sale_item_id FROM sale_items
       WHERE sale_item_id LIKE $1
       ORDER BY sale_item_id DESC
       LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )

    let seq = 1
    if (maxResult.rows.length > 0) {
      seq = parseInt(maxResult.rows[0].sale_item_id.slice(-4)) + 1
    }

    // 确定订单类型
    const saleOrderType = orderTypeParam === 'promo' ? '福利活动' : '普通'

    // 原子 claim 优惠券（在事务内防并发重用）
    if (inputCouponId) {
      const claimResult = await client.query(
        `UPDATE user_coupons
         SET status = '已使用', used_sale_order_id = $1, used_at = NOW()
         WHERE coupon_id = $2 AND user_id = $3
           AND status = '未使用' AND expire_at > NOW()`,
        [orderNo, inputCouponId, userId]
      )
      if (claimResult.rowCount !== 1) {
        throw new Error('INVALID_PARAMS: 优惠券已失效')
      }
    }

    // 创建订单主表
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, market_name, store_id,
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, payment_method, sale_order_source,
        preferred_employee_id, coupon_id, coupon_discount,
        created_at, updated_at
      ) VALUES ($1, '待支付', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'client', $11, $12, $13, $5, $5)`,
      [orderNo, saleOrderType, marketName, storeId, now, userId, ctx.auth.phone || null, customerName, totalAmount, paymentMethod, preferredStaffWfId || null, inputCouponId || null, couponDiscount]
    )

    // 创建订单明细（流水号递增）
    for (let i = 0; i < itemsData.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemsData[i]
      await client.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, sku_id,
          product_name, sku_spec_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price,
          sale_amount, received, sales_category
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          saleItemId, orderNo, d.skuId,
          d.productName, d.skuSpecName, d.productType,
          d.sessionCount, d.remainingSessions,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount, d.received, d.salesCategory || null
        ]
      )
    }
  })

  ctx.result = {
    orderNo,
    saleOrderId: orderNo,
    totalAmount,
    status: '待支付'
  }
}

/**
 * 发起微信支付
 */
async function pay(ctx) {
  const { userId } = ctx.auth
  const payload = ctx.event.payload || {}
  const orderNo = payload.saleOrderId || payload.orderNo

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1',
    [orderNo]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 权限：已绑定用户 → 校验一致；未绑定 → 仅允许员工开单订单
  if (order.client_user_id) {
    if (order.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
  } else if (order.sale_order_source !== 'staff') {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许支付')
  }

  // 10分钟超时检查
  const orderTime = new Date(order.sale_order_datetime)
  if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
    await pg.query(
      "UPDATE sale_orders SET status = '已关闭', updated_at = NOW() WHERE sale_order_id = $1",
      [orderNo]
    )
    throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
  }

  const now = new Date()

  // 自动绑定 client_user_id（仅 staff 来源且未绑定时）
  if (!order.client_user_id && order.sale_order_source === 'staff') {
    await pg.query(
      'UPDATE sale_orders SET client_user_id = $1, payment_method = $2, updated_at = $3 WHERE sale_order_id = $4',
      [userId, 'wechat', now, orderNo]
    )
  } else {
    await pg.query(
      "UPDATE sale_orders SET payment_method = 'wechat', updated_at = $1 WHERE sale_order_id = $2",
      [now, orderNo]
    )
  }

  const totalAmount = order.total_amount

  // TODO: 接入真实微信支付统一下单接口
  ctx.result = {
    orderNo,
    totalAmount,
    paymentMethod: 'wechat',
    mockMode: true,
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
 */
async function offlinePay(ctx) {
  const { userId } = ctx.auth
  const payloadOff = ctx.event.payload || {}
  const orderNo = payloadOff.saleOrderId || payloadOff.orderNo

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1',
    [orderNo]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  if (order.client_user_id) {
    if (order.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
  } else if (order.sale_order_source !== 'staff') {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许付款')
  }

  // 10分钟超时检查
  const orderTimeOffline = new Date(order.sale_order_datetime)
  if (Date.now() - orderTimeOffline.getTime() > 10 * 60 * 1000) {
    await pg.query(
      "UPDATE sale_orders SET status = '已关闭', updated_at = NOW() WHERE sale_order_id = $1",
      [orderNo]
    )
    throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
  }

  const now = new Date()
  await pg.query(
    "UPDATE sale_orders SET status = '待确认收款', client_user_id = COALESCE(client_user_id, $1), payment_method = 'offline', updated_at = $2 WHERE sale_order_id = $3",
    [userId, now, orderNo]
  )

  ctx.result = {
    orderNo,
    status: '待确认收款',
    message: '已提交,等待店长确认收款'
  }
}

/**
 * 订单列表
 */
async function list(ctx) {
  const { userId } = ctx.auth
  const { status } = ctx.event.payload || {}

  // 懒清理过期的待支付订单
  await pg.query(
    `UPDATE sale_orders SET status = '已关闭', updated_at = NOW()
     WHERE client_user_id = $1 AND status = '待支付'
     AND sale_order_datetime < NOW() - INTERVAL '10 minutes'`,
    [userId]
  )

  let whereClause = 'WHERE o.client_user_id = $1'
  const params = [userId]

  if (status) {
    params.push(status)
    whereClause += ` AND o.status = $${params.length}`
  }

  const orders = await pg.query(`
    SELECT
      o.sale_order_id,
      o.status,
      o.sale_order_type,
      o.market_name,
      o.store_id,
      s.store_name,
      o.sale_order_datetime,
      o.payment_method,
      o.preferred_employee_id,
      o.total_amount,
      o.created_at
    FROM sale_orders o
    LEFT JOIN stores s ON o.store_id = s.store_id
    ${whereClause}
    ORDER BY o.created_at DESC
    LIMIT 100
  `, params)

  // 批量查询所有订单的明细项（使用快照字段）
  if (orders.length > 0) {
    const orderIds = orders.map(o => o.sale_order_id)
    const items = await pg.query(`
      SELECT
        si.sale_order_id,
        si.sale_item_id,
        si.quantity,
        si.remaining_sessions,
        si.product_name,
        si.sku_spec_name,
        si.product_type
      FROM sale_items si
      WHERE si.sale_order_id = ANY($1)
      ORDER BY si.sale_item_id
    `, [orderIds])

    const itemsMap = new Map()
    for (const item of items) {
      if (!itemsMap.has(item.sale_order_id)) {
        itemsMap.set(item.sale_order_id, [])
      }
      itemsMap.get(item.sale_order_id).push(item)
    }

    for (const order of orders) {
      order.items = itemsMap.get(order.sale_order_id) || []
    }
  }

  ctx.result = { orders }
}

/**
 * 订单详情
 */
async function detail(ctx) {
  const { userId } = ctx.auth
  const payloadDtl = ctx.event.payload || {}
  const orderNo = payloadDtl.saleOrderId || payloadDtl.orderNo

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    `SELECT o.*, s.store_name
     FROM sale_orders o
     LEFT JOIN stores s ON o.store_id = s.store_id
     WHERE o.sale_order_id = $1 AND o.client_user_id = $2`,
    [orderNo, userId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 查询订单明细（使用快照字段）
  const items = await pg.query(`
    SELECT
      si.sale_item_id,
      si.sku_id,
      si.product_name,
      si.sku_spec_name,
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.unit_price,
      si.unit_real_price,
      si.quantity,
      si.sale_amount,
      si.received,
      si.expire_date
    FROM sale_items si
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [orderNo])

  // 待支付订单返回过期时间
  let expireAt = null
  if (order.status === '待支付') {
    expireAt = new Date(new Date(order.sale_order_datetime).getTime() + 10 * 60 * 1000).toISOString()
  }

  // 查询指定美容师姓名（从 PG staff_wechat_users）
  let preferredStaffName = null
  if (order.preferred_employee_id) {
    const staffRows = await pg.query(
      'SELECT name FROM staff_wechat_users WHERE employee_id = $1',
      [order.preferred_employee_id]
    )
    if (staffRows.length > 0) {
      preferredStaffName = staffRows[0].name
    }
  }

  // 查询券名称
  let couponName = null
  if (order.coupon_id) {
    const couponRows = await pg.query(
      `SELECT ct.name FROM user_coupons uc
       JOIN coupon_templates ct ON uc.template_id = ct.template_id
       WHERE uc.coupon_id = $1`,
      [order.coupon_id]
    )
    if (couponRows.length > 0) couponName = couponRows[0].name
  }

  ctx.result = {
    order: {
      ...order,
      expire_at: expireAt,
      preferred_staff_name: preferredStaffName,
      coupon_name: couponName,
    },
    items
  }
}

/**
 * 取消订单
 */
async function cancel(ctx) {
  const { userId } = ctx.auth
  const payloadCnl = ctx.event.payload || {}
  const orderNo = payloadCnl.saleOrderId || payloadCnl.orderNo

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1 AND client_user_id = $2',
    [orderNo, userId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 当前订单状态不允许取消')
  }

  const now = new Date()
  await pg.transaction(async (client) => {
    await client.query(
      "UPDATE sale_orders SET status = '已关闭', updated_at = $1 WHERE sale_order_id = $2",
      [now, orderNo]
    )
    // 释放关联的优惠券
    await client.query(
      `UPDATE user_coupons
       SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
       WHERE used_sale_order_id = $1`,
      [orderNo]
    )
  })

  ctx.result = {
    orderNo,
    status: '已关闭',
    message: '订单已取消'
  }
}

/**
 * 获取可预约项目列表
 * 查询已支付订单中有剩余次数的项目(疗程卡/单品)
 */
async function appointableItems(ctx) {
  const { userId } = ctx.auth
  const { includeInactive } = ctx.event.payload || {}

  const activeFilter = includeInactive
    ? ''
    : 'AND si.remaining_sessions > 0 AND (si.expire_date IS NULL OR si.expire_date > CURRENT_DATE)'

  const items = await pg.query(`
    SELECT
      o.sale_order_id,
      o.status AS order_status,
      o.store_id,
      s.store_name,
      o.market_name,
      o.preferred_employee_id,
      si.sale_item_id,
      si.sku_id,
      si.product_name,
      si.sku_spec_name,
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.unit_price,
      si.unit_real_price,
      si.sale_amount,
      si.expire_date
    FROM sale_orders o
    INNER JOIN sale_items si ON o.sale_order_id = si.sale_order_id
    LEFT JOIN stores s ON o.store_id = s.store_id
    WHERE o.client_user_id = $1
      AND o.status = '已支付'
      ${activeFilter}
      AND si.product_type IN ('疗程卡', '单品')
    ORDER BY o.paid_at DESC, si.sale_item_id
  `, [userId])

  // 按订单号分组
  const orderMap = new Map()
  for (const item of items) {
    if (!orderMap.has(item.sale_order_id)) {
      orderMap.set(item.sale_order_id, {
        saleOrderId: item.sale_order_id,
        orderStatus: item.order_status,
        storeId: item.store_id,
        storeName: item.store_name,
        marketName: item.market_name,
        preferredStaffWfId: item.preferred_employee_id,
        items: []
      })
    }
    const isActive = item.remaining_sessions > 0
      && (!item.expire_date || new Date(item.expire_date) > new Date())
    orderMap.get(item.sale_order_id).items.push({
      saleItemId: item.sale_item_id,
      skuId: item.sku_id,
      productName: item.product_name,
      skuSpecName: item.sku_spec_name,
      productType: item.product_type,
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      unitPrice: item.unit_price,
      unitRealPrice: item.unit_real_price,
      saleAmount: item.sale_amount,
      expireDate: item.expire_date,
      active: isActive
    })
  }

  ctx.result = {
    orders: Array.from(orderMap.values())
  }
}

/**
 * 发起支付宝支付
 */
async function alipayPay(ctx) {
  const { userId } = ctx.auth
  const payloadAli = ctx.event.payload || {}
  const orderNo = payloadAli.saleOrderId || payloadAli.orderNo

  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1',
    [orderNo]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  if (order.client_user_id) {
    if (order.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
  } else if (order.sale_order_source !== 'staff') {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许支付')
  }

  // 10分钟超时检查
  const orderTimeAlipay = new Date(order.sale_order_datetime)
  if (Date.now() - orderTimeAlipay.getTime() > 10 * 60 * 1000) {
    await pg.query(
      "UPDATE sale_orders SET status = '已关闭', updated_at = NOW() WHERE sale_order_id = $1",
      [orderNo]
    )
    throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
  }

  const totalAmount = Number(order.total_amount || 0)

  const now = new Date()
  await pg.query(
    "UPDATE sale_orders SET status = '待确认收款', payment_method = 'alipay', client_user_id = COALESCE(client_user_id, $1), updated_at = $2 WHERE sale_order_id = $3",
    [userId, now, orderNo]
  )

  // TODO: 接入真实支付宝当面付 API
  ctx.result = {
    orderNo,
    totalAmount,
    mockMode: true,
    qrCodeUrl: `https://qr.alipay.com/mock_${orderNo}`,
    status: '待确认收款'
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

  const result = await pg.query(`
    SELECT sale_order_id FROM sale_orders
    WHERE sale_order_id LIKE 'FY-XSD-WX-${dateStr}%'
    ORDER BY sale_order_id DESC
    LIMIT 1
  `)

  let seq = 1
  if (result.length > 0) {
    const lastNo = result[0].sale_order_id
    seq = parseInt(lastNo.slice(-4)) + 1
  }

  return `FY-XSD-WX-${dateStr}${String(seq).padStart(4, '0')}`
}

module.exports = {
  create,
  pay,
  alipayPay,
  offlinePay,
  list,
  detail,
  cancel,
  appointableItems,
  scanDetail
}
