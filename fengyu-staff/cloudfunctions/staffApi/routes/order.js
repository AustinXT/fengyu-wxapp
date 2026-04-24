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
const { RECHARGE_VIRTUAL_SKU_ID } = require('../utils/recharge')
const { settlePointsSafe } = require('../utils/points')
const {
  buildRefundDetails,
  splitRefundByOriginalPayment,
  resolveRefundPaymentMethod,
} = require('../utils/refund')

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
    remark: orderRemark,
    useCard,
    prepaidCardAmount: inputPrepaidCardAmount,
    receivedAmount: inputReceivedAmount,
  } = payload

  const storeId = ctx.auth.effectiveStoreId
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
  // '无' 值由后端在 paid_amount=0 时强制覆盖，前端传值暂仅允许 微信/线下
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

  // 查询顾客是否已注册客户端小程序并绑定门店
  const clientUsers = await pg.query(
    'SELECT user_id, bound_store_id FROM client_wechat_users WHERE phone = $1 LIMIT 1',
    [clientPhone]
  )
  if (clientUsers.length === 0 || !clientUsers[0].bound_store_id) {
    throw new Error('CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店')
  }
  const clientUserId = clientUsers[0].user_id

  // 检查是否已有待支付订单
  const existing = await pg.query(
    "SELECT sale_order_id FROM sale_orders WHERE client_user_id = $1 AND status = '待支付' LIMIT 1",
    [clientUserId]
  )
  if (existing.length > 0) {
    throw new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
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
  const totalAmount = Math.round(itemDataList.reduce((sum, d) => sum + d.received, 0) * 100) / 100

  // ========== 储值卡预选（店长开单 = 预选，不扣卡）==========
  // 查询顾客当前余额（不加 FOR UPDATE，因为不写 balance）；仅店长预选为参考
  let prepaidCardAmount = 0
  if (useCard) {
    const balanceRows = await pg.query(
      'SELECT balance FROM prepaid_cards WHERE user_id = $1',
      [clientUserId]
    )
    const currentBalance = balanceRows.length > 0 ? Number(balanceRows[0].balance) : 0

    // 计算预选额上限 = totalAmount（优惠券已在 received 中扣除）
    const maxPrepayable = totalAmount

    if (inputPrepaidCardAmount !== undefined && inputPrepaidCardAmount !== null) {
      const inputAmount = Number(inputPrepaidCardAmount)
      if (!Number.isFinite(inputAmount) || inputAmount < 0) {
        throw new Error('INVALID_PARAMS: prepaidCardAmount 必须为非负数')
      }
      if (inputAmount > currentBalance) {
        throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
      }
      if (inputAmount > maxPrepayable) {
        throw new Error('INVALID_PARAMS: prepaidCardAmount 超过应抵上限')
      }
      prepaidCardAmount = Math.round(inputAmount * 100) / 100
    } else {
      // 未显式传值：默认"能抵多少抵多少"
      prepaidCardAmount = Math.min(currentBalance, maxPrepayable)
      prepaidCardAmount = Math.round(prepaidCardAmount * 100) / 100
    }
  }

  // ========== PR-2: 款项流水（sale_order_payments）语义 ==========
  // payable_amount = total - prepaid_card_amount（扣卡后的"应付现金金额"冗余列）
  const payableAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100

  // receivedAmount（本次现场实收）——
  //   - 线下/储值卡/无：默认 payable_amount（保持全额现场收款回归行为）
  //   - 微信/支付宝：默认 0（真正入账由后续 pay/alipayPay 回调写 payments 行，staff 侧 create 不写流水）
  // 校验：0 <= receivedAmount <= payable_amount
  //      线上（微信/支付宝）禁止非零 receivedAmount（MIXED_PAYMENT_NOT_SUPPORTED）
  const isOnlineMethod = paymentMethod === '微信' || paymentMethod === '支付宝'
  let receivedAmount
  if (inputReceivedAmount === undefined || inputReceivedAmount === null) {
    receivedAmount = isOnlineMethod ? 0 : payableAmount
  } else {
    receivedAmount = Number(inputReceivedAmount)
    if (!Number.isFinite(receivedAmount) || receivedAmount < 0) {
      throw new Error('INVALID_PARAMS: receivedAmount 必须为非负数')
    }
    if (receivedAmount > payableAmount + 0.001) {
      throw new Error('INVALID_PARAMS: receivedAmount 不能超过应付金额')
    }
    receivedAmount = Math.round(receivedAmount * 100) / 100
  }
  if (isOnlineMethod && receivedAmount > 0) {
    throw new Error('INVALID_PARAMS:MIXED_PAYMENT_NOT_SUPPORTED: 微信/支付宝不支持部分线上支付，请改用线下或先下单后扫码')
  }

  // 落账部分（paid_amount 快照）：
  //   线下/储值卡/无 → 本次现场实收 = receivedAmount（立即落"已支付"payments 行）
  //   微信/支付宝    → 0（create 不写 payments，由后续回调写入）
  const paidAmount = isOnlineMethod ? 0 : receivedAmount

  // effectivePaymentMethod 仅影响 sale_orders.payment_method 展示（与原逻辑对齐）：
  //   - 储值卡全额抵扣（payable_amount=0，即 prepaid=total）→ '无'（现金通道无需使用）
  //   - 其他：保留前端传入的 paymentMethod
  let effectivePaymentMethod
  if (payableAmount === 0 && prepaidCardAmount > 0) {
    effectivePaymentMethod = '无'
  } else {
    effectivePaymentMethod = paymentMethod
  }

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

    // ========== PR-2 状态机落地 ==========
    // 线上支付（微信/支付宝）保留原 '待支付'（不写 payments，等 pay/alipayPay 回调）
    // 线下/储值卡/无：按 paid + prepaid 与 total 的比较落地
    //   paid + prepaid == 0                    → '待支付'（纯挂账，无 payments 行）
    //   0 < paid + prepaid < total_amount      → '部分支付'
    //   paid + prepaid == total_amount         → '待确认收款'（店长二次确认 → confirmOffline 转 '已支付'；
    //                                              保留原 staff 流程：全额现场收款不跳过确认步骤）
    const settledAmount = Math.round((paidAmount + prepaidCardAmount) * 100) / 100
    let initialStatus
    if (isOnlineMethod) {
      initialStatus = '待支付'
    } else if (settledAmount === 0) {
      initialStatus = '待支付'
    } else if (settledAmount + 0.001 < totalAmount) {
      initialStatus = '部分支付'
    } else {
      initialStatus = '待确认收款'
    }
    // paid_at 语义：payments 行已支付即"有钱到账"时间，冗余到 sale_orders.paid_at；
    // 挂账订单无入账 → NULL。'待确认收款' 订单 payments 已写'已支付'，paid_at 可落 now。
    const paidAtValue = paidAmount > 0 ? now : null
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id,
        sale_order_datetime, total_amount, client_user_id, client_phone, customer_name,
        payment_method, opened_by,
        preferred_employee_id, coupon_id, coupon_discount, remark,
        prepaid_card_amount, paid_amount, payable_amount, paid_at,
        created_at, updated_at
      ) VALUES ($1, $17, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $18, $19, $20, $21, $6, $6)`,
      [
        saleOrderId, saleOrderType, documentType, marketName, storeId, now,
        totalAmount, clientUserId, clientPhone, clientName,
        effectivePaymentMethod, ctx.auth.staffWfId,
        preferredStaffWfId || null,
        inputCouponId || null, couponDiscount,
        orderRemark || null,
        initialStatus,
        prepaidCardAmount, paidAmount, payableAmount,
        paidAtValue,
      ]
    )

    // ========== PR-2 写 sale_order_payments 流水 ==========
    // 规则：
    //   - 线下/储值卡/无（!isOnlineMethod） + paidAmount > 0 → 写 1 行 payments change_type='首次支付' status='已支付'
    //     （paidAmount 是本次现场现金入账部分，立即落"已支付"流水）
    //   - 线下/储值卡/无 + paidAmount = 0 → 无 payments 行（纯挂账，或全额储值卡抵扣订单由 confirmOffline 扣卡+写流水）
    //   - 微信/支付宝（isOnlineMethod）：sale_orders 停在 '待支付'，payments 行由 payNotify 回调写入
    //
    // 储值卡抵扣：prepaid_card_amount 写入 sale_orders 作为"预选"金额；
    //   扣卡余额 + 写 '储值卡抵扣' payments 行统一由 confirmOffline 执行（staffApi 唯一扣卡点，
    //   见 fengyu-staff/CLAUDE.md）。
    if (!isOnlineMethod && paidAmount > 0) {
      await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at, paid_at
        ) VALUES ($1, '首次支付', $2, $3, NULL, '已支付', 'staff', $4, $5, $6, $6)`,
        [saleOrderId, paidAmount, paymentMethod, ctx.auth.staffWfId, '店长开单现场收款', now]
      )
    }

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

  // PR-2: status 与事务内 initialStatus 决策树保持一致
  //   线上 → '待支付'；paid+prepaid=0 → '待支付'；部分 → '部分支付'；全额 → '待确认收款'
  const resolvedSettled = Math.round((paidAmount + prepaidCardAmount) * 100) / 100
  let resolvedStatus
  if (isOnlineMethod) {
    resolvedStatus = '待支付'
  } else if (resolvedSettled === 0) {
    resolvedStatus = '待支付'
  } else if (resolvedSettled + 0.001 < totalAmount) {
    resolvedStatus = '部分支付'
  } else {
    resolvedStatus = '待确认收款'
  }

  ctx.result = {
    saleOrderId,
    totalAmount,
    payableAmount,
    couponDiscount,
    prepaidCardAmount,
    paidAmount,
    receivedAmount,
    paymentMethod: effectivePaymentMethod,
    status: resolvedStatus,
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
  if (!ctx.auth.roles.includes('manager') && order.store_id !== ctx.auth.effectiveStoreId) {
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
  const inputConfirmAmount = payload.confirmAmount
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  const orders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2",
    [saleOrderId, ctx.auth.effectiveStoreId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在或不属于本门店')
  }

  const order = orders[0]

  if (order.status === '待支付' && order.payment_method !== '线下') {
    throw new Error(`INVALID_PARAMS: 非线下支付订单不可直接确认收款`)
  }
  // PR-2: 允许对 '待支付' / '待确认收款' / '部分支付' 订单确认收款
  if (!['待确认收款', '待支付', '部分支付'].includes(order.status)) {
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

  // ========== PR-2: 本次确认收款金额 + 目标订单状态 ==========
  // confirmAmount 默认 = 剩余应付现金 = payable_amount - 当前 paid_amount
  // payable_amount 旧订单可能 NULL，这里用 total - prepaid 兜底
  const orderTotal = Number(order.total_amount || 0)
  const orderPrepaid = Number(order.prepaid_card_amount || 0)
  const orderPaid = Number(order.paid_amount || 0)
  const orderPayable = order.payable_amount != null
    ? Number(order.payable_amount)
    : Math.round((orderTotal - orderPrepaid) * 100) / 100
  const remainingPayable = Math.round((orderPayable - orderPaid) * 100) / 100

  let confirmAmount
  if (inputConfirmAmount === undefined || inputConfirmAmount === null) {
    confirmAmount = remainingPayable
  } else {
    confirmAmount = Number(inputConfirmAmount)
    if (!Number.isFinite(confirmAmount) || confirmAmount < 0) {
      throw new Error('INVALID_PARAMS: confirmAmount 必须为非负数')
    }
    if (confirmAmount > remainingPayable + 0.001) {
      throw new Error('INVALID_PARAMS: confirmAmount 不能超过剩余应付金额')
    }
    confirmAmount = Math.round(confirmAmount * 100) / 100
  }

  const newPaidAmount = Math.round((orderPaid + confirmAmount) * 100) / 100
  const newSettled = Math.round((newPaidAmount + orderPrepaid) * 100) / 100
  // paid + prepaid >= total → '已支付'，否则 '部分支付'
  const targetStatus = newSettled + 0.001 >= orderTotal ? '已支付' : '部分支付'

  // 仅在本次"确认现金到账"(confirmAmount > 0) 时写 payments 行
  // 已有 payments 则本次为"回款"，否则为"首次支付"
  let paymentChangeType = null
  if (confirmAmount > 0) {
    const existingPaymentsRow = await pg.query(
      `SELECT 1 FROM sale_order_payments
       WHERE sale_order_id = $1 AND status = '已支付'
         AND change_type IN ('首次支付','回款','退款')
       LIMIT 1`,
      [saleOrderId]
    )
    paymentChangeType = existingPaymentsRow.length > 0 ? '回款' : '首次支付'
  }

  await pg.transaction(async (client) => {
    // ========== 储值卡扣款（staffApi 唯一扣卡点）==========
    // 预选值 > 0 且顾客已注册时，事务内锁余额 + 扣减 + 写 card_transactions + 写 '储值卡抵扣' payments 行
    // （create 时 sale_orders.prepaid_card_amount 仅作为"预选"金额，此处才真正入账）
    const prepaidAmount = Number(order.prepaid_card_amount || 0)
    if (prepaidAmount > 0 && order.client_user_id) {
      // 幂等：已扣过则跳过扣卡 + payments（用 card_transactions.ref_order_id 判定）
      const dupCheck = await client.query(
        `SELECT 1 FROM card_transactions
         WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
        [saleOrderId]
      )
      if (dupCheck.rows.length === 0) {
        const balRes = await client.query(
          'SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE',
          [order.client_user_id]
        )
        if (balRes.rows.length === 0) {
          throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
        }
        const currentBalance = Number(balRes.rows[0].balance)
        if (currentBalance < prepaidAmount) {
          throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
        }
        const cardId = balRes.rows[0].card_id
        await client.query(
          `UPDATE prepaid_cards
           SET balance = balance - $1, updated_at = NOW()
           WHERE card_id = $2`,
          [prepaidAmount, cardId]
        )
        await client.query(
          `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
           VALUES ($1, '扣款', $2, $3, NOW())`,
          [cardId, -prepaidAmount, saleOrderId]
        )
        // 同事务写 '储值卡抵扣' payments 行（扣卡与流水同发生）
        await client.query(
          `INSERT INTO sale_order_payments (
            sale_order_id, change_type, amount, payment_method, external_txn_id,
            status, source_end, operator_employee_id, note, created_at, paid_at
          ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'staff', $3, $4, $5, $5)`,
          [saleOrderId, prepaidAmount, ctx.auth.staffWfId, '店长确认线下收款-储值卡抵扣', now]
        )
      }
    }

    // ========== PR-2: 插入 payments 流水 + 更新 sale_orders ==========
    // 事务内单调递增 paid_amount、按决策树决定 status
    // C4 合规：WHERE 锁定当前状态防止并发竞态
    //
    // paid_at 语义：
    //   - 目标状态 '已支付' → 设为本次确认时间（作为"最后一次到账时间"快照）
    //   - 目标状态 '部分支付' → 保留原值（若原为 NULL 则继续 NULL）
    const paidAtValue = targetStatus === '已支付' ? now : (order.paid_at || null)
    const updateResult = await client.query(
      `UPDATE sale_orders
       SET status = $1, paid_amount = $2, paid_at = $3, updated_at = $4,
           offline_confirmed_by = $5, offline_confirmed_at = $4,
           allocation_status = CASE WHEN allocation_status = '已分配' THEN '已分配' ELSE '待分配' END
       WHERE sale_order_id = $6 AND status = $7`,
      [targetStatus, newPaidAmount, paidAtValue, now, ctx.auth.staffWfId, saleOrderId, order.status]
    )
    if (updateResult.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 订单状态已变更，请刷新后重试')
    }

    if (confirmAmount > 0) {
      await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at, paid_at
        ) VALUES ($1, $2, $3, '线下', NULL, '已支付', 'staff', $4, $5, $6, $6)`,
        [saleOrderId, paymentChangeType, confirmAmount, ctx.auth.staffWfId, '店长确认线下收款', now]
      )
    }

    // 单品到期日写入（paid_at + 1年）——仅在本次转为 '已支付' 时触发
    if (targetStatus === '已支付') {
      await client.query(
        `UPDATE sale_items
         SET expire_date = ($1::date + INTERVAL '1 year')
         WHERE sale_order_id = $2
           AND product_type = '单品'
           AND expire_date IS NULL`,
        [now, saleOrderId]
      )
    }

    // 充值卡入账：识别明细中 product_kind='充值卡' 的行，统一 UPSERT prepaid_cards
    // - 虚拟 SKU（自定义金额路径）：面值从 product_name 的 "¥{n}" 解析
    // - 真实档位 SKU：面值从 product_skus.price 读取
    // 与 clientApi payNotify 侧的识别逻辑对称，二者均以 (ref_order_id) 幂等。
    // 2026-04-24 schema 变更：UNIQUE(user_id)，一户一账户，跨店共享，INSERT 列集不含 store_id。
    // PR-2: 仅在本次转为 '已支付' 时触发充值卡入账（部分支付尚未全额结清）
    if (targetStatus === '已支付' && order.client_user_id) {
      const rechargeRows = await client.query(
        `SELECT si.sku_id, si.product_name, sk.price AS sku_price
         FROM sale_items si
         LEFT JOIN product_skus sk ON si.sku_id = sk.sku_id
         LEFT JOIN product_categories pc ON sk.category_id = pc.category_id
         WHERE si.sale_order_id = $1 AND pc.product_kind = '充值卡'`,
        [saleOrderId]
      )
      if (rechargeRows.rows.length > 0) {
        const dupCheck = await client.query(
          `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
          [saleOrderId]
        )
        if (dupCheck.rows.length === 0) {
          for (const row of rechargeRows.rows) {
            let faceValue
            if (row.sku_id === RECHARGE_VIRTUAL_SKU_ID) {
              const m = (row.product_name || '').match(/¥\s*(\d+(?:\.\d+)?)/)
              if (!m) {
                throw new Error(`[confirmOffline] 充值订单 product_name 无法解析面值: ${row.product_name}`)
              }
              faceValue = parseFloat(m[1])
            } else {
              faceValue = Number(row.sku_price)
            }
            if (!(faceValue > 0)) continue

            const newCardId = `FY-CARD-${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`
            const upsertRes = await client.query(
              `INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW())
               ON CONFLICT (user_id) DO UPDATE
                 SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
               RETURNING card_id`,
              [newCardId, order.client_user_id, faceValue]
            )
            const cardId = upsertRes.rows[0].card_id
            await client.query(
              `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
               VALUES ($1, '充值', $2, $3, NOW())`,
              [cardId, faceValue, saleOrderId]
            )
          }
        }
      }
    }

    // 重算顾客历史消费档位
    await refreshSpendingTier(client, order.client_user_id)
    // 重算顾客类型（只升不降）
    await recalcCustomerType(client, order.client_user_id)

    // 积分结算（订单链净额差值法，幂等）
    // confirmOffline 是店长确认线下收款的"状态转已支付/部分支付"入口（AC-04）；
    // 部分支付时 paid_amount 已累加，也要调用 settle 保持链上积分与实到账同步
    await settlePointsSafe(client, saleOrderId, 'staffApi.confirmOffline')
  })

  ctx.result = {
    saleOrderId,
    status: targetStatus,
    paidAt: targetStatus === '已支付' ? now : (order.paid_at || null),
    paidAmount: newPaidAmount,
    confirmAmount,
    remainingPayable: Math.round((orderPayable - newPaidAmount) * 100) / 100,
    totalReceived,
    message: targetStatus === '已支付' ? '线下收款已确认' : '已确认本次收款（订单仍部分支付）'
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
    [saleOrderId, ctx.auth.effectiveStoreId]
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
    [saleOrderId, ctx.auth.effectiveStoreId]
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

  const params = [ctx.auth.effectiveStoreId, pageSize, offset]
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
      o.paid_at, o.created_at, o.opened_by, o.total_amount,
      EXISTS(
        SELECT 1 FROM sale_orders tkd
        WHERE tkd.ref_sale_order_id = o.sale_order_id
          AND tkd.sale_order_type = '退款单'
          AND tkd.status = '已支付'
      ) AS has_refund,
      EXISTS(
        SELECT 1 FROM sale_orders tkd
        WHERE tkd.ref_sale_order_id = o.sale_order_id
          AND tkd.sale_order_type = '退款单'
          AND tkd.status = '待审批'
      ) AS has_pending_refund
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
    [saleOrderId, ctx.auth.effectiveStoreId]
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

  // 款项流水（Ticket 2 PR-A：订单详情页展示 / 回款弹层读取欠款）
  // 仅对"销售单"读流水；回款单/退款单/转换单等凭证单的流水挂在其 ref 原单上
  const paymentRows = await pg.query(
    `SELECT change_type, amount, payment_method, status, paid_at, created_at, note
     FROM sale_order_payments
     WHERE sale_order_id = $1
     ORDER BY created_at ASC, id ASC`,
    [saleOrderId]
  )
  const payments = paymentRows.map(p => ({
    change_type: p.change_type,
    amount: Number(p.amount),
    payment_method: p.payment_method,
    status: p.status,
    paid_at: p.paid_at,
    created_at: p.created_at,
    note: p.note,
  }))

  ctx.result = {
    order: { ...order, coupon_name: couponName },
    items,
    allocations,
    payments,
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
  const storeId = ctx.auth.effectiveStoreId
  const marketName = ctx.auth.marketName || ''

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  if (!items || !Array.isArray(items) || items.length === 0) throw new Error('INVALID_PARAMS: 退款明细不能为空')
  if (!refundReason) throw new Error('INVALID_PARAMS: 退款原因不能为空')

  // 查原单
  const origOrders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2 AND status IN ('已支付', '已完成', '部分支付')",
    [refSaleOrderId, storeId]
  )
  if (origOrders.length === 0) throw new Error('INVALID_PARAMS: 原订单不存在或状态不允许退款')
  const origOrder = origOrders[0]

  // in-flight 唯一性：同一原单仅允许一笔 '待审批' 退款单
  const inflightRefunds = await pg.query(
    "SELECT sale_order_id FROM sale_orders WHERE ref_sale_order_id = $1 AND sale_order_type = '退款单' AND status = '待审批' LIMIT 1",
    [refSaleOrderId]
  )
  if (inflightRefunds.length > 0) {
    throw new Error('CONFLICT: 存在未完结退款单')
  }

  // 查原单明细（构建 + 校验未使用数量）
  const origItems = await pg.query(
    "SELECT * FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'",
    [refSaleOrderId]
  )

  // 校验并构建退款明细（按 product_type 判断未使用数量，超额自动 throw INVALID_STATE）
  const { refundDetails, totalRefund } = buildRefundDetails(origItems, items)

  const fee = Number(handlingFee) || 0
  const finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
  if (finalRefundAmount <= 0) {
    throw new Error('INVALID_STATE: 无可退项')
  }

  // 退款凭证单 total_amount = -(totalRefund - fee)（保持现有语义：sale_items 汇总与 fee 的差即 handling_fee）
  const totalAmount = -finalRefundAmount

  // 预算储值卡 vs 原路径拆分（算法与 approveRefund 保持一致，审批时直接复用）
  const origPrepaidCardAmount = Number(origOrder.prepaid_card_amount || 0)
  const origTotalAmount = Number(origOrder.total_amount || 0)
  const { refundByCard, refundByOrigin } = splitRefundByOriginalPayment(
    finalRefundAmount,
    origPrepaidCardAmount,
    origTotalAmount,
  )

  // 退款原通道（微信/支付宝过渡期映射为 '线下'，下一 ticket 集成三方 refund API 后改）
  const refundPaymentMethod = resolveRefundPaymentMethod(origOrder.payment_method)

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

    // 创建退款凭证单（FY-TKD）
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

    // 创建退款明细行（挂在 FY-TKD 凭证单）
    for (let i = 0; i < refundDetails.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = refundDetails[i]
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

    // 写 payments 退款行（挂在原销售单上，status='待支付'，待 approveRefund 翻转为 '已支付'）
    // 拆分规则：储值卡部分 + 原路径部分；两行合计 = finalRefundAmount
    const paymentNote = `FY-TKD=${refundOrderId}; reason=${refundReason}` + (fee > 0 ? `; fee=${fee}` : '')
    if (refundByCard > 0) {
      await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at
        ) VALUES ($1, '退款', $2, '储值卡', NULL, '待支付', 'staff', $3, $4, $5)`,
        [refSaleOrderId, -refundByCard, ctx.auth.staffWfId, paymentNote, now]
      )
    }
    if (refundByOrigin > 0) {
      await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at
        ) VALUES ($1, '退款', $2, $3::payment_method, NULL, '待支付', 'staff', $4, $5, $6)`,
        [refSaleOrderId, -refundByOrigin, refundPaymentMethod, ctx.auth.staffWfId, paymentNote, now]
      )
    }
  })

  ctx.result = {
    saleOrderId: refundOrderId,
    status: '待审批',
    totalAmount,
    refundByCard,
    refundByOrigin,
    finalRefundAmount,
    message: '退款单已创建',
  }
}

/**
 * 审批退款单（店长专用）
 *
 * 幂等设计：事务开头先 UPDATE FY-TKD status '待审批'→'已支付'，rowCount=0 即 throw，
 * 保证仅首次调用进入后续副作用（扣减 remaining_sessions / 储值卡回冲 / UPDATE payments）。
 *
 * 退款拆分规则（与 createRefund 一致）：
 *   refundByCard   = floor(origPrepaidCardAmount / origTotalAmount × refundAmount, 2)
 *   refundByOrigin = refundAmount - refundByCard   // 反向相减，无尾差
 */
async function approveRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { saleOrderId } = ctx.event.payload || {}
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')

  const orders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2 AND sale_order_type = '退款单' AND status = '待审批'",
    [saleOrderId, ctx.auth.effectiveStoreId]
  )
  if (orders.length === 0) throw new Error('INVALID_PARAMS: 退款单不存在或状态不允许审批')

  const refundOrder = orders[0]
  const refSaleOrderId = refundOrder.ref_sale_order_id
  const now = new Date()

  // 读被退原单的 prepaid_card_amount / total_amount（正数）
  let origPrepaidCardAmount = 0
  let origTotalAmount = 0
  if (refSaleOrderId) {
    const origRows = await pg.query(
      'SELECT prepaid_card_amount, total_amount FROM sale_orders WHERE sale_order_id = $1',
      [refSaleOrderId]
    )
    if (origRows.length > 0) {
      origPrepaidCardAmount = Number(origRows[0].prepaid_card_amount || 0)
      origTotalAmount = Number(origRows[0].total_amount || 0)
    }
  }

  // 退款金额（正数）：退款单 total_amount 为负数
  const refundAmount = Math.abs(Number(refundOrder.total_amount || 0))
  const { refundByCard, refundByOrigin } = splitRefundByOriginalPayment(
    refundAmount,
    origPrepaidCardAmount,
    origTotalAmount,
  )

  await pg.transaction(async (client) => {
    // 幂等哨兵：先翻转 FY-TKD 状态，rowCount=0 说明已被其他并发调用处理
    const updateResult = await client.query(
      `UPDATE sale_orders
         SET status = '已支付', paid_at = $1, approved_by = $2, approved_at = $1,
             allocation_status = '待分配',
             prepaid_card_amount = $4, paid_amount = $5,
             updated_at = $1
       WHERE sale_order_id = $3 AND status = '待审批'`,
      [now, ctx.auth.staffWfId, saleOrderId, -refundByCard, -refundByOrigin]
    )
    if (updateResult.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 退款单状态已变更，请刷新后重试')
    }

    // 查退款明细（refund_out 行），原子扣减原购买行 remaining_sessions
    const refundItemsRes = await client.query(
      "SELECT * FROM sale_items WHERE sale_order_id = $1 AND item_direction = '退出'",
      [saleOrderId]
    )

    for (const ri of refundItemsRes.rows) {
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

    // 储值卡部分退款：回冲 balance + INSERT card_transactions(type='充值')
    // 幂等守卫：以 ref_order_id=退款单ID + type='充值' 去重
    if (refundByCard > 0 && refundOrder.client_user_id) {
      const dupCheck = await client.query(
        `SELECT 1 FROM card_transactions
         WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
        [saleOrderId]
      )
      if (dupCheck.rows.length === 0) {
        // 顾客此时可能没有卡行（极端场景：账户被清）→ UPSERT 新建
        const newCardId = `FY-CARD-${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`
        const upsertRes = await client.query(
          `INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (user_id) DO UPDATE
             SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
           RETURNING card_id`,
          [newCardId, refundOrder.client_user_id, refundByCard]
        )
        const cardId = upsertRes.rows[0].card_id
        await client.query(
          `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
           VALUES ($1, '充值', $2, $3, NOW())`,
          [cardId, refundByCard, saleOrderId]
        )
      }
    }

    // 翻转对应原销售单上的 payments 退款行：'待支付' → '已支付'
    if (refSaleOrderId) {
      await client.query(
        `UPDATE sale_order_payments
           SET status = '已支付', paid_at = $1
         WHERE sale_order_id = $2 AND change_type = '退款' AND status = '待支付'
           AND note LIKE $3`,
        [now, refSaleOrderId, `FY-TKD=${saleOrderId}%`]
      )

      // 重算原单 paid_amount / prepaid_card_amount（SUM payments 已支付行）
      //   paid_amount         = Σ(status='已支付' AND change_type IN ('首次支付','回款','退款'))
      //   prepaid_card_amount = Σ(status='已支付' AND change_type='储值卡抵扣')
      const sumRes = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','退款')
                             THEN amount::numeric ELSE 0 END), 0) AS new_paid,
           COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                             THEN amount::numeric ELSE 0 END), 0) AS new_prepaid
         FROM sale_order_payments
         WHERE sale_order_id = $1`,
        [refSaleOrderId]
      )
      const sumRow = sumRes.rows[0] || { new_paid: 0, new_prepaid: 0 }
      const newPaid = Math.round(Number(sumRow.new_paid || 0) * 100) / 100
      const newPrepaid = Math.round(Number(sumRow.new_prepaid || 0) * 100) / 100
      await client.query(
        `UPDATE sale_orders
           SET paid_amount = $1, prepaid_card_amount = $2, updated_at = $3
         WHERE sale_order_id = $4`,
        [newPaid, newPrepaid, now, refSaleOrderId]
      )
    }

    // 重算顾客历史消费档位（退款会减少累计消费）
    await refreshSpendingTier(client, refundOrder.client_user_id)
    // 重算顾客类型（退款不降级，但保持一致性）
    await recalcCustomerType(client, refundOrder.client_user_id)

    // 积分冲销（订单链净额差值法，幂等）
    // 退款单的 paid_amount 为负，并入原单链后链净额下降 → delta 为负 → 写"消费冲销"
    // 关键：settle 对象是原销售单（refSaleOrderId），不是退款单自身
    if (refSaleOrderId) {
      await settlePointsSafe(client, refSaleOrderId, 'staffApi.approveRefund')
    }
  })

  ctx.result = { saleOrderId, status: '已支付', refundByCard, refundByOrigin, message: '退款已审批通过' }
}

/**
 * 驳回退款单（店长专用）
 */
async function rejectRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { saleOrderId, rejectedReason } = ctx.event.payload || {}
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')

  const now = new Date()

  // 先查 FY-TKD 拿到 ref_sale_order_id（为作废原单上的 payments 待支付退款行）
  const refundRows = await pg.query(
    "SELECT ref_sale_order_id FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2 AND sale_order_type = '退款单' AND status = '待审批'",
    [saleOrderId, ctx.auth.effectiveStoreId]
  )
  if (refundRows.length === 0) throw new Error('INVALID_PARAMS: 退款单不存在或状态不允许驳回')
  const refSaleOrderId = refundRows[0].ref_sale_order_id

  await pg.transaction(async (client) => {
    // 幂等哨兵：翻转 FY-TKD 状态
    const result = await client.query(
      `UPDATE sale_orders SET status = '已关闭', rejected_reason = $1, approved_by = $2, approved_at = $3, updated_at = $3
       WHERE sale_order_id = $4 AND sale_order_type = '退款单' AND status = '待审批'`,
      [rejectedReason || '', ctx.auth.staffWfId, now, saleOrderId]
    )
    if (result.rowCount === 0) throw new Error('INVALID_PARAMS: 退款单不存在或状态不允许驳回')

    // 作废原单上的 payments 退款行（'待支付' → '已作废'）
    if (refSaleOrderId) {
      await client.query(
        `UPDATE sale_order_payments
           SET status = '已作废'
         WHERE sale_order_id = $1 AND change_type = '退款' AND status = '待支付'
           AND note LIKE $2`,
        [refSaleOrderId, `FY-TKD=${saleOrderId}%`]
      )
    }
  })

  ctx.result = { saleOrderId, status: '已关闭', message: '退款已驳回' }
}

// ========== P2: 回款单（Ticket 2：多次回款 PR-A） ==========

/**
 * 判断支付方式是否走线上通道（生成 prepay_id + 回调到账）
 */
function isOnlinePaymentMethod(method) {
  return method === '微信' || method === '支付宝'
}

/**
 * 创建回款单（店长专用）— Ticket 2 改写
 *
 * 核心变化（vs. 旧实现）：
 *   - 不再按 items 累加 sale_items.received，改由 sale_order_payments 流水行 +
 *     sale_orders.paid_amount 冗余列承载资金权威
 *   - 支持 repayAmount（显式）+ prepaidCardAmount（储值卡抵扣）双通道
 *   - 线下：事务内直接翻已支付（付清）或保留部分支付
 *   - 微信：暂未实现扫码，返回 INVALID_PARAMS:WX_SCAN_NOT_IMPLEMENTED
 *   - 储值卡：事务内锁余额 → UPDATE balance → INSERT card_transactions + 2 条 payments
 *   - 幂等：外部系统没有 external_txn_id 可用时不做，线下依赖前端避免重复提交
 *
 * payload: {
 *   refSaleOrderId: string,      // 原销售单号（必填）
 *   repayAmount?: number,        // 本次回款现金 / 线上金额（可与 items 合计等价；优先取 repayAmount）
 *   items?: [{ saleItemId?, repayAmount }],  // 兼容旧签名，合计即 repayAmount
 *   prepaidCardAmount?: number,  // 本次储值卡抵扣金额（可选）
 *   paymentMethod: '微信'|'线下'|'储值卡',
 *   note?: string
 * }
 *
 * 返回：
 *   { repaymentOrderId, refSaleOrderId, repayAmount, prepaidCardAmount,
 *     refStatus, paymentParams?: null, message }
 */
async function createRepayment(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const {
    refSaleOrderId,
    repayAmount: inputRepayAmount,
    items,
    prepaidCardAmount: inputPrepaidCard,
    paymentMethod,
    note,
  } = payload
  const storeId = ctx.auth.effectiveStoreId
  const marketName = ctx.auth.marketName || ''

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  if (!paymentMethod) throw new Error('INVALID_PARAMS: 缺少 paymentMethod')
  if (!['微信', '线下', '储值卡'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式（仅支持 微信/线下/储值卡）')
  }

  // 微信扫码回款暂未实现（待业务接入微信扫码付款码链路）
  if (paymentMethod === '微信') {
    throw new Error('INVALID_PARAMS:WX_SCAN_NOT_IMPLEMENTED 微信扫码回款暂未开放')
  }

  // 推导 repayAmount：优先显式入参，否则按 items 合计
  let repayAmount
  if (inputRepayAmount !== undefined && inputRepayAmount !== null) {
    repayAmount = Number(inputRepayAmount)
  } else if (Array.isArray(items) && items.length > 0) {
    repayAmount = items.reduce((s, it) => s + (Number(it.repayAmount) || 0), 0)
  } else {
    repayAmount = 0
  }
  if (!Number.isFinite(repayAmount) || repayAmount < 0) {
    throw new Error('INVALID_PARAMS: repayAmount 必须为非负数')
  }
  repayAmount = Math.round(repayAmount * 100) / 100

  const prepaidCardAmount = Math.max(0, Math.round((Number(inputPrepaidCard) || 0) * 100) / 100)
  const totalThisTime = Math.round((repayAmount + prepaidCardAmount) * 100) / 100
  if (totalThisTime <= 0) {
    throw new Error('INVALID_PARAMS: 回款金额必须大于0')
  }

  // 储值卡付款方式下不应再传 repayAmount>0（语义是纯储值卡回款）
  if (paymentMethod === '储值卡' && repayAmount > 0) {
    throw new Error('INVALID_PARAMS: 储值卡付款方式下不应传 repayAmount（应通过 prepaidCardAmount 传递）')
  }

  // 先查原单（非锁，校验门店/顾客归属）
  const origOrders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2',
    [refSaleOrderId, storeId]
  )
  if (origOrders.length === 0) throw new Error('INVALID_PARAMS: 原订单不存在或不属于本门店')
  const origOrder = origOrders[0]
  if (!origOrder.client_user_id) {
    throw new Error('CLIENT_NOT_REGISTERED: 原订单顾客未注册小程序或未绑定门店')
  }

  const now = new Date()
  const repayOrderId = await generateOrderNo('FY-HKD-WX-')

  const result = await pg.transaction(async (client) => {
    // 1) 锁原单 + 校验状态
    const lockRes = await client.query(
      'SELECT * FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE',
      [refSaleOrderId]
    )
    if (lockRes.rows.length === 0) throw new Error('INVALID_PARAMS: 原订单不存在')
    const locked = lockRes.rows[0]

    if (!['部分支付', '待支付', '待确认收款'].includes(locked.status)) {
      throw new Error(`INVALID_STATE: 订单当前状态"${locked.status}"不允许回款`)
    }

    // 2) 计算欠款：payable_amount - paid_amount（储值卡已抵扣部分不占欠款）
    const origTotal = Number(locked.total_amount || 0)
    const origPrepaidSnapshot = Number(locked.prepaid_card_amount || 0)
    const origPaid = Number(locked.paid_amount || 0)
    const origPayable = locked.payable_amount != null
      ? Number(locked.payable_amount)
      : Math.round((origTotal - origPrepaidSnapshot) * 100) / 100
    const remainingPayable = Math.round((origPayable - origPaid) * 100) / 100

    // 3) 超额校验
    if (totalThisTime > remainingPayable + 0.001) {
      throw new Error('INVALID_PARAMS:OVERPAY 本次回款金额超过订单欠款')
    }

    // 4) 储值卡抵扣：锁余额 → 扣减 → 写流水
    let cardTxnRefId = null
    if (prepaidCardAmount > 0) {
      const balRes = await client.query(
        'SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE',
        [locked.client_user_id]
      )
      if (balRes.rows.length === 0) {
        throw new Error('INSUFFICIENT_BALANCE: 顾客无储值卡账户')
      }
      const currentBalance = Number(balRes.rows[0].balance)
      if (currentBalance + 0.001 < prepaidCardAmount) {
        throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
      }
      const cardId = balRes.rows[0].card_id
      await client.query(
        `UPDATE prepaid_cards
         SET balance = balance - $1, updated_at = NOW()
         WHERE card_id = $2`,
        [prepaidCardAmount, cardId]
      )
      // card_transactions.ref_order_id 指向回款凭证单（区别于原销售单扣款，避免幂等键冲突）
      cardTxnRefId = repayOrderId
      await client.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
         VALUES ($1, '扣款', $2, $3, NOW())`,
        [cardId, -prepaidCardAmount, cardTxnRefId]
      )
    }

    // 5) 创建 FY-HKD 凭证单（sale_orders 行）
    //    - 线下/储值卡：付清即 '已支付'（店长亲自发起即为确认动作）
    //    - 线上（本 PR 已 reject）：'待支付'，等回调到账翻转
    const repayStatus = '已支付'
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, ref_sale_order_id,
        market_name, store_id, sale_order_datetime,
        client_user_id, client_phone, customer_name,
        total_amount, paid_amount, prepaid_card_amount, payable_amount,
        payment_method, opened_by,
        allocation_status, paid_at, created_at, updated_at
      ) VALUES (
        $1, $2, '回款单', $3, $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16,
        '待分配', $17, $7, $7
      )`,
      [
        repayOrderId, repayStatus, locked.document_type, refSaleOrderId,
        marketName, storeId, now,
        locked.client_user_id, locked.client_phone, locked.customer_name,
        totalThisTime, repayAmount, prepaidCardAmount, repayAmount,
        paymentMethod, ctx.auth.staffWfId,
        now,
      ]
    )

    // 6) 向原销售单写 payments 流水：
    //    - 现金/线下回款部分（repayAmount > 0 时）
    //    - 储值卡抵扣部分（prepaidCardAmount > 0 时）
    if (repayAmount > 0) {
      // 线下走 '已支付'（店长已确认），线上（本 PR 被 reject，保留 '待支付' 语义）
      const repayStatusRow = isOnlinePaymentMethod(paymentMethod) ? '待支付' : '已支付'
      const paidAtValue = isOnlinePaymentMethod(paymentMethod) ? null : now
      await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at, paid_at
        ) VALUES ($1, '回款', $2, $3, NULL, $4, 'staff', $5, $6, $7, $8)`,
        [
          refSaleOrderId, repayAmount, paymentMethod, repayStatusRow,
          ctx.auth.staffWfId, note || '店长发起回款',
          now, paidAtValue,
        ]
      )
    }
    if (prepaidCardAmount > 0) {
      await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at, paid_at
        ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'staff', $3, $4, $5, $5)`,
        [refSaleOrderId, prepaidCardAmount, ctx.auth.staffWfId, '店长发起回款-储值卡抵扣', now]
      )
    }

    // 7) 重算原单 paid_amount / prepaid_card_amount（SUM payments 已支付行）+ status
    //    不变量：
    //      paid_amount = Σ(amount WHERE status='已支付' AND change_type IN ('首次支付','回款','退款'))
    //      prepaid_card_amount = Σ(amount WHERE status='已支付' AND change_type='储值卡抵扣')
    const sumRes = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','退款')
                           THEN amount::numeric ELSE 0 END), 0) AS new_paid,
         COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                           THEN amount::numeric ELSE 0 END), 0) AS new_prepaid
       FROM sale_order_payments
       WHERE sale_order_id = $1`,
      [refSaleOrderId]
    )
    const newPaid = Math.round(Number(sumRes.rows[0].new_paid) * 100) / 100
    const newPrepaid = Math.round(Number(sumRes.rows[0].new_prepaid) * 100) / 100
    const settled = Math.round((newPaid + newPrepaid) * 100) / 100
    // paid + prepaid ≥ total → '已支付'；否则 '部分支付'
    const targetStatus = settled + 0.001 >= origTotal ? '已支付' : '部分支付'

    // paid_at 语义：目标 '已支付' 时设为本次时间；部分支付保留原值
    const paidAtValue = targetStatus === '已支付' ? now : (locked.paid_at || null)

    const updateRes = await client.query(
      `UPDATE sale_orders
         SET status = $1, paid_amount = $2, prepaid_card_amount = $3,
             paid_at = $4, updated_at = $5
       WHERE sale_order_id = $6 AND status = $7`,
      [targetStatus, newPaid, newPrepaid, paidAtValue, now, refSaleOrderId, locked.status]
    )
    if (updateRes.rowCount === 0) {
      throw new Error('INVALID_STATE: 原订单状态已变更，请刷新后重试')
    }

    // 重算顾客消费档位 + 顾客类型（付清后累计消费可能跨阈值）
    await refreshSpendingTier(client, locked.client_user_id)
    await recalcCustomerType(client, locked.client_user_id)

    return {
      repaymentOrderId: repayOrderId,
      refSaleOrderId,
      repayAmount,
      prepaidCardAmount,
      refStatus: targetStatus,
      refPaidAmount: newPaid,
      refPrepaidCardAmount: newPrepaid,
    }
  })

  ctx.result = {
    ...result,
    // 线下/储值卡直落，无需支付参数；微信分支已 reject
    paymentParams: null,
    status: '已支付', // 回款凭证单状态（本 PR 线下直落）
    totalAmount: totalThisTime,
    // 保留历史兼容字段（旧调用方读 saleOrderId）
    saleOrderId: result.repaymentOrderId,
    message: result.refStatus === '已支付' ? '回款成功，订单已付清' : '回款成功，订单仍部分支付',
  }
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
 *   - 跨店守卫：所有候选卡必须 store_id = ctx.auth.effectiveStoreId
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
  const storeId = ctx.auth.effectiveStoreId
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
    `SELECT user_id, phone, name, customer_type, bound_store_id
     FROM client_wechat_users WHERE user_id = $1 LIMIT 1`,
    [clientUserId]
  )
  if (clientRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const client = clientRows[0]
  if (!client.bound_store_id) {
    throw new Error('CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店')
  }

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
    // 2026-04-24 schema 变更：UNIQUE(user_id)，一户一账户，跨店共享；INSERT 列集不含 store_id。
    let prepaidCardCredit = 0
    if (priceDiff < 0) {
      const creditAmount = Math.round(Math.abs(priceDiff) * 100) / 100
      prepaidCardCredit = creditAmount

      const upsert = await tx.query(
        `INSERT INTO prepaid_cards (card_id, user_id, balance)
         VALUES (gen_random_uuid()::text, $1, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET balance = prepaid_cards.balance + EXCLUDED.balance,
               updated_at = NOW()
         RETURNING card_id`,
        [clientUserId, creditAmount.toFixed(2)]
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
  const storeId = ctx.auth.effectiveStoreId
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
    [pickupQuantity, saleItemId, ctx.auth.effectiveStoreId]
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
    if (row.store_id !== ctx.auth.effectiveStoreId) {
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
    [saleItemId, pickupQuantity, ctx.auth.effectiveStoreId, clientUserId, ctx.auth.staffWfId, remark || null]
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

/**
 * 退款单列表
 *
 * payload: { status?: '待审批'|'已支付'|'已关闭', page?, pageSize? }
 * 店长：看本店全部 FY-TKD；非店长：看自己开单的
 */
async function refundList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, page = 1, pageSize = 20 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.effectiveStoreId, pageSize, offset]
  let whereExtra = ''
  if (status) {
    params.push(status)
    whereExtra += ` AND r.status = $${params.length}`
  }
  if (!ctx.auth.roles.includes('manager')) {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND r.opened_by = $${params.length}`
  }

  const refunds = await pg.query(`
    SELECT
      r.sale_order_id, r.status, r.ref_sale_order_id,
      r.client_phone, r.customer_name, r.total_amount, r.handling_fee,
      r.refund_reason, r.rejected_reason,
      r.opened_by, r.approved_by,
      r.created_at, r.approved_at,
      opener.name AS opened_by_name,
      approver.name AS approved_by_name
    FROM sale_orders r
    LEFT JOIN staff_wechat_users opener ON r.opened_by = opener.employee_id
    LEFT JOIN staff_wechat_users approver ON r.approved_by = approver.employee_id
    WHERE r.store_id = $1 AND r.sale_order_type = '退款单'
    ${whereExtra}
    ORDER BY r.created_at DESC
    LIMIT $2 OFFSET $3
  `, params)

  ctx.result = { refunds, page, pageSize }
}

/**
 * 退款单详情
 *
 * payload: { saleOrderId: FY-TKD-* }
 * 返回 FY-TKD 凭证 + 原单概要 + 退款明细 + 原单上该退款的 payments 流水
 */
async function refundDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { saleOrderId } = ctx.event.payload || {}
  if (!saleOrderId) throw new Error('INVALID_PARAMS: 缺少 saleOrderId')

  const refundRows = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND store_id = $2 AND sale_order_type = '退款单'",
    [saleOrderId, ctx.auth.effectiveStoreId]
  )
  if (refundRows.length === 0) throw new Error('NOT_FOUND: 退款单不存在')
  const refund = refundRows[0]

  // 非店长：仅允许查自己发起的退款
  if (!ctx.auth.roles.includes('manager') && refund.opened_by !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权查看该退款单')
  }

  // 发起人 / 审批人姓名
  const staffIds = [refund.opened_by, refund.approved_by].filter(Boolean)
  let openedByName = null
  let approvedByName = null
  if (staffIds.length > 0) {
    const staffRows = await pg.query(
      'SELECT employee_id, name FROM staff_wechat_users WHERE employee_id = ANY($1)',
      [staffIds]
    )
    for (const s of staffRows) {
      if (s.employee_id === refund.opened_by) openedByName = s.name
      if (s.employee_id === refund.approved_by) approvedByName = s.name
    }
  }

  // 退款明细（item_direction='退出'）
  const refundItems = await pg.query(`
    SELECT
      si.sale_item_id, si.ref_sale_item_id, si.sku_id,
      si.product_name, si.sku_spec_name, si.product_type,
      si.session_count, si.unit_price, si.unit_real_price,
      si.quantity, si.sale_amount, si.sales_category, si.service_fee
    FROM sale_items si
    WHERE si.sale_order_id = $1 AND si.item_direction = '退出'
    ORDER BY si.sale_item_id
  `, [saleOrderId])

  // 原销售单概要
  let origOrder = null
  if (refund.ref_sale_order_id) {
    const origRows = await pg.query(
      `SELECT sale_order_id, status, total_amount, paid_amount, prepaid_card_amount, payable_amount,
              payment_method, sale_order_datetime, client_phone, customer_name
         FROM sale_orders WHERE sale_order_id = $1`,
      [refund.ref_sale_order_id]
    )
    if (origRows.length > 0) origOrder = origRows[0]
  }

  // 原单上该退款的 payments 流水（NOTE 里含 FY-TKD=<saleOrderId>）
  let payments = []
  if (refund.ref_sale_order_id) {
    const paymentRows = await pg.query(
      `SELECT change_type, amount, payment_method, status, paid_at, created_at, note
         FROM sale_order_payments
        WHERE sale_order_id = $1 AND change_type = '退款' AND note LIKE $2
        ORDER BY created_at ASC, id ASC`,
      [refund.ref_sale_order_id, `FY-TKD=${saleOrderId}%`]
    )
    payments = paymentRows.map(p => ({
      change_type: p.change_type,
      amount: Number(p.amount),
      payment_method: p.payment_method,
      status: p.status,
      paid_at: p.paid_at,
      created_at: p.created_at,
      note: p.note,
    }))
  }

  ctx.result = {
    refund: { ...refund, opened_by_name: openedByName, approved_by_name: approvedByName },
    origOrder,
    refundItems,
    payments,
  }
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
  refundList,
  refundDetail,
  createRepayment,
  createConversion,
  customerHeldCards,
  createPickup,
}
