/**
 * 订单模块路由（员工端）
 * order.create — 员工开单（店长专用）
 * order.qrcode — 查询订单二维码状态
 * order.confirmOffline — 确认线下收款（店长专用）
 * order.close — 关闭订单（店长专用）
 * order.resetFailed — 重置支付失败订单（店长专用）
 * order.list — 订单列表
 * order.detail — 订单详情
 *
 * 数据全部来自 PG（sale_orders / sale_items / products / product_skus），零 WorkFine 依赖。
 */

const pg = require('../db/pg')
const { requireStaffBound, requireManager } = require('../middleware/auth')
const { generateWxacode, uploadToCloudStorage } = require('../utils/wxacode')

// 模块级缓存：saleOrderId → qrcodeUrl，避免轮询时重复生成
const qrcodeCache = new Map()

/**
 * 员工开单（店长专用）
 * payload: {
 *   clientPhone: string,
 *   clientName: string,
 *   orderType: '普通'|'体验'|'福利活动',
 *   items: [{ skuId, quantity, customPrice?, discount? }],
 *   paymentMethod: 'wechat'|'offline',
 *   preferredStaffWfId: string,
 *   couponId: string
 * }
 */
async function create(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const {
    clientPhone,
    clientName,
    items,
    paymentMethod,
    orderType: orderTypeParam,
    preferredStaffWfId,
    couponId: inputCouponId
  } = payload

  const storeId = ctx.auth.storeId
  const marketName = ctx.auth.marketName || ''

  if (!clientPhone) {
    throw new Error('INVALID_PARAMS: 顾客手机号为必填项')
  }
  if (!clientName) {
    throw new Error('INVALID_PARAMS: 顾客姓名为必填项')
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new Error('INVALID_PARAMS: 商品明细不能为空')
  }
  if (!paymentMethod) {
    throw new Error('INVALID_PARAMS: 缺少 paymentMethod')
  }
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  // 映射前端 orderType
  const ORDER_TYPE_MAP = { normal: '普通', experience: '体验', promotion: '福利活动', internal: '内部' }
  const orderType = ORDER_TYPE_MAP[orderTypeParam] || orderTypeParam || '普通'
  if (!['普通', '体验', '福利活动', '内部'].includes(orderType)) {
    throw new Error('INVALID_PARAMS: orderType 值不合法')
  }

  // 查询顾客是否已注册客户端小程序
  const clientUsers = await pg.query(
    'SELECT user_id FROM client_wechat_users WHERE phone = $1 LIMIT 1',
    [clientPhone]
  )
  const clientUserId = clientUsers.length > 0 ? clientUsers[0].user_id : null

  // 检查是否已有待支付订单
  if (clientUserId) {
    const existing = await pg.query(
      "SELECT sale_order_id FROM sale_orders WHERE client_user_id = $1 AND status = '待支付' LIMIT 1",
      [clientUserId]
    )
    if (existing.length > 0) {
      throw new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
    }
  } else {
    const existing = await pg.query(
      "SELECT sale_order_id FROM sale_orders WHERE client_phone = $1 AND store_id = $2 AND status = '待支付' LIMIT 1",
      [clientPhone, storeId]
    )
    if (existing.length > 0) {
      throw new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
    }
  }

  // 获取 SKU 信息 + 价格（全部从 PG product_skus 读取）
  const itemDataList = await Promise.all(
    items.map(async (item) => {
      const skuRows = await pg.query(
        `SELECT s.sku_id, s.product_id, s.product_type, s.spec_name, s.price, s.session_count,
                p.name AS product_name, p.sales_category
         FROM product_skus s
         JOIN products p ON s.product_id = p.product_id
         WHERE s.sku_id = $1`,
        [item.skuId]
      )
      if (skuRows.length === 0) {
        throw new Error(`INVALID_PARAMS: SKU ${item.skuId} 不存在`)
      }
      const sku = skuRows[0]

      let unitPrice
      let sessionCount = null
      let salesCategory = sku.sales_category || null

      if (orderType === '体验' && item.customPrice !== undefined) {
        unitPrice = Number(item.customPrice)
        sessionCount = 1
      } else if (orderType === '内部') {
        // 内部单（员工消费）统一半价
        unitPrice = Math.round(Number(sku.price) * 50) / 100
        sessionCount = sku.session_count != null ? Number(sku.session_count) : null
      } else {
        unitPrice = Number(sku.price)
        sessionCount = sku.session_count != null ? Number(sku.session_count) : null
      }

      const quantity = item.quantity || 1
      const saleAmount = unitPrice * quantity

      // 优惠金额
      const discount = Number(item.discount) || 0
      if (discount < 0 || discount > saleAmount) {
        throw new Error('INVALID_PARAMS: 优惠金额不合法')
      }
      const unitRealPrice = quantity > 0 ? (unitPrice - discount / quantity) : unitPrice
      const received = saleAmount - discount

      return {
        skuId: item.skuId,
        productName: sku.product_name,
        skuSpecName: sku.spec_name,
        productType: sku.product_type,
        sessionCount,
        remainingSessions: sessionCount,
        unitPrice,
        quantity,
        unitRealPrice,
        saleAmount,
        received,
        salesCategory
      }
    })
  )

  // ========== 优惠券处理 ==========
  let couponDiscount = 0
  let couponInfo = null
  if (inputCouponId && clientUserId) {
    const couponRows = await pg.query(
      `SELECT uc.coupon_id, uc.user_id, uc.expire_at,
              ct.coupon_type, ct.discount_value, ct.min_spend,
              ct.applicable_category_ids, ct.applicable_store_ids
       FROM user_coupons uc
       JOIN coupon_templates ct ON uc.template_id = ct.template_id
       WHERE uc.coupon_id = $1 AND uc.user_id = $2
         AND uc.status = '未使用' AND uc.expire_at > NOW()
         AND ct.is_active = true`,
      [inputCouponId, clientUserId]
    )
    if (couponRows.length === 0) {
      throw new Error('INVALID_PARAMS: 优惠券已失效')
    }
    couponInfo = couponRows[0]

    // 门店匹配
    if (couponInfo.applicable_store_ids && couponInfo.applicable_store_ids.length > 0) {
      if (!storeId || !couponInfo.applicable_store_ids.includes(storeId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此门店')
      }
    }

    // 品项分类匹配
    const skuIdList = itemDataList.map(d => d.skuId)
    const skuCats = await pg.query(
      `SELECT ps.sku_id, p.category_id
       FROM product_skus ps JOIN products p ON ps.product_id = p.product_id
       WHERE ps.sku_id = ANY($1)`,
      [skuIdList]
    )
    const catMap = new Map()
    for (const r of skuCats) catMap.set(r.sku_id, r.category_id)

    let eligibleItems
    if (couponInfo.applicable_category_ids && couponInfo.applicable_category_ids.length > 0) {
      eligibleItems = itemDataList.filter(d =>
        couponInfo.applicable_category_ids.includes(catMap.get(d.skuId))
      )
    } else {
      eligibleItems = itemDataList
    }
    if (eligibleItems.length === 0) {
      throw new Error('INVALID_PARAMS: 该优惠券不适用于当前商品')
    }

    const eligibleTotal = eligibleItems.reduce((s, d) => s + d.received, 0)
    const minSpend = Number(couponInfo.min_spend) || 0
    if (eligibleTotal < minSpend) {
      throw new Error(`INVALID_PARAMS: 未满足使用条件（满${minSpend}可用）`)
    }

    if (couponInfo.coupon_type === '现金券' || couponInfo.coupon_type === '项目券') {
      couponDiscount = Math.min(Number(couponInfo.discount_value), eligibleTotal)
    }
    couponDiscount = Math.round(couponDiscount * 100) / 100

    // 分摊到各行 received
    for (const item of eligibleItems) {
      const share = couponDiscount * (item.received / eligibleTotal)
      const roundedShare = Math.round(share * 100) / 100
      item.received -= roundedShare
      item.received = Math.round(item.received * 100) / 100
      // 同步更新 unitRealPrice
      item.unitRealPrice = item.quantity > 0 ? item.received / item.quantity : 0
    }
  }

  const now = new Date()
  const saleOrderId = await generateOrderNo()
  const totalAmount = itemDataList.reduce((sum, d) => sum + d.received, 0)

  await pg.transaction(async (client) => {
    // Advisory lock 防并发流水号冲突
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_item_id_gen'])

    const today = now
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')
    const maxResult = await client.query(
      `SELECT sale_item_id FROM sale_items
       WHERE sale_item_id LIKE $1
       ORDER BY sale_item_id DESC LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )
    let seq = 1
    if (maxResult.rows.length > 0) {
      seq = parseInt(maxResult.rows[0].sale_item_id.slice(-4)) + 1
    }

    // 原子 claim 优惠券
    if (inputCouponId && clientUserId) {
      const claimResult = await client.query(
        `UPDATE user_coupons
         SET status = '已使用', used_sale_order_id = $1, used_at = NOW()
         WHERE coupon_id = $2 AND user_id = $3
           AND status = '未使用' AND expire_at > NOW()`,
        [saleOrderId, inputCouponId, clientUserId]
      )
      if (claimResult.rowCount !== 1) {
        throw new Error('INVALID_PARAMS: 优惠券已失效')
      }
    }

    // 创建订单主表
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, market_name, store_id,
        sale_order_datetime, total_amount, client_user_id, client_phone, customer_name,
        payment_method, sale_order_source, opened_by,
        preferred_employee_id, coupon_id, coupon_discount,
        created_at, updated_at
      ) VALUES ($1, '待支付', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'staff', $11, $12, $13, $14, $5, $5)`,
      [
        saleOrderId, orderType, marketName, storeId, now,
        totalAmount, clientUserId, clientPhone, clientName,
        paymentMethod, ctx.auth.staffWfId,
        preferredStaffWfId || null,
        inputCouponId || null, couponDiscount
      ]
    )

    // 创建订单明细
    for (let i = 0; i < itemDataList.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemDataList[i]

      // 院装产品无 session_count
      const sc = d.productType === '院装产品' ? null : d.sessionCount
      const rs = d.productType === '院装产品' ? null : d.remainingSessions

      await client.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, item_direction, sku_id,
          product_name, sku_spec_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category
        ) VALUES ($1, $2, 'purchase', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          saleItemId, saleOrderId, d.skuId,
          d.productName, d.skuSpecName, d.productType,
          sc, rs,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount, d.received,
          d.salesCategory || null
        ]
      )
    }
  })

  ctx.result = {
    saleOrderId,
    totalAmount,
    couponDiscount,
    status: '待支付',
    clientUserId,
    message: '开单成功'
  }
}

/**
 * 订单二维码状态
 */
async function qrcode(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  const orders = await pg.query(
    `SELECT o.sale_order_id, o.status, o.sale_order_type, o.client_phone, o.customer_name,
            o.payment_method, o.paid_at, o.store_id, o.opened_by
     FROM sale_orders o
     WHERE o.sale_order_id = $1`,
    [saleOrderId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 仅本店员工可查看
  if (!ctx.auth.roles.includes('manager') && order.store_id !== ctx.auth.storeId) {
    throw new Error('PERMISSION_DENIED: 无权查看该订单')
  }

  const items = await pg.query(`
    SELECT
      si.sale_item_id, si.received, si.product_name, si.sku_spec_name
    FROM sale_items si
    WHERE si.sale_order_id = $1
  `, [saleOrderId])

  const totalAmount = items.reduce((s, i) => s + Number(i.received || 0), 0)

  // 推导二维码显示状态
  let qrCodeStatus
  if (['已支付', '已完成'].includes(order.status)) {
    qrCodeStatus = '已支付'
  } else if (order.status === '待确认收款') {
    qrCodeStatus = '待确认收款'
  } else if (order.status === '待支付') {
    qrCodeStatus = '待扫码'
  } else {
    qrCodeStatus = order.status
  }

  // 仅待支付订单生成小程序码（带缓存）
  let qrcodeUrl = ''
  let qrcodeError = ''
  if (order.status === '待支付') {
    if (qrcodeCache.has(saleOrderId)) {
      qrcodeUrl = qrcodeCache.get(saleOrderId)
    } else {
      try {
        const buffer = await generateWxacode(saleOrderId, 'pagesOrder/scan-pay/scan-pay')
        const cloudPath = `wxacode/order/${saleOrderId}.png`
        qrcodeUrl = await uploadToCloudStorage(buffer, cloudPath)
        qrcodeCache.set(saleOrderId, qrcodeUrl)
      } catch (err) {
        console.error('[order.qrcode] 生成小程序码失败:', err)
        qrcodeError = err.message || '生成小程序码失败'
      }
    }
  }

  ctx.result = {
    saleOrderId: order.sale_order_id,
    status: order.status,
    qrCodeStatus,
    orderType: order.sale_order_type,
    clientPhone: order.client_phone,
    customerName: order.customer_name,
    paymentMethod: order.payment_method,
    paidAt: order.paid_at,
    openedBy: order.opened_by,
    totalAmount,
    items: items.map(i => ({
      saleItemId: i.sale_item_id,
      productName: i.product_name,
      skuSpecName: i.sku_spec_name,
      received: i.received
    })),
    qrcodeUrl,
    qrcodeError
  }
}

/**
 * 确认线下收款（店长专用）
 */
async function confirmOffline(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  const orders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2",
    [saleOrderId, ctx.auth.storeId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  if (order.status === '待支付' && order.payment_method !== 'offline') {
    throw new Error(`INVALID_PARAMS: 非线下支付订单不可直接确认收款`)
  }
  if (!['待确认收款', '待支付'].includes(order.status)) {
    throw new Error(`INVALID_PARAMS: 订单当前状态为"${order.status}"，不可确认收款`)
  }

  const now = new Date()

  // 查询订单明细
  const items = await pg.query(
    `SELECT si.sale_item_id, si.sku_id, si.received, si.product_type
     FROM sale_items si
     WHERE si.sale_order_id = $1`,
    [saleOrderId]
  )

  const totalReceived = items.reduce((s, i) => s + Number(i.received || 0), 0)

  await pg.transaction(async (client) => {
    // 更新订单状态
    await client.query(
      `UPDATE sale_orders
       SET status = '已支付', paid_at = $1, updated_at = $1,
           offline_confirmed_by = $2, offline_confirmed_at = $1,
           allocation_status = 'pending'
       WHERE sale_order_id = $3`,
      [now, ctx.auth.staffWfId, saleOrderId]
    )

    // 单品到期日写入（paid_at + 1年）
    await client.query(
      `UPDATE sale_items
       SET expire_date = ($1::date + INTERVAL '1 year')
       WHERE sale_order_id = $2
         AND product_type = '单品'
         AND expire_date IS NULL`,
      [now, saleOrderId]
    )
  })

  ctx.result = {
    saleOrderId,
    status: '已支付',
    paidAt: now,
    totalReceived,
    message: '线下收款已确认'
  }
}

/**
 * 关闭订单
 */
async function close(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  const orders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2",
    [saleOrderId, ctx.auth.storeId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]
  const isManagerRole = ctx.auth.roles.includes('manager')
  const isCreator = order.opened_by === ctx.auth.staffWfId

  if (isManagerRole) {
    if (!['待支付', '待确认收款', '支付失败'].includes(order.status)) {
      throw new Error(`INVALID_PARAMS: 订单当前状态"${order.status}"不允许关闭`)
    }
  } else if (isCreator) {
    if (order.status !== '待支付') {
      throw new Error(`INVALID_PARAMS: 订单当前状态"${order.status}"不允许取消`)
    }
  } else {
    throw new Error('PERMISSION_DENIED: 无权操作该订单')
  }

  const now = new Date()

  await pg.transaction(async (client) => {
    await client.query(
      "UPDATE sale_orders SET status = '已关闭', updated_at = $1 WHERE sale_order_id = $2",
      [now, saleOrderId]
    )
    // 作废营业额分配
    const saleItemIds = await client.query(
      'SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1',
      [saleOrderId]
    )
    if (saleItemIds.rows.length > 0) {
      const ids = saleItemIds.rows.map(r => r.sale_item_id)
      await client.query(
        "UPDATE sale_allocations SET is_void = true, voided_at = $1, updated_at = $1 WHERE sale_item_id = ANY($2) AND is_void = false",
        [now, ids]
      )
    }
    // 释放关联的优惠券
    await client.query(
      `UPDATE user_coupons
       SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
       WHERE used_sale_order_id = $1`,
      [saleOrderId]
    )
  })

  ctx.result = {
    saleOrderId,
    status: '已关闭',
    message: '订单已关闭'
  }
}

/**
 * 重置支付失败订单（店长专用）
 */
async function resetFailed(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  const orders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2",
    [saleOrderId, ctx.auth.storeId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  if (orders[0].status !== '支付失败') {
    throw new Error('INVALID_PARAMS: 订单状态不是支付失败，无法重置')
  }

  const now = new Date()
  await pg.query(
    "UPDATE sale_orders SET status = '待支付', updated_at = $1 WHERE sale_order_id = $2",
    [now, saleOrderId]
  )

  ctx.result = {
    saleOrderId,
    status: '待支付',
    message: '订单已重置，顾客可重新发起付款'
  }
}

/**
 * 订单列表
 */
async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, page = 1, pageSize = 20 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.storeId, pageSize, offset]
  let whereExtra = ''

  if (status) {
    params.push(status)
    whereExtra += ` AND o.status = $${params.length}`
  }

  // 美容师只能看到指定自己的订单
  if (!ctx.auth.roles.includes('manager')) {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND o.preferred_employee_id = $${params.length}`
  }

  const orders = await pg.query(`
    SELECT
      o.sale_order_id, o.status, o.sale_order_type, o.client_phone, o.customer_name,
      o.payment_method, o.sale_order_source, o.preferred_employee_id,
      o.paid_at, o.created_at, o.opened_by, o.total_amount
    FROM sale_orders o
    WHERE o.store_id = $1
    ${whereExtra}
    ORDER BY o.created_at DESC
    LIMIT $2 OFFSET $3
  `, params)

  ctx.result = { orders, page, pageSize }
}

/**
 * 订单详情
 */
async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  const orders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2',
    [saleOrderId, ctx.auth.storeId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  // 美容师只能看指定自己的订单
  if (!ctx.auth.roles.includes('manager') && order.preferred_employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权查看该订单')
  }

  // 兜底补充顾客信息
  if (!order.client_phone && order.client_user_id) {
    const clientRows = await pg.query(
      'SELECT phone FROM client_wechat_users WHERE user_id = $1 LIMIT 1',
      [order.client_user_id]
    )
    if (clientRows.length > 0 && clientRows[0].phone) {
      order.client_phone = clientRows[0].phone
    }
  }
  if (!order.customer_name && order.client_phone) {
    const nameRows = await pg.query(
      'SELECT name FROM client_wechat_users WHERE phone = $1 LIMIT 1',
      [order.client_phone]
    )
    if (nameRows.length > 0 && nameRows[0].name) {
      order.customer_name = nameRows[0].name
    }
  }

  // 解析指定美容师姓名
  if (order.preferred_employee_id) {
    const staffRows = await pg.query(
      'SELECT name FROM staff_wechat_users WHERE employee_id = $1',
      [order.preferred_employee_id]
    )
    if (staffRows.length > 0) {
      order.preferred_staff_name = (staffRows[0].name || '').trim()
    }
  }

  const items = await pg.query(`
    SELECT
      si.sale_item_id, si.sku_id, si.session_count, si.remaining_sessions,
      si.unit_price, si.quantity, si.unit_real_price, si.sale_amount, si.received,
      si.expire_date, si.remark, si.sales_category,
      si.product_name, si.sku_spec_name, si.product_type
    FROM sale_items si
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [saleOrderId])

  // 营业额分配（sale_allocations 为扁平结构，每行一条分配）
  const allocations = await pg.query(`
    SELECT
      sa.id, sa.sale_item_id, sa.employee_id, sa.department_name,
      sa.allocation_ratio, sa.total_amount, sa.is_void
    FROM sale_allocations sa
    JOIN sale_items si ON sa.sale_item_id = si.sale_item_id
    WHERE si.sale_order_id = $1
    ORDER BY sa.id
  `, [saleOrderId])

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
    order: { ...order, coupon_name: couponName },
    items,
    allocations
  }
}

// ========== 辅助函数 ==========

/**
 * 生成订单号：FY-XSD-WX-{YYMMDD}{4位序号}
 */
async function generateOrderNo() {
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')

  const result = await pg.query(`
    SELECT sale_order_id FROM sale_orders
    WHERE sale_order_id LIKE 'FY-XSD-WX-${dateStr}%'
    ORDER BY sale_order_id DESC LIMIT 1
  `)

  let seq = 1
  if (result.length > 0) {
    seq = parseInt(result[0].sale_order_id.slice(-4)) + 1
  }

  return `FY-XSD-WX-${dateStr}${String(seq).padStart(4, '0')}`
}

module.exports = {
  create,
  qrcode,
  confirmOffline,
  close,
  resetFailed,
  list,
  detail
}
