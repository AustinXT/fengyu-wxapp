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
 * 数据全部来自 PG（sale_orders / sale_items / product_skus / product_categories），零 WorkFine 依赖。
 */

const pg = require('../db/pg')
const { requireStaffBound, requireManager } = require('../middleware/auth')
const { generateWxacode, uploadToCloudStorage } = require('../utils/wxacode')
const { getMemberThreshold } = require('../utils/config')

// 模块级缓存：saleOrderId → qrcodeUrl，避免轮询时重复生成
const qrcodeCache = new Map()

/**
 * 根据已支付/已完成订单的累计金额，重算顾客的历史消费档位
 *
 * 注意：member_level（钻石等级）由 cronTask 每日凌晨3点统一重算，本函数不直接更新。
 *
 * spending_tier CASE B1 方案：'1990-1W' 档的下界从 config 读取，
 * 标签名 '1990-1W' 作为历史 bucket id 保留（枚举值不可动态生成）。
 *
 * @param {object} client - pg 事务客户端
 * @param {string} clientUserId - client_wechat_users.user_id
 */
async function refreshSpendingTier(client, clientUserId) {
  if (!clientUserId) return
  const memberThreshold = await getMemberThreshold()
  await client.query(
    `UPDATE client_wechat_users
     SET spending_tier = CASE
       WHEN t.total >= 100000 THEN '10W+'
       WHEN t.total >= 60000  THEN '6-10W'
       WHEN t.total >= 30000  THEN '3-6W'
       WHEN t.total >= 10000  THEN '1-3W'
       WHEN t.total >= $2     THEN '1990-1W'
       ELSE '<1990'
     END::spending_tier,
     updated_at = NOW()
     FROM (
       SELECT COALESCE(SUM(total_amount), 0) AS total
       FROM sale_orders
       WHERE client_user_id = $1
         AND status IN ('已支付', '已完成')
     ) t
     WHERE user_id = $1`,
    [clientUserId, memberThreshold]
  )
}

/**
 * 根据已支付/已完成订单历史，重算顾客类型（只升不降）
 * 阈值从 system_configs.new_member_threshold 读取
 * 跃迁为"会员客"时同步写入 became_member_at = NOW()。
 * TODO: 将来若开放"会员客→非会员客"降级路径，需同步 UPDATE became_member_at = NULL。
 * @param {object} client - pg 事务客户端
 * @param {string} clientUserId - client_wechat_users.user_id
 */
async function recalcCustomerType(client, clientUserId) {
  if (!clientUserId) return

  // 已是最高级，无需重算
  const cur = await client.query(
    'SELECT customer_type FROM client_wechat_users WHERE user_id = $1',
    [clientUserId]
  )
  if (cur.rows[0]?.customer_type === '会员客') return

  const threshold = await getMemberThreshold()

  const typeResult = await client.query(
    `SELECT CASE
       WHEN EXISTS (
         SELECT 1 FROM sale_orders o
         WHERE o.client_user_id = $1
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND (
             o.total_amount >= $2
             OR (o.total_amount + COALESCE((
               SELECT SUM(r.total_amount)
               FROM sale_orders r
               WHERE r.ref_sale_order_id = o.sale_order_id
                 AND r.sale_order_type = '回款单'
                 AND r.status IN ('已支付', '已完成')
             ), 0)) >= $2
           )
       ) THEN '会员客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         JOIN product_skus sk ON sk.sku_id = si.sku_id
         JOIN product_categories pc ON pc.category_id = sk.category_id
         WHERE o.client_user_id = $1
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND pc.product_kind <> '体验卡'
       ) THEN '小美客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         JOIN product_skus sk ON sk.sku_id = si.sku_id
         JOIN product_categories pc ON pc.category_id = sk.category_id
         WHERE o.client_user_id = $1
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND pc.product_kind = '体验卡'
       ) THEN '体验客'
       ELSE '流量客'
     END AS computed_type`,
    [clientUserId, threshold]
  )

  const newType = typeResult.rows[0].computed_type
  const updateResult = await client.query(
    `UPDATE client_wechat_users
     SET customer_type = $2::customer_type, updated_at = NOW()
     WHERE user_id = $1
       AND (CASE customer_type
              WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
              WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
            END)
         < (CASE $2::customer_type
              WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
              WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
            END)
     RETURNING customer_type`,
    [clientUserId, newType]
  )

  // 若本次 UPDATE 实际将顾客升级为"会员客"，同步写入 became_member_at
  if (updateResult.rowCount > 0 && updateResult.rows[0].customer_type === '会员客') {
    await client.query(
      `UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = $1`,
      [clientUserId]
    )
  }
}

/**
 * 员工开单（店长专用）
 * payload: {
 *   clientPhone: string,
 *   clientName: string,
 *   saleOrderType: '销售单' | '内部单',   // 直接使用 DB 枚举文本，无历史兼容
 *   items: [{ skuId, quantity, customPrice?, discount? }],
 *   paymentMethod: '微信'|'线下',
 *   preferredStaffWfId: string,
 *   couponId: string
 * }
 *
 * 行为：
 *   - 销售单：正常计价；customPrice 作为行级自定义单价；支持 couponId
 *   - 内部单：所有 SKU 半价（basePrice × 0.5）；禁用 customPrice；拒绝 couponId
 */
async function create(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const {
    clientPhone,
    clientName,
    items,
    paymentMethod,
    saleOrderType: saleOrderTypeParam,
    preferredStaffWfId,
    couponId: inputCouponId,
    remark: orderRemark
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
  // PR-D1：白名单守卫，与 createConversion 对齐（暂不支持支付宝，待业务确认）
  if (!['微信', '线下'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式')
  }
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  // sale_order_type 直接使用 DB 枚举文本（无历史兼容映射）
  const saleOrderType = saleOrderTypeParam || '销售单'
  if (!['销售单', '内部单'].includes(saleOrderType)) {
    throw new Error('INVALID_PARAMS: saleOrderType 值不合法（仅支持 销售单/内部单）')
  }

  // 内部单守卫：不允许叠加优惠券
  if (saleOrderType === '内部单' && inputCouponId) {
    throw new Error('INVALID_PARAMS: 内部单不允许叠加优惠券')
  }

  // 内部单守卫：不允许行级手工改价（与 admin 对齐）
  if (saleOrderType === '内部单') {
    const hasCustomPrice = items.some(it => it && it.customPrice !== undefined && it.customPrice !== null)
    if (hasCustomPrice) {
      throw new Error('INVALID_PARAMS: 内部单不允许手工改价')
    }
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

  // 获取 SKU 信息 + 价格（product_skus → product_categories 两表 JOIN）
  const itemDataList = await Promise.all(
    items.map(async (item) => {
      const skuRows = await pg.query(
        `SELECT s.sku_id, s.product_type, s.spec_name, s.price, s.special_price, s.session_count,
                s.service_fee,
                pc.sales_category, pc.product_kind
         FROM product_skus s
         JOIN product_categories pc ON s.category_id = pc.category_id
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
      // 优先使用特价（special_price），没有则用标准价
      const basePrice = Number(sku.special_price || sku.price)

      if (saleOrderType === '内部单') {
        // 内部单（员工消费）统一半价；不允许 customPrice（上方已拦截）
        unitPrice = Math.round(basePrice * 50) / 100
        sessionCount = sku.session_count != null ? Number(sku.session_count) : null
      } else if (item.customPrice !== undefined && item.customPrice !== null) {
        // 销售单 — 行级自定义单价（兜底店长改价；仅销售单生效）
        unitPrice = Number(item.customPrice)
        sessionCount = sku.session_count != null ? Number(sku.session_count) : null
      } else {
        unitPrice = basePrice
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

      // 固定手工费快照：从 product_skus.service_fee 取值 × quantity
      // 即使现在是 0 也要明确快照，避免后续 sku 改价影响历史订单
      const serviceFee = Math.round(Number(sku.service_fee || 0) * quantity * 100) / 100

      return {
        skuId: item.skuId,
        productName: sku.spec_name,
        skuSpecName: sku.spec_name,
        productType: sku.product_type,
        productKind: sku.product_kind,
        sessionCount,
        remainingSessions: sessionCount,
        unitPrice,
        quantity,
        unitRealPrice,
        saleAmount,
        received,
        salesCategory,
        serviceFee,
      }
    })
  )

  // ========== 优惠券处理 ==========
  let couponDiscount = 0
  let couponInfo = null
  if (inputCouponId && clientUserId) {
    const couponRows = await pg.query(
      `SELECT uc.coupon_id, uc.user_id, uc.expire_at,
              ct.coupon_type, ct.discount_value, ct.min_spend, ct.max_discount,
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
      `SELECT sku_id, category_id FROM product_skus WHERE sku_id = ANY($1)`,
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

    // 满减门槛（归一化到分 + 浮点兜底，与 coupon.available 保持一致）
    const eligibleTotalRaw = eligibleItems.reduce((s, d) => s + d.received, 0)
    const eligibleTotal = Math.round(eligibleTotalRaw * 100) / 100
    const minSpend = Math.round((Number(couponInfo.min_spend) || 0) * 100) / 100
    if (eligibleTotal + 0.001 < minSpend) {
      throw new Error(`INVALID_PARAMS: 未满足使用条件（满${minSpend}可用）`)
    }

    if (couponInfo.coupon_type === '现金券' || couponInfo.coupon_type === '品项券') {
      couponDiscount = Math.min(Number(couponInfo.discount_value), eligibleTotal)
    } else if (couponInfo.coupon_type === '折扣券') {
      couponDiscount = eligibleTotal * (1 - Number(couponInfo.discount_value))
      if (couponInfo.max_discount) {
        couponDiscount = Math.min(couponDiscount, Number(couponInfo.max_discount))
      }
    }
    couponDiscount = Math.round(couponDiscount * 100) / 100

    // 分摊到各行 received（最后一项补差，避免分分钱精度丢失）
    let distributedTotal = 0
    for (let i = 0; i < eligibleItems.length; i++) {
      const item = eligibleItems[i]
      let share
      if (i === eligibleItems.length - 1) {
        share = couponDiscount - distributedTotal
      } else {
        share = Math.round(couponDiscount * (item.received / eligibleTotal) * 100) / 100
        distributedTotal += share
      }
      item.received -= share
      item.received = Math.round(item.received * 100) / 100
      // 同步更新 unitRealPrice
      item.unitRealPrice = item.quantity > 0 ? item.received / item.quantity : 0
    }
  }

  const now = new Date()
  const saleOrderId = await generateOrderNo()
  const totalAmount = itemDataList.reduce((sum, d) => sum + d.received, 0)

  // ========== 计算 document_type（售前/售后快照） ==========
  let documentType = '售前'
  if (clientUserId) {
    const ctRows = await pg.query(
      'SELECT customer_type FROM client_wechat_users WHERE user_id = $1',
      [clientUserId]
    )
    if (ctRows.length > 0 && ctRows[0].customer_type === '会员客') {
      documentType = '售后'
    }
  }
  if (documentType === '售前') {
    const threshold = await getMemberThreshold()
    if (totalAmount >= threshold) {
      documentType = '售后'
    }
  }

  await pg.transaction(async (client) => {
    // Advisory lock 防并发流水号冲突
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

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
    // PR-D1：线下支付 → 待确认收款（与 admin 对齐），微信支付 → 待支付
    const initialStatus = paymentMethod === '线下' ? '待确认收款' : '待支付'
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id,
        sale_order_datetime, total_amount, client_user_id, client_phone, customer_name,
        payment_method, opened_by,
        preferred_employee_id, coupon_id, coupon_discount, remark,
        created_at, updated_at
      ) VALUES ($1, $17, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $6, $6)`,
      [
        saleOrderId, saleOrderType, documentType, marketName, storeId, now,
        totalAmount, clientUserId, clientPhone, clientName,
        paymentMethod, ctx.auth.staffWfId,
        preferredStaffWfId || null,
        inputCouponId || null, couponDiscount,
        orderRemark || null,
        initialStatus,
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
          sale_item_id, sale_order_id, store_id, item_direction, sku_id,
          product_name, sku_spec_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee
        ) VALUES ($1, $2, $3, '购买', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          saleItemId, saleOrderId, storeId, d.skuId,
          d.productName, d.skuSpecName, d.productType,
          sc, rs,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount, d.received,
          d.salesCategory || null,
          d.serviceFee || 0,
        ]
      )
    }
  })

  ctx.result = {
    saleOrderId,
    totalAmount,
    couponDiscount,
    status: paymentMethod === '线下' ? '待确认收款' : '待支付',
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
  const saleOrderId = payload.saleOrderId
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
        qrcodeError = '生成小程序码失败'
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
  const saleOrderId = payload.saleOrderId
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

  if (order.status === '待支付' && order.payment_method !== '线下') {
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
    // 更新订单状态（C4: WHERE 锁定当前状态防止并发竞态）
    const updateResult = await client.query(
      `UPDATE sale_orders
       SET status = '已支付', paid_at = $1, updated_at = $1,
           offline_confirmed_by = $2, offline_confirmed_at = $1,
           allocation_status = CASE WHEN allocation_status = '已分配' THEN '已分配' ELSE '待分配' END
       WHERE sale_order_id = $3 AND status = $4`,
      [now, ctx.auth.staffWfId, saleOrderId, order.status]
    )
    if (updateResult.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 订单状态已变更，请刷新后重试')
    }

    // 单品到期日写入（paid_at + 1年）
    await client.query(
      `UPDATE sale_items
       SET expire_date = ($1::date + INTERVAL '1 year')
       WHERE sale_order_id = $2
         AND product_type = '单品'
         AND expire_date IS NULL`,
      [now, saleOrderId]
    )

    // 重算顾客历史消费档位
    await refreshSpendingTier(client, order.client_user_id)
    // 重算顾客类型（只升不降）
    await recalcCustomerType(client, order.client_user_id)
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
  const saleOrderId = payload.saleOrderId
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
  const isCreator = order.opened_by && order.opened_by === ctx.auth.staffWfId

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
    const updateResult = await client.query(
      "UPDATE sale_orders SET status = '已关闭', updated_at = $1 WHERE sale_order_id = $2 AND status = $3",
      [now, saleOrderId, order.status]
    )
    if (updateResult.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 订单状态已变更，请刷新后重试')
    }
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
  const saleOrderId = payload.saleOrderId
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
  const result = await pg.query(
    "UPDATE sale_orders SET status = '待支付', updated_at = $1 WHERE sale_order_id = $2 AND status = '支付失败'",
    [now, saleOrderId]
  )
  if (result.rowCount === 0) {
    throw new Error('INVALID_PARAMS: 订单状态已变更，请刷新后重试')
  }

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
      o.payment_method, o.preferred_employee_id,
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
  const saleOrderId = payload.saleOrderId
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
      sa.allocation_ratio, sa.total_amount, sa.is_void,
      sw.name AS employee_name
    FROM sale_allocations sa
    JOIN sale_items si ON sa.sale_item_id = si.sale_item_id
    LEFT JOIN staff_wechat_users sw ON sa.employee_id = sw.employee_id
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

// ========== P2: 退款单 ==========

/**
 * 创建退款单（店长专用）
 * payload: {
 *   refSaleOrderId: string,   // 原销售单号
 *   items: [{ saleItemId, refundQuantity, refundReason? }],
 *   refundReason: string,
 *   handlingFee?: number
 * }
 * 退款单创建后状态为 '待审批'
 */
async function createRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { refSaleOrderId, items, refundReason, handlingFee } = ctx.event.payload || {}
  const storeId = ctx.auth.storeId
  const marketName = ctx.auth.marketName || ''

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  if (!items || !Array.isArray(items) || items.length === 0) throw new Error('INVALID_PARAMS: 退款明细不能为空')
  if (!refundReason) throw new Error('INVALID_PARAMS: 退款原因不能为空')

  // 查原单
  const origOrders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2 AND status IN ('已支付', '已完成')",
    [refSaleOrderId, storeId]
  )
  if (origOrders.length === 0) throw new Error('INVALID_PARAMS: 原订单不存在或状态不允许退款')
  const origOrder = origOrders[0]

  // 查原单明细
  const origItems = await pg.query(
    "SELECT * FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'",
    [refSaleOrderId]
  )
  const origItemMap = {}
  for (const i of origItems) origItemMap[i.sale_item_id] = i

  // 构建退款明细
  const refundItems = []
  let totalRefund = 0
  for (const req of items) {
    const orig = origItemMap[req.saleItemId]
    if (!orig) throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 不存在`)
    const qty = req.refundQuantity || orig.quantity
    const unitRealPrice = Number(orig.unit_real_price)
    const refundAmount = unitRealPrice * qty
    totalRefund += refundAmount
    // 退款行 service_fee 为负数，按退款数量占原单数量的比例扣减
    const origServiceFee = Number(orig.service_fee || 0)
    const origQty = Number(orig.quantity) || 1
    const refundServiceFee = -Math.round((origServiceFee * qty / origQty) * 100) / 100
    refundItems.push({
      refSaleItemId: req.saleItemId,
      skuId: orig.sku_id,
      productName: orig.product_name,
      skuSpecName: orig.sku_spec_name,
      productType: orig.product_type,
      sessionCount: orig.session_count,
      unitPrice: Number(orig.unit_price),
      quantity: qty,
      unitRealPrice,
      refundAmount,
      salesCategory: orig.sales_category,
      serviceFee: refundServiceFee,
    })
  }

  const fee = Number(handlingFee) || 0
  const totalAmount = -(totalRefund - fee)  // 负数

  const now = new Date()
  const refundOrderId = await generateOrderNo('FY-TKD-WX-')

  await pg.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')
    const maxResult = await client.query(
      `SELECT sale_item_id FROM sale_items WHERE sale_item_id LIKE $1 ORDER BY sale_item_id DESC LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )
    let seq = 1
    if (maxResult.rows.length > 0) seq = parseInt(maxResult.rows[0].sale_item_id.slice(-4)) + 1

    // 创建退款订单
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, ref_sale_order_id,
        market_name, store_id, sale_order_datetime,
        client_user_id, client_phone, customer_name,
        total_amount, payment_method, opened_by,
        refund_reason, handling_fee, created_at, updated_at
      ) VALUES ($1, '待审批', '退款单', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $6, $6)`,
      [
        refundOrderId, origOrder.document_type, refSaleOrderId, marketName, storeId, now,
        origOrder.client_user_id, origOrder.client_phone, origOrder.customer_name,
        totalAmount, origOrder.payment_method, ctx.auth.staffWfId,
        refundReason, fee || null
      ]
    )

    // 创建退款明细行
    for (let i = 0; i < refundItems.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = refundItems[i]
      await client.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction, ref_sale_item_id,
          sku_id, product_name, sku_spec_name, product_type,
          session_count, unit_price, quantity,
          unit_real_price, sale_amount, received, sales_category, service_fee
        ) VALUES ($1, $2, $3, '退出', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          saleItemId, refundOrderId, storeId, d.refSaleItemId,
          d.skuId, d.productName, d.skuSpecName, d.productType,
          d.sessionCount, d.unitPrice, d.quantity,
          d.unitRealPrice, -(d.refundAmount), -(d.refundAmount),
          d.salesCategory,
          d.serviceFee || 0,
        ]
      )
    }
  })

  ctx.result = { saleOrderId: refundOrderId, status: '待审批', totalAmount, message: '退款单已创建' }
}

/**
 * 审批退款单（店长专用）
 */
async function approveRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { saleOrderId } = ctx.event.payload || {}
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')

  const orders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2 AND sale_order_type = '退款单' AND status = '待审批'",
    [saleOrderId, ctx.auth.storeId]
  )
  if (orders.length === 0) throw new Error('INVALID_PARAMS: 退款单不存在或状态不允许审批')

  const now = new Date()

  // 查退款明细（refund_out 行），原子扣减原购买行 remaining_sessions
  const refundItems = await pg.query(
    "SELECT * FROM sale_items WHERE sale_order_id = $1 AND item_direction = '退出'",
    [saleOrderId]
  )

  await pg.transaction(async (client) => {
    // 扣减原购买行次数
    for (const ri of refundItems) {
      if (ri.ref_sale_item_id && ri.session_count) {
        const result = await client.query(
          `UPDATE sale_items SET remaining_sessions = remaining_sessions - $1, updated_at = $2
           WHERE sale_item_id = $3 AND remaining_sessions >= $1`,
          [ri.quantity, now, ri.ref_sale_item_id]
        )
        if (result.rowCount === 0) {
          throw new Error('INVALID_PARAMS: 剩余次数不足，无法退款')
        }
      }
    }

    // 更新退款单状态
    const updateResult = await client.query(
      `UPDATE sale_orders SET status = '已支付', paid_at = $1, approved_by = $2, approved_at = $1,
       allocation_status = '待分配', updated_at = $1
       WHERE sale_order_id = $3 AND status = '待审批'`,
      [now, ctx.auth.staffWfId, saleOrderId]
    )
    if (updateResult.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 退款单状态已变更，请刷新后重试')
    }

    // 重算顾客历史消费档位（退款会减少累计消费）
    await refreshSpendingTier(client, orders[0].client_user_id)
    // 重算顾客类型（退款不降级，但保持一致性）
    await recalcCustomerType(client, orders[0].client_user_id)
  })

  ctx.result = { saleOrderId, status: '已支付', message: '退款已审批通过' }
}

/**
 * 驳回退款单（店长专用）
 */
async function rejectRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { saleOrderId, rejectedReason } = ctx.event.payload || {}
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')

  const now = new Date()
  const result = await pg.query(
    `UPDATE sale_orders SET status = '已关闭', rejected_reason = $1, approved_by = $2, approved_at = $3, updated_at = $3
     WHERE sale_order_id = $4 AND store_id = $5 AND sale_order_type = '退款单' AND status = '待审批'`,
    [rejectedReason || '', ctx.auth.staffWfId, now, saleOrderId, ctx.auth.storeId]
  )
  if (result.rowCount === 0) throw new Error('INVALID_PARAMS: 退款单不存在或状态不允许驳回')

  ctx.result = { saleOrderId, status: '已关闭', message: '退款已驳回' }
}

// ========== P2: 回款单 ==========

/**
 * 创建回款单（店长专用）
 * payload: {
 *   refSaleOrderId: string,     // 原销售单号
 *   items: [{ saleItemId, repayAmount }],  // 需回款的明细行
 *   paymentMethod: '微信'|'线下'
 * }
 */
async function createRepayment(ctx) {
  await requireManager()(ctx, async () => {})

  const { refSaleOrderId, items, paymentMethod } = ctx.event.payload || {}
  const storeId = ctx.auth.storeId
  const marketName = ctx.auth.marketName || ''

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  if (!items || items.length === 0) throw new Error('INVALID_PARAMS: 回款明细不能为空')

  const origOrders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2",
    [refSaleOrderId, storeId]
  )
  if (origOrders.length === 0) throw new Error('INVALID_PARAMS: 原订单不存在')
  const origOrder = origOrders[0]

  let totalRepay = 0
  const repayItems = []
  for (const req of items) {
    const origItem = await pg.query(
      "SELECT * FROM sale_items WHERE sale_item_id = $1 AND sale_order_id = $2",
      [req.saleItemId, refSaleOrderId]
    )
    if (origItem.length === 0) throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 不存在`)
    const oi = origItem[0]
    const amount = Number(req.repayAmount) || 0
    if (amount <= 0) throw new Error('INVALID_PARAMS: 回款金额必须大于0')
    totalRepay += amount
    repayItems.push({
      refSaleItemId: req.saleItemId,
      skuId: oi.sku_id,
      productName: oi.product_name,
      skuSpecName: oi.sku_spec_name,
      productType: oi.product_type,
      unitPrice: amount,
      amount,
      salesCategory: oi.sales_category,
    })
  }

  const now = new Date()
  const repayOrderId = await generateOrderNo('FY-HKD-WX-')

  await pg.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')
    const maxResult = await client.query(
      `SELECT sale_item_id FROM sale_items WHERE sale_item_id LIKE $1 ORDER BY sale_item_id DESC LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )
    let seq = 1
    if (maxResult.rows.length > 0) seq = parseInt(maxResult.rows[0].sale_item_id.slice(-4)) + 1

    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, ref_sale_order_id,
        market_name, store_id, sale_order_datetime,
        client_user_id, client_phone, customer_name,
        total_amount, payment_method, opened_by,
        allocation_status, created_at, updated_at
      ) VALUES ($1, '待支付', '回款单', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '待分配', $6, $6)`,
      [
        repayOrderId, origOrder.document_type, refSaleOrderId, marketName, storeId, now,
        origOrder.client_user_id, origOrder.client_phone, origOrder.customer_name,
        totalRepay, paymentMethod || '线下', ctx.auth.staffWfId
      ]
    )

    for (let i = 0; i < repayItems.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = repayItems[i]
      // 回款单不产生新的服务次数消耗，service_fee 置 0，避免后续服务完成时重复计算手工费
      await client.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction, ref_sale_item_id,
          sku_id, product_name, sku_spec_name, product_type,
          unit_price, quantity, unit_real_price, sale_amount, received, sales_category,
          service_fee
        ) VALUES ($1, $2, $3, '购买', $4, $5, $6, $7, $8, $9, 1, $9, $9, $9, $10, 0)`,
        [
          saleItemId, repayOrderId, storeId, d.refSaleItemId,
          d.skuId, d.productName, d.skuSpecName, d.productType,
          d.amount, d.salesCategory
        ]
      )

      // 原子累加原明细行的 received
      await client.query(
        `UPDATE sale_items SET received = received::numeric + $1, updated_at = $2 WHERE sale_item_id = $3`,
        [d.amount, now, d.refSaleItemId]
      )
    }
  })

  ctx.result = { saleOrderId: repayOrderId, status: '待支付', totalAmount: totalRepay, message: '回款单已创建' }
}

// ========== P2: 转换单 ==========

/**
 * 创建转换单（店长专用）
 *
 * 与 admin 侧 createConversionOrder 语义对齐：
 *   - 按 client_user_id + store_id 跨订单聚合候选卡（不再绑定单一原订单）
 *   - 整张卡折抵（疗程卡全部 remaining_sessions / 单品体验卡全部剩余数量）
 *   - 差额>0：total_amount=差额，status 按支付方式（微信→待支付，线下→待确认收款）
 *   - 差额=0：total_amount=0，status=已支付
 *   - 差额<0：total_amount=0，status=已支付，差额充入 prepaid_cards（UPSERT user_id+store_id）+ INSERT card_transactions
 *   - 订单号前缀与 admin 对齐为 FY-XSD-WX-（admin 侧 createConversionOrder 使用同一前缀）
 *   - 跨店守卫：所有候选卡必须 store_id = ctx.auth.storeId
 *
 * payload: {
 *   clientUserId: string,              // 必须实名顾客（要挂储值卡）
 *   convertOutSaleItemIds: string[],   // 整张卡折抵，不带 qty
 *   convertInItems: [{ skuId, quantity }],
 *   paymentMethod: '微信' | '线下',
 *   preferredStaffWfId?: string,
 *   remark?: string
 * }
 */
async function createConversion(ctx) {
  await requireManager()(ctx, async () => {})

  const {
    clientUserId,
    convertOutSaleItemIds,
    convertInItems,
    paymentMethod,
    preferredStaffWfId,
    remark,
  } = ctx.event.payload || {}
  const storeId = ctx.auth.storeId
  const marketName = ctx.auth.marketName || ''

  if (!clientUserId) throw new Error('INVALID_PARAMS: 转换单必须指定顾客 clientUserId')
  if (!Array.isArray(convertOutSaleItemIds) || convertOutSaleItemIds.length === 0) {
    throw new Error('INVALID_PARAMS: 请选择至少一张折抵卡')
  }
  if (!Array.isArray(convertInItems) || convertInItems.length === 0) {
    throw new Error('INVALID_PARAMS: 请选择至少一个转入项目')
  }
  if (!paymentMethod || !['微信', '线下'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: paymentMethod 仅支持 微信/线下')
  }
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  // 查顾客快照信息（姓名 / phone）
  const clientRows = await pg.query(
    `SELECT user_id, phone, name, customer_type
     FROM client_wechat_users WHERE user_id = $1 LIMIT 1`,
    [clientUserId]
  )
  if (clientRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const client = clientRows[0]

  const now = new Date()
  const convOrderId = await generateOrderNo('FY-XSD-WX-')

  const result = await pg.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    // 1. 锁候选卡 FOR UPDATE（跨店守卫 + 状态/方向过滤 + 余量过滤）
    const heldResult = await tx.query(
      `SELECT si.sale_item_id,
              si.store_id,
              si.item_direction,
              si.sku_id,
              si.product_name,
              si.sku_spec_name,
              si.product_type,
              si.session_count,
              si.remaining_sessions,
              si.quantity,
              si.picked_up_quantity,
              si.unit_price,
              si.unit_real_price,
              si.sales_category,
              si.service_fee,
              so.client_user_id,
              so.status AS order_status,
              pc.product_kind
       FROM sale_items si
       JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
       LEFT JOIN product_skus ps ON si.sku_id = ps.sku_id
       LEFT JOIN product_categories pc ON ps.category_id = pc.category_id
       WHERE si.sale_item_id = ANY($1)
       FOR UPDATE OF si`,
      [convertOutSaleItemIds]
    )
    const held = heldResult.rows
    if (held.length !== convertOutSaleItemIds.length) {
      throw new Error('INVALID_PARAMS: 部分卡不属于当前门店或已耗尽')
    }

    let totalOut = 0
    const outItems = []
    for (const row of held) {
      // 归属校验
      if (row.store_id !== storeId) {
        throw new Error('INVALID_PARAMS: 部分卡不属于当前门店或已耗尽')
      }
      if (row.client_user_id !== clientUserId) {
        throw new Error('INVALID_PARAMS: 部分卡不属于该顾客')
      }
      if (row.item_direction !== '购买') {
        throw new Error('INVALID_PARAMS: 所选行非购买行，不可折抵')
      }
      if (row.order_status !== '已支付' && row.order_status !== '已完成') {
        throw new Error('INVALID_PARAMS: 原订单状态不允许转换')
      }

      const unit = Number(row.unit_real_price)
      const productType = row.product_type
      let qty = 0
      if (productType === '疗程卡') {
        const rem = Number(row.remaining_sessions || 0)
        if (rem <= 0) throw new Error('INVALID_PARAMS: 部分卡已耗尽')
        qty = rem
      } else if (productType === '单品' && row.product_kind === '体验卡') {
        const remQty = Number(row.quantity) - Number(row.picked_up_quantity || 0)
        if (remQty <= 0) throw new Error('INVALID_PARAMS: 部分卡已耗尽')
        qty = remQty
      } else {
        throw new Error('INVALID_PARAMS: 所选行类型不支持折抵')
      }

      const amount = Math.round(unit * qty * 100) / 100
      totalOut += amount

      // 按折抵数量占原单比例扣减 service_fee（转出行为负数）
      const origServiceFee = Number(row.service_fee || 0)
      const origQty = Number(row.quantity) || 1
      const outServiceFee = -Math.round((origServiceFee * qty / origQty) * 100) / 100

      outItems.push({
        refSaleItemId: row.sale_item_id,
        skuId: row.sku_id,
        productName: row.product_name,
        skuSpecName: row.sku_spec_name,
        productType,
        sessionCount: row.session_count != null ? Number(row.session_count) : null,
        unitPrice: Number(row.unit_price),
        unitRealPrice: unit,
        quantity: qty,
        amount,
        salesCategory: row.sales_category,
        serviceFee: outServiceFee,
      })
    }

    // 2. 转入项目 — 按 SKU 查询计价
    let totalIn = 0
    const inItems = []
    for (const req of convertInItems) {
      if (!req || !req.skuId) throw new Error('INVALID_PARAMS: 转入项目缺少 skuId')
      const skuRes = await tx.query(
        `SELECT s.sku_id, s.product_type, s.spec_name, s.price, s.session_count, s.service_fee,
                pc.sales_category
         FROM product_skus s
         JOIN product_categories pc ON s.category_id = pc.category_id
         WHERE s.sku_id = $1`,
        [req.skuId]
      )
      if (skuRes.rows.length === 0) throw new Error(`INVALID_PARAMS: SKU ${req.skuId} 不存在`)
      const sku = skuRes.rows[0]
      const qty = Number(req.quantity) || 1
      const amount = Math.round(Number(sku.price) * qty * 100) / 100
      totalIn += amount
      const inServiceFee = Math.round(Number(sku.service_fee || 0) * qty * 100) / 100
      inItems.push({
        skuId: sku.sku_id,
        productName: sku.spec_name,
        skuSpecName: sku.spec_name,
        productType: sku.product_type,
        sessionCount: sku.session_count != null ? Number(sku.session_count) : null,
        unitPrice: Number(sku.price),
        quantity: qty,
        amount,
        salesCategory: sku.sales_category,
        serviceFee: inServiceFee,
      })
    }

    const priceDiff = Math.round((totalIn - totalOut) * 100) / 100
    const orderTotal = Math.max(0, priceDiff)
    // 差额>0：按支付方式决定；其它：已支付
    const orderStatus = priceDiff > 0
      ? (paymentMethod === '线下' ? '待确认收款' : '待支付')
      : '已支付'

    // 3. document_type 快照：会员客 → 售后，否则按 totalIn 与阈值比较
    let documentType = client.customer_type === '会员客' ? '售后' : '售前'
    if (documentType === '售前') {
      const threshold = await getMemberThreshold()
      if (totalIn >= threshold) documentType = '售后'
    }

    // 4. 插入订单主表
    await tx.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type,
        market_name, store_id, sale_order_datetime,
        client_user_id, client_phone, customer_name,
        total_amount, payment_method, opened_by,
        preferred_employee_id, allocation_status, remark,
        paid_at, created_at, updated_at
      ) VALUES ($1, $2, '转换单', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '待分配', $14, $15, $6, $6)`,
      [
        convOrderId, orderStatus, documentType, marketName, storeId, now,
        clientUserId, client.phone || null, client.name || null,
        orderTotal.toFixed(2), paymentMethod, ctx.auth.staffWfId,
        preferredStaffWfId || null,
        remark || null,
        priceDiff > 0 ? null : now,
      ]
    )

    // 5. 生成 sale_item 流水号序列
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')
    const maxResult = await tx.query(
      `SELECT sale_item_id FROM sale_items WHERE sale_item_id LIKE $1
       ORDER BY sale_item_id DESC LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )
    let seq = 1
    if (maxResult.rows.length > 0) {
      seq = parseInt(maxResult.rows[0].sale_item_id.slice(-4)) + 1
    }

    // 6. 转出行 × N + 原子标记耗尽（疗程卡 remaining_sessions=0 / 单品 picked_up_quantity=quantity）
    for (const d of outItems) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq).padStart(4, '0')}`
      seq++
      await tx.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction, ref_sale_item_id,
          sku_id, product_name, sku_spec_name, product_type,
          session_count, unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee
        ) VALUES ($1, $2, $3, '转出', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          saleItemId, convOrderId, storeId, d.refSaleItemId,
          d.skuId, d.productName, d.skuSpecName, d.productType,
          d.sessionCount, d.unitPrice, d.quantity, d.unitRealPrice,
          -d.amount, -d.amount,
          d.salesCategory, d.serviceFee,
        ]
      )
      // 原子扣减原卡余量（幂等守卫：余量不足则 rowCount=0）
      if (d.productType === '疗程卡') {
        const upd = await tx.query(
          `UPDATE sale_items
             SET remaining_sessions = 0, updated_at = $1
           WHERE sale_item_id = $2
             AND store_id = $3
             AND COALESCE(remaining_sessions, 0) >= $4`,
          [now, d.refSaleItemId, storeId, d.quantity]
        )
        if (upd.rowCount === 0) {
          throw new Error('INVALID_PARAMS: 卡状态变化，请重试')
        }
      } else if (d.productType === '单品') {
        const upd = await tx.query(
          `UPDATE sale_items
             SET picked_up_quantity = quantity, updated_at = $1
           WHERE sale_item_id = $2
             AND store_id = $3
             AND (quantity - COALESCE(picked_up_quantity, 0)) >= $4`,
          [now, d.refSaleItemId, storeId, d.quantity]
        )
        if (upd.rowCount === 0) {
          throw new Error('INVALID_PARAMS: 卡状态变化，请重试')
        }
      }
    }

    // 7. 转入行 × M（新卡；unit_real_price = unit_price = sku.price 全价）
    for (const d of inItems) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq).padStart(4, '0')}`
      seq++
      await tx.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction,
          sku_id, product_name, sku_spec_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee
        ) VALUES ($1, $2, $3, '转入', $4, $5, $6, $7, $8, $8, $9, $10, $9, $11, $11, $12, $13)`,
        [
          saleItemId, convOrderId, storeId,
          d.skuId, d.productName, d.skuSpecName, d.productType,
          d.sessionCount,
          d.unitPrice, d.quantity, d.amount,
          d.salesCategory, d.serviceFee,
        ]
      )
    }

    // 8. 负差额 — UPSERT prepaid_cards + INSERT card_transactions（type='充值'）
    let prepaidCardCredit = 0
    if (priceDiff < 0) {
      const creditAmount = Math.round(Math.abs(priceDiff) * 100) / 100
      prepaidCardCredit = creditAmount

      const upsert = await tx.query(
        `INSERT INTO prepaid_cards (card_id, user_id, store_id, balance)
         VALUES (gen_random_uuid()::text, $1, $2, $3)
         ON CONFLICT (user_id, store_id) DO UPDATE
           SET balance = prepaid_cards.balance + EXCLUDED.balance,
               updated_at = NOW()
         RETURNING card_id`,
        [clientUserId, storeId, creditAmount.toFixed(2)]
      )
      const cardId = upsert.rows[0]?.card_id
      if (!cardId) throw new Error('INVALID_PARAMS: 储值卡入账失败，请稍后重试')

      await tx.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id)
         VALUES ($1, '充值', $2, $3)`,
        [cardId, creditAmount.toFixed(2), convOrderId]
      )
    }

    return { totalIn, totalOut, priceDiff, orderStatus, prepaidCardCredit }
  })

  ctx.result = {
    saleOrderId: convOrderId,
    status: result.orderStatus,
    totalIn: Math.round(result.totalIn * 100) / 100,
    totalOut: Math.round(result.totalOut * 100) / 100,
    priceDiff: result.priceDiff,
    prepaidCardCredit: result.prepaidCardCredit,
    message: '转换单已创建',
  }
}

/**
 * 查询顾客在当前门店可折抵的卡（转换单备选）
 *
 * payload: { clientUserId: string }
 * 返回: { cards: [{ saleItemId, sourceSaleOrderId, productName, skuSpecName, productType,
 *                    remainingSessions, remainingQuantity, unitRealPrice, deductibleAmount }] }
 *
 * 口径与 admin getCustomerHeldCards 保持一致：
 *   - 疗程卡：product_type='疗程卡' AND remaining_sessions > 0
 *   - 体验卡单品：product_type='单品' AND pc.product_kind='体验卡' AND (quantity - picked_up_quantity) > 0
 */
async function customerHeldCards(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId } = ctx.event.payload || {}
  const storeId = ctx.auth.storeId
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  const rows = await pg.query(
    `SELECT si.sale_item_id,
            si.sale_order_id AS source_sale_order_id,
            si.product_name,
            si.sku_spec_name,
            si.product_type,
            si.remaining_sessions,
            (si.quantity - COALESCE(si.picked_up_quantity, 0)) AS remaining_quantity,
            si.unit_real_price,
            CASE
              WHEN si.product_type = '疗程卡'
                THEN si.unit_real_price * COALESCE(si.remaining_sessions, 0)
              WHEN si.product_type = '单品' AND pc.product_kind = '体验卡'
                THEN si.unit_real_price * (si.quantity - COALESCE(si.picked_up_quantity, 0))
              ELSE 0
            END AS deductible_amount
     FROM sale_items si
     JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
     LEFT JOIN product_skus ps ON si.sku_id = ps.sku_id
     LEFT JOIN product_categories pc ON ps.category_id = pc.category_id
     WHERE so.client_user_id = $1
       AND si.store_id = $2
       AND si.item_direction = '购买'
       AND so.status IN ('已支付', '已完成')
       AND (
            (si.product_type = '疗程卡' AND COALESCE(si.remaining_sessions, 0) > 0)
         OR (si.product_type = '单品' AND pc.product_kind = '体验卡'
              AND (si.quantity - COALESCE(si.picked_up_quantity, 0)) > 0)
       )
     ORDER BY si.sale_order_id DESC`,
    [clientUserId, storeId]
  )

  ctx.result = {
    cards: rows.map(r => ({
      saleItemId: r.sale_item_id,
      sourceSaleOrderId: r.source_sale_order_id,
      productName: r.product_name,
      skuSpecName: r.sku_spec_name,
      productType: r.product_type,
      remainingSessions: r.remaining_sessions != null ? Number(r.remaining_sessions) : null,
      remainingQuantity: r.remaining_quantity != null ? Number(r.remaining_quantity) : null,
      unitRealPrice: String(r.unit_real_price),
      deductibleAmount: Number(r.deductible_amount).toFixed(2),
    }))
  }
}

// ========== P2: 取货单 ==========

/**
 * 创建取货记录（院装产品提货）
 * payload: { saleItemId, pickupQuantity, remark? }
 */
async function createPickup(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { saleItemId, pickupQuantity, remark } = ctx.event.payload || {}
  if (!saleItemId) throw new Error('INVALID_PARAMS: 缺少 saleItemId')
  if (!pickupQuantity || pickupQuantity <= 0) throw new Error('INVALID_PARAMS: 取货数量必须大于0')

  // 原子累加 picked_up_quantity（强制本店）
  const result = await pg.query(
    `UPDATE sale_items
     SET picked_up_quantity = COALESCE(picked_up_quantity, 0) + $1, updated_at = NOW()
     WHERE sale_item_id = $2
       AND store_id = $3
       AND product_type = '院装产品'
       AND (COALESCE(picked_up_quantity, 0) + $1) <= quantity
     RETURNING sale_item_id, quantity, picked_up_quantity`,
    [pickupQuantity, saleItemId, ctx.auth.storeId]
  )

  if (result.rowCount === 0) {
    // 区分跨店 / 已提满 / 类型错误三种失败
    const probe = await pg.query(
      `SELECT store_id, product_type, quantity, COALESCE(picked_up_quantity, 0) AS picked_up_quantity
       FROM sale_items WHERE sale_item_id = $1`,
      [saleItemId]
    )
    const row = probe[0]
    if (!row) throw new Error('INVALID_PARAMS: 商品不存在')
    if (row.store_id !== ctx.auth.storeId) {
      throw new Error(`INVALID_PARAMS: 该商品仅在 ${row.store_id} 可提货，当前门店无法操作`)
    }
    if (row.product_type !== '院装产品') {
      throw new Error('INVALID_PARAMS: 该商品类型不支持提货')
    }
    throw new Error('INVALID_PARAMS: 取货数量超出可提货数量')
  }

  // 查顾客信息
  const itemRows = await pg.query(
    `SELECT si.sale_order_id, o.client_user_id
     FROM sale_items si JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
     WHERE si.sale_item_id = $1`,
    [saleItemId]
  )
  const clientUserId = itemRows.length > 0 ? itemRows[0].client_user_id : null

  // 插入提货记录
  await pg.query(
    `INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, client_user_id, confirmed_by, remark)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [saleItemId, pickupQuantity, ctx.auth.storeId, clientUserId, ctx.auth.staffWfId, remark || null]
  )

  const updated = result.rows ? result.rows[0] : result[0]
  ctx.result = {
    saleItemId,
    pickedUp: updated.picked_up_quantity,
    total: updated.quantity,
    remaining: updated.quantity - updated.picked_up_quantity,
    message: '取货成功',
  }
}

// ========== 辅助函数 ==========

/**
 * 生成订单号
 * @param prefix 前缀，如 'FY-XSD-WX-', 'FY-TKD-WX-' 等
 */
async function generateOrderNo(prefix) {
  if (!prefix) prefix = 'FY-XSD-WX-'
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')

  const likePattern = `${prefix}${dateStr}%`
  // 使用 advisory lock 防止并发生成重复订单号（与 admin orders.ts 对齐：hashtext('sale_order_id_gen')）
  const result = await pg.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])
    const rows = await client.query(`
      SELECT sale_order_id FROM sale_orders
      WHERE sale_order_id LIKE $1
      ORDER BY sale_order_id DESC LIMIT 1
    `, [likePattern])
    let seq = 1
    if (rows.rows.length > 0) {
      seq = parseInt(rows.rows[0].sale_order_id.slice(-4)) + 1
    }
    return `${prefix}${dateStr}${String(seq).padStart(4, '0')}`
  })

  return result
}

module.exports = {
  create,
  qrcode,
  confirmOffline,
  close,
  resetFailed,
  list,
  detail,
  createRefund,
  approveRefund,
  rejectRefund,
  createRepayment,
  createConversion,
  customerHeldCards,
  createPickup,
}
