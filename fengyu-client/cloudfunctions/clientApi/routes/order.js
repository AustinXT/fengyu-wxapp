/**
 * 订单模块路由
 * 客户端订单相关接口
 */

const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { getMemberThreshold } = require('../utils/config')
const { settlePointsSafe } = require('../utils/points')

/**
 * 关闭过期订单并释放关联优惠券（原子操作）
 * @param {string} orderNo - 订单号
 */
async function closeExpiredOrder(orderNo) {
  await pg.transaction(async (client) => {
    const result = await client.query(
      "UPDATE sale_orders SET status = '已关闭', updated_at = NOW() WHERE sale_order_id = $1 AND status = '待支付'",
      [orderNo]
    )
    if (result.rowCount > 0) {
      await client.query(
        `UPDATE user_coupons SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
         WHERE used_sale_order_id = $1`,
        [orderNo]
      )
    }
  })
}

/**
 * 批量关闭用户过期订单并释放优惠券
 * @param {string} userId - 用户ID
 */
async function closeExpiredOrdersByUser(userId) {
  const expired = await pg.query(
    `SELECT sale_order_id FROM sale_orders
     WHERE client_user_id = $1 AND status = '待支付'
     AND sale_order_datetime < NOW() - INTERVAL '10 minutes'`,
    [userId]
  )
  for (const row of expired) {
    await closeExpiredOrder(row.sale_order_id)
  }
}

/**
 * 扫码查看订单详情（员工开单订单专用）
 * 不要求 client_user_id 匹配，仅限员工开单（opened_by IS NOT NULL）的订单
 */
async function scanDetail(ctx) {
  const { orderNo, saleOrderId } = ctx.event.payload || {}
  const targetOrderId = saleOrderId || orderNo
  if (!targetOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    `SELECT o.*, s.store_name, sw.name AS opener_name
     FROM sale_orders o
     LEFT JOIN stores s ON o.store_id = s.store_id
     LEFT JOIN staff_wechat_users sw ON o.opened_by = sw.employee_id
     WHERE o.sale_order_id = $1 AND o.opened_by IS NOT NULL`,
    [targetOrderId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 懒清理过期的待支付订单
  if (order.status === '待支付') {
    const orderTime = new Date(order.sale_order_datetime)
    if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
      await closeExpiredOrder(targetOrderId)
      order.status = '已关闭'
    }
  }

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

  // 查询商品明细（使用 sale_items 快照字段 + 商品封面）
  const items = await pg.query(`
    SELECT
      si.sale_item_id, si.unit_price, si.quantity, si.received,
      si.product_name, si.sku_spec_name,
      (SELECT p.cover_image FROM mall_product_skus mps
       JOIN products p ON mps.product_id = p.product_id
       WHERE mps.sku_id = si.sku_id LIMIT 1) AS cover_image
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
      openerName: order.opener_name || '',
      orderType: order.sale_order_type,
      totalAmount: Number(order.total_amount || 0),
      prepaidCardAmount: Number(order.prepaid_card_amount || 0),
      paidAmount: Number(order.paid_amount ?? order.total_amount ?? 0),
      paymentMethod: order.payment_method || '微信',
      couponDiscount: Number(order.coupon_discount || 0)
    },
    items: items.map(i => ({
      saleItemId: i.sale_item_id,
      productName: i.product_name,
      skuSpecName: i.sku_spec_name,
      unitPrice: i.unit_price,
      quantity: i.quantity,
      received: i.received,
      coverImage: i.cover_image || ''
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
    paymentMethod, // '微信' | '线下' | '支付宝'
    orderType: orderTypeParam, // 可选, 'promo' | undefined
    couponId: inputCouponId, // 可选, 优惠券ID
    useCard, // 可选, 是否使用储值卡抵扣
    prepaidCardAmount: inputPrepaidCardAmount // 可选, 前端传的抵扣金额
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

  // 先清理过期的待支付订单（10分钟超时，同时释放优惠券）
  await closeExpiredOrdersByUser(userId)

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

  // 查询 SKU 信息（product_skus → product_categories 两表 JOIN）
  const skuIds = items.map(i => i.skuId)
  const skuResults = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      sk.category_id, pc.sales_category
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
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
      productName: sku.spec_name,
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
    // 验证券有效性（face_value_override 优先于 template.discount_value，分享礼等动态面值场景）
    const couponRows = await pg.query(
      `SELECT uc.coupon_id, uc.user_id, uc.expire_at,
              ct.coupon_type,
              COALESCE(uc.face_value_override, ct.discount_value) AS discount_value,
              ct.min_spend, ct.max_discount,
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

    // 品项分类匹配（SKU 直接有 category_id）
    const skuCats = await pg.query(
      `SELECT sku_id, category_id FROM product_skus WHERE sku_id = ANY($1)`,
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

    // 满减门槛（归一化到分 + 浮点兜底，与 coupon.available 保持一致）
    const eligibleTotalRaw = eligibleItems.reduce((s, d) => s + d.saleAmount, 0)
    const eligibleTotal = Math.round(eligibleTotalRaw * 100) / 100
    const minSpend = Math.round((Number(couponInfo.min_spend) || 0) * 100) / 100
    if (eligibleTotal + 0.001 < minSpend) {
      throw new Error(`INVALID_PARAMS: 未满足使用条件（满${minSpend}可用）`)
    }

    // 计算抵扣金额
    if (couponInfo.coupon_type === '现金券' || couponInfo.coupon_type === '品项券') {
      couponDiscount = Math.min(Number(couponInfo.discount_value), eligibleTotal)
    } else if (couponInfo.coupon_type === '折扣券') {
      couponDiscount = eligibleTotal * (1 - Number(couponInfo.discount_value))
      if (couponInfo.max_discount) {
        couponDiscount = Math.min(couponDiscount, Number(couponInfo.max_discount))
      }
    }
    couponDiscount = Math.round(couponDiscount * 100) / 100

    // 按比例分摊到各行的 received（尾差修正：最后一项吸收舍入误差）
    let distributedDiscount = 0
    for (let i = 0; i < eligibleItems.length; i++) {
      const item = eligibleItems[i]
      let share
      if (i === eligibleItems.length - 1) {
        // 最后一项吸收尾差
        share = couponDiscount - distributedDiscount
      } else {
        share = Math.round(couponDiscount * (item.saleAmount / eligibleTotal) * 100) / 100
        distributedDiscount += share
      }
      item.received -= share
      item.received = Math.round(item.received * 100) / 100
    }

    totalAmount = itemsData.reduce((s, d) => s + d.received, 0)
    totalAmount = Math.round(totalAmount * 100) / 100
  }

  // 从 PG 查询顾客姓名 + customer_type（用于 document_type 判断）
  let customerName = null
  let documentType = '售前'
  {
    const userRows = await pg.query(
      'SELECT name, customer_type FROM client_wechat_users WHERE user_id = $1',
      [userId]
    )
    if (userRows.length > 0) {
      if (userRows[0].name) customerName = userRows[0].name
      if (userRows[0].customer_type === '会员客') documentType = '售后'
    }
  }
  if (documentType === '售前') {
    const threshold = await getMemberThreshold()
    if (totalAmount >= threshold) documentType = '售后'
  }

  // 使用事务创建订单（订单号+流水号在事务内原子生成）
  let orderNo
  let finalPrepaidCardAmount = 0
  let finalPaidAmount = totalAmount
  let finalPaymentMethod = paymentMethod
  let cardIdForDeduction = null
  let prepaidFullPaid = false
  await pg.transaction(async (client) => {
    // 获取 advisory lock 防止并发生成重复序号
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    // === 储值卡抵扣计算（事务内、在 INSERT sale_orders 之前） ===
    // 应抵上限 = totalAmount（已扣完优惠券）
    let cardBalance = 0
    let cardId = null
    if (useCard) {
      const cardRows = await client.query(
        'SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE',
        [userId]
      )
      if (cardRows.rows.length > 0) {
        cardId = cardRows.rows[0].card_id
        cardBalance = Number(cardRows.rows[0].balance)
      }
    }

    let prepaidCardAmount = 0
    if (useCard) {
      const cap = Math.round(totalAmount * 100) / 100
      if (inputPrepaidCardAmount !== undefined && inputPrepaidCardAmount !== null) {
        const v = Number(inputPrepaidCardAmount)
        if (!Number.isFinite(v) || v < 0) {
          throw new Error('INVALID_PARAMS: 储值卡抵扣金额无效')
        }
        if (Math.round(v * 100) !== v * 100) {
          throw new Error('INVALID_PARAMS: 储值卡抵扣金额最多保留 2 位小数')
        }
        if (v > cardBalance + 0.001) {
          throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
        }
        if (v > cap + 0.001) {
          throw new Error('INVALID_PARAMS: 储值卡抵扣金额超过应付金额')
        }
        prepaidCardAmount = Math.round(v * 100) / 100
      } else {
        prepaidCardAmount = Math.min(cardBalance, cap)
        prepaidCardAmount = Math.round(prepaidCardAmount * 100) / 100
      }
    }

    const paidAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100
    // payment_method 规则：paid=0 强制 '无'；paid>0 校验前端传值属于 {微信,支付宝,线下}
    let effectivePaymentMethod
    if (paidAmount === 0) {
      effectivePaymentMethod = '无'
    } else {
      if (!['微信', '支付宝', '线下'].includes(paymentMethod)) {
        throw new Error('INVALID_PARAMS: 支付方式无效')
      }
      effectivePaymentMethod = paymentMethod
    }
    finalPrepaidCardAmount = prepaidCardAmount
    finalPaidAmount = paidAmount
    finalPaymentMethod = effectivePaymentMethod
    cardIdForDeduction = cardId
    prepaidFullPaid = paidAmount === 0 && prepaidCardAmount > 0

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

    // 创建订单主表（全额抵扣时直接 '已支付' + paid_at）
    const initialStatus = prepaidFullPaid ? '已支付' : '待支付'
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id,
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, prepaid_card_amount, paid_amount, payable_amount, payment_method,
        preferred_employee_id, coupon_id, coupon_discount,
        paid_at, created_at, updated_at
      ) VALUES ($1, $2, '销售单', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $6, $6)`,
      [
        orderNo, initialStatus, documentType, marketName, storeId, now, userId,
        ctx.auth.phone || null, customerName,
        totalAmount, prepaidCardAmount, paidAmount, paidAmount, effectivePaymentMethod,
        preferredStaffWfId || null, inputCouponId || null, couponDiscount,
        prepaidFullPaid ? now : null
      ]
    )

    // 创建订单明细（流水号递增）
    for (let i = 0; i < itemsData.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemsData[i]
      await client.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, sku_id,
          product_name, sku_spec_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price,
          sale_amount, received, sales_category
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          saleItemId, orderNo, storeId, d.skuId,
          d.productName, d.skuSpecName, d.productType,
          d.sessionCount, d.remainingSessions,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount, d.received, d.salesCategory || null
        ]
      )
    }

    // 全额抵扣：同事务扣减 balance + INSERT card_transactions（幂等）
    if (prepaidFullPaid) {
      // 幂等检查：若 ref_order_id + type='扣款' 已存在则跳过
      const existDed = await client.query(
        `SELECT 1 FROM card_transactions
         WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
        [orderNo]
      )
      if (existDed.rows.length === 0) {
        await client.query(
          `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW()
           WHERE card_id = $2`,
          [prepaidCardAmount, cardIdForDeduction]
        )
        await client.query(
          `INSERT INTO card_transactions (card_id, type, amount, ref_order_id)
           VALUES ($1, '扣款', $2, $3)`,
          [cardIdForDeduction, -prepaidCardAmount, orderNo]
        )
      }
    }
  })

  if (prepaidFullPaid) {
    ctx.result = {
      orderNo,
      saleOrderId: orderNo,
      totalAmount,
      prepaidCardAmount: finalPrepaidCardAmount,
      paidAmount: finalPaidAmount,
      paymentMethod: finalPaymentMethod,
      status: '已支付',
      reason: 'prepaid_card_full',
      paymentParams: null,
    }
    return
  }

  ctx.result = {
    orderNo,
    saleOrderId: orderNo,
    totalAmount,
    prepaidCardAmount: finalPrepaidCardAmount,
    paidAmount: finalPaidAmount,
    paymentMethod: finalPaymentMethod,
    status: '待支付'
  }
}

/**
 * 计算订单的"本次应付剩余"
 * = paid_amount 字段代表的剩余应付实金（不含储值卡抵扣）
 * 订单创建时 paid_amount = total_amount - prepaid_card_amount 初值即剩余应付
 * 首次支付/回款到账后 paid_amount 累加，当 paid_amount 达到初值 → 订单 '已支付'
 *
 * 对外"剩余应付"语义：
 *   remaining = (total_amount - prepaid_card_amount) - 已到账金额
 * 已到账金额 = Σ (payments.amount WHERE status='已支付' AND change_type IN ('首次支付','回款','退款'))
 *
 * 数据库中 sale_orders.paid_amount 现在有两种语义混用的历史原因：
 *   - create 时（无 payments 行）：paid_amount = total_amount - prepaid_card_amount（本次应付总额）
 *   - payNotify 到账后：paid_amount 累加实际到账金额
 *
 * 本 PR 改造后约定：sale_orders.paid_amount 统一为"已实际到账金额"。
 * 初次 create 不再把 total-prepaid 赋给 paid_amount——由 payable_amount 列承担。
 * 但因 PR-2/PR-3 尚未改 create 侧，此处通过显式判断兼容两种情况。
 */
async function calcPaymentRemaining(orderNo, orderRow) {
  const totalAmount = Number(orderRow.total_amount || 0)
  const prepaidCardAmount = Number(orderRow.prepaid_card_amount || 0)
  const payableAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100

  // 已到账金额 = Σ payments 已支付行（首次支付/回款/退款）
  // pg.query 返回 rows 数组（见 db/pg.js），不需要 .rows 解包
  const rows = await pg.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid_sum
     FROM sale_order_payments
     WHERE sale_order_id = $1
       AND status = '已支付'
       AND change_type IN ('首次支付','回款','退款')`,
    [orderNo]
  )
  const paidSum = Number(rows[0]?.paid_sum || 0)
  const remaining = Math.round((payableAmount - paidSum) * 100) / 100
  return { payableAmount, paidSum, remaining }
}

/**
 * 发起微信支付
 *
 * 本 PR 改造：pay 只"发起支付信号"，不写 payments 行。
 * payments 行由 payNotify 回调在收到真实 transaction_id 后原子插入（带唯一索引幂等）。
 * 订单状态保持原值（'待支付' 或 '部分支付'）。
 *
 * payAmount 入参（可选）：本次支付金额；省略默认为剩余应付金额。
 * 校验：0 < payAmount <= remaining；超出或非正数 → INVALID_PARAMS。
 */
async function pay(ctx) {
  const { userId } = ctx.auth
  const payload = ctx.event.payload || {}
  const orderNo = payload.saleOrderId || payload.orderNo
  const payAmountInput = payload.payAmount

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
  } else if (!order.opened_by) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  // 允许支付的状态：待支付 / 部分支付
  if (order.status !== '待支付' && order.status !== '部分支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许支付')
  }

  // 10分钟超时检查仅对 '待支付' 生效（部分支付订单已有首次到账，不自动过期）
  if (order.status === '待支付') {
    const orderTime = new Date(order.sale_order_datetime)
    if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
      await closeExpiredOrder(orderNo)
      throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
    }
  }

  const now = new Date()

  // 全额储值卡抵扣：paid_amount = 0，直接短路返回已支付（订单本身已在 create 阶段置为已支付）
  const paidAmountCol = Number(order.paid_amount ?? order.total_amount ?? 0)
  if (paidAmountCol === 0 && order.status === '待支付') {
    ctx.result = {
      orderNo,
      status: '已支付',
      reason: 'prepaid_card_full',
      paymentParams: null,
    }
    return
  }

  // 计算剩余应付：若订单已有 payments 行（部分支付场景）则按流水和反推
  // 否则 remaining = paidAmountCol（create 阶段未到账）
  const { remaining } = await calcPaymentRemaining(orderNo, order)
  // fallback：若 payments 表为空且 order.status='待支付'，以 paid_amount 列为准
  const hasPaymentRows = await pg.query(
    `SELECT 1 FROM sale_order_payments WHERE sale_order_id = $1 LIMIT 1`,
    [orderNo]
  )
  const effectiveRemaining = hasPaymentRows.length > 0 ? remaining : paidAmountCol

  // 校验本次支付金额
  let thisPayAmount
  if (payAmountInput !== undefined && payAmountInput !== null) {
    const v = Number(payAmountInput)
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error('INVALID_PARAMS: 支付金额无效')
    }
    if (Math.round(v * 100) !== v * 100) {
      throw new Error('INVALID_PARAMS: 支付金额最多保留 2 位小数')
    }
    if (v > effectiveRemaining + 0.001) {
      throw new Error('INVALID_PARAMS: 支付金额超过剩余应付')
    }
    thisPayAmount = Math.round(v * 100) / 100
  } else {
    thisPayAmount = effectiveRemaining
  }

  // 自动绑定 client_user_id（仅 staff 来源且未绑定时）
  if (!order.client_user_id && order.opened_by) {
    await pg.query(
      'UPDATE sale_orders SET client_user_id = $1, payment_method = $2, updated_at = $3 WHERE sale_order_id = $4',
      [userId, '微信', now, orderNo]
    )
  } else {
    await pg.query(
      "UPDATE sale_orders SET payment_method = '微信', updated_at = $1 WHERE sale_order_id = $2",
      [now, orderNo]
    )
  }

  const totalAmount = order.total_amount

  // TODO: 接入真实微信支付统一下单接口；本 PR 仅返回 mock 参数。
  // 不再写 payments 行：回调到账时由 payNotify 原子插入 payments + 更新 sale_orders。
  ctx.result = {
    orderNo,
    totalAmount,
    paidAmount: thisPayAmount,
    paymentMethod: '微信',
    mockMode: true,
    paymentParams: {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: Math.random().toString(36).substr(2),
      package: `prepay_id=wx${Date.now()}`,
      signType: 'MD5',
      paySign: 'mock_sign',
      totalFee: Math.round(thisPayAmount * 100)
    }
  }
}

/**
 * 选择线下付款
 *
 * 业务语义：客户端"确认选择线下付款"，订单状态置 '待确认收款'，等员工店长（staff 端 confirmOffline）
 * 确认实收。本 PR 保持此语义：不在此函数里写 payments 流水行——真正的款项落账由
 * staff 端 confirmOffline 在 PR-2 实现时插入 payments 行。
 *
 * 保留原行为（仅切换状态 + 记录付款方式），但新增 note 说明与 payments 表解耦。
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
  } else if (!order.opened_by) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  // 线下付款触发仍仅限 '待支付'（部分支付订单的补款走 staff 端补款入口）
  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许付款')
  }

  // 10分钟超时检查（关闭并释放优惠券）
  const orderTimeOffline = new Date(order.sale_order_datetime)
  if (Date.now() - orderTimeOffline.getTime() > 10 * 60 * 1000) {
    await closeExpiredOrder(orderNo)
    throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
  }

  // 全额储值卡抵扣：paid_amount = 0，直接短路返回已支付
  const paidAmountOff = Number(order.paid_amount ?? order.total_amount ?? 0)
  if (paidAmountOff === 0) {
    ctx.result = {
      orderNo,
      status: '已支付',
      reason: 'prepaid_card_full',
    }
    return
  }

  const now = new Date()
  await pg.query(
    "UPDATE sale_orders SET status = '待确认收款', client_user_id = COALESCE(client_user_id, $1), payment_method = '线下', updated_at = $2 WHERE sale_order_id = $3",
    [userId, now, orderNo]
  )

  // 备注：不在本 PR 写 payments 行。staff 端 confirmOffline 在 PR-2 落地时
  // 会插入 change_type='首次支付' / payment_method='线下' / status='已支付' 的流水行。

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
  const { status, page: pageParam, pageSize: pageSizeParam } = ctx.event.payload || {}

  // 分页参数（默认 20 条/页，上限 50）
  const pageSize = Math.min(Math.max(Number(pageSizeParam) || 20, 1), 50)
  const page = Math.max(Number(pageParam) || 1, 1)
  const offset = (page - 1) * pageSize

  // 懒清理过期的待支付订单（同时释放优惠券），仅首页触发
  if (page === 1) {
    await closeExpiredOrdersByUser(userId)
  }

  let whereClause = 'WHERE o.client_user_id = $1'
  const params = [userId]

  if (status) {
    params.push(status)
    whereClause += ` AND o.status = $${params.length}`
  }

  // 多取 1 条用于判断是否有下一页
  const fetchLimit = pageSize + 1
  params.push(fetchLimit, offset)

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
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params)

  const hasMore = orders.length > pageSize
  if (hasMore) orders.pop()

  // 批量查询所有订单的明细项（使用快照字段）
  if (orders.length > 0) {
    const orderIds = orders.map(o => o.sale_order_id)
    const items = await pg.query(`
      SELECT
        si.sale_order_id,
        si.sale_item_id,
        si.quantity,
        si.received,
        si.remaining_sessions,
        si.product_name,
        si.sku_spec_name,
        si.product_type,
        (SELECT p.cover_image FROM mall_product_skus mps
         JOIN products p ON mps.product_id = p.product_id
         WHERE mps.sku_id = si.sku_id LIMIT 1) AS cover_image
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

  ctx.result = { orders, hasMore }
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

  let order = orders[0]

  // 懒清理过期的待支付订单（防止前端倒计时到 0 后无限重载，同时释放优惠券）
  if (order.status === '待支付') {
    const orderTime = new Date(order.sale_order_datetime)
    if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
      await closeExpiredOrder(orderNo)
      order.status = '已关闭'
    }
  }

  // 查询订单明细（使用快照字段 + 商品封面）
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
      si.expire_date,
      (SELECT p.cover_image FROM mall_product_skus mps
       JOIN products p ON mps.product_id = p.product_id
       WHERE mps.sku_id = si.sku_id LIMIT 1) AS cover_image
    FROM sale_items si
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [orderNo])

  // 待支付订单返回过期时间
  let expireAt = null
  if (order.status === '待支付') {
    expireAt = new Date(new Date(order.sale_order_datetime).getTime() + 10 * 60 * 1000).toISOString()
  }

  // 并行查询美容师姓名、券名称和款项流水
  const [preferredStaffName, couponName, paymentRows] = await Promise.all([
    order.preferred_employee_id
      ? pg.query('SELECT name FROM staff_wechat_users WHERE employee_id = $1', [order.preferred_employee_id])
          .then(rows => rows.length > 0 ? rows[0].name : null)
      : Promise.resolve(null),
    order.coupon_id
      ? pg.query(
          `SELECT ct.name FROM user_coupons uc
           JOIN coupon_templates ct ON uc.template_id = ct.template_id
           WHERE uc.coupon_id = $1`,
          [order.coupon_id]
        ).then(rows => rows.length > 0 ? rows[0].name : null)
      : Promise.resolve(null),
    pg.query(
      `SELECT change_type, amount, payment_method, status, paid_at, created_at, note
       FROM sale_order_payments
       WHERE sale_order_id = $1
       ORDER BY created_at ASC, id ASC`,
      [orderNo]
    )
  ])

  // 精简 payments 字段（只给前端需要的）
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
    order: {
      ...order,
      expire_at: expireAt,
      preferred_staff_name: preferredStaffName,
      coupon_name: couponName,
    },
    items,
    payments,
  }
}

/**
 * 取消订单
 * 若订单已扣过储值卡（全额抵扣场景），同事务反向 INSERT 充值流水并回冲 balance
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

  // 允许取消状态：待支付（常规）、已支付（仅全额抵扣单，需回冲储值卡）
  const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
  const isPrepaidFull = prepaidCardAmount > 0 && Number(order.paid_amount || 0) === 0
  const cancelableStatuses = ['待支付']
  if (isPrepaidFull && order.status === '已支付') {
    // 全额抵扣单顾客确认立刻取消：允许回冲
    cancelableStatuses.push('已支付')
  }
  if (!cancelableStatuses.includes(order.status)) {
    throw new Error('INVALID_PARAMS: 当前订单状态不允许取消')
  }

  const now = new Date()
  await pg.transaction(async (client) => {
    // 事务内先查该订单是否已有扣款流水
    let hasDeducted = false
    if (prepaidCardAmount > 0) {
      const existDed = await client.query(
        `SELECT id FROM card_transactions
         WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
        [orderNo]
      )
      hasDeducted = existDed.rows.length > 0
    }

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

    // 若已扣过卡：反向 INSERT 充值流水 + UPDATE prepaid_cards balance 回冲
    if (hasDeducted) {
      // 幂等：若已存在 ref_order_id + type='充值' 则跳过
      const existRev = await client.query(
        `SELECT id FROM card_transactions
         WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
        [orderNo]
      )
      if (existRev.rows.length === 0) {
        const cardRows = await client.query(
          `SELECT card_id FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
          [userId]
        )
        if (cardRows.rows.length > 0) {
          const cardId = cardRows.rows[0].card_id
          await client.query(
            `UPDATE prepaid_cards SET balance = balance + $1, updated_at = NOW()
             WHERE card_id = $2`,
            [prepaidCardAmount, cardId]
          )
          await client.query(
            `INSERT INTO card_transactions (card_id, type, amount, ref_order_id)
             VALUES ($1, '充值', $2, $3)`,
            [cardId, prepaidCardAmount, orderNo]
          )
        }
      }
    }
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
 *
 * 本 PR 改造：同 pay。alipayPay 只"发起支付信号"，不写 payments 行；
 * payments 行由 payNotify（支付宝回调）在收到真实 transaction_id 后原子插入。
 *
 * payAmount 入参（可选）：本次支付金额；省略默认为剩余应付金额。
 */
async function alipayPay(ctx) {
  const { userId } = ctx.auth
  const payloadAli = ctx.event.payload || {}
  const orderNo = payloadAli.saleOrderId || payloadAli.orderNo
  const payAmountInput = payloadAli.payAmount

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
  } else if (!order.opened_by) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  if (order.status !== '待支付' && order.status !== '部分支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许支付')
  }

  // 10分钟超时检查（仅 '待支付' 生效）
  if (order.status === '待支付') {
    const orderTimeAlipay = new Date(order.sale_order_datetime)
    if (Date.now() - orderTimeAlipay.getTime() > 10 * 60 * 1000) {
      await closeExpiredOrder(orderNo)
      throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
    }
  }

  const totalAmount = Number(order.total_amount || 0)

  // 计算剩余应付 + 本次支付金额校验（逻辑同 pay）
  const paidAmountCol = Number(order.paid_amount ?? order.total_amount ?? 0)
  const { remaining } = await calcPaymentRemaining(orderNo, order)
  const hasPaymentRows = await pg.query(
    `SELECT 1 FROM sale_order_payments WHERE sale_order_id = $1 LIMIT 1`,
    [orderNo]
  )
  const effectiveRemaining = hasPaymentRows.length > 0 ? remaining : paidAmountCol

  let thisPayAmount
  if (payAmountInput !== undefined && payAmountInput !== null) {
    const v = Number(payAmountInput)
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error('INVALID_PARAMS: 支付金额无效')
    }
    if (Math.round(v * 100) !== v * 100) {
      throw new Error('INVALID_PARAMS: 支付金额最多保留 2 位小数')
    }
    if (v > effectiveRemaining + 0.001) {
      throw new Error('INVALID_PARAMS: 支付金额超过剩余应付')
    }
    thisPayAmount = Math.round(v * 100) / 100
  } else {
    thisPayAmount = effectiveRemaining
  }

  const now = new Date()
  await pg.query(
    "UPDATE sale_orders SET payment_method = '支付宝', client_user_id = COALESCE(client_user_id, $1), updated_at = $2 WHERE sale_order_id = $3",
    [userId, now, orderNo]
  )

  // TODO: 接入真实支付宝当面付 API；payments 行由 payNotify 回调写入。
  ctx.result = {
    orderNo,
    totalAmount,
    paidAmount: thisPayAmount,
    paymentMethod: '支付宝',
    mockMode: true,
    qrCodeUrl: `https://qr.alipay.com/mock_${orderNo}`,
    status: order.status,
  }
}

/**
 * 顾客扫码后调整店长预选的抵扣方案
 * payload: { saleOrderId, useCard, prepaidCardAmount?, paymentMethod? }
 * 仅限员工开单（opened_by IS NOT NULL）且状态='待支付'
 * balance 不动；本端点只重算订单的 prepaid_card_amount/paid_amount/payment_method
 */
async function scanAdjust(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  const { useCard, prepaidCardAmount: inputPrepaidCardAmount, paymentMethod } = payload

  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    `SELECT * FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }
  const order = orders[0]

  if (!order.opened_by) {
    throw new Error('INVALID_PARAMS: 非员工开单订单不支持此操作')
  }
  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许调整')
  }
  // 归属校验：允许 client_user_id 为空（首次扫码绑定）或等于当前用户
  if (order.client_user_id && order.client_user_id !== userId) {
    throw new Error('PERMISSION_DENIED: 无权操作该订单')
  }

  const totalAmount = Number(order.total_amount || 0)

  // 读当前余额（本端点不扣款，不加 FOR UPDATE）
  let cardBalance = 0
  const cardRows = await pg.query(
    'SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1',
    [userId]
  )
  if (cardRows.length > 0) {
    cardBalance = Number(cardRows[0].balance)
  }

  // 重算 prepaid / paid / payment_method
  let prepaidCardAmount = 0
  if (useCard) {
    const cap = Math.round(totalAmount * 100) / 100
    if (inputPrepaidCardAmount !== undefined && inputPrepaidCardAmount !== null) {
      const v = Number(inputPrepaidCardAmount)
      if (!Number.isFinite(v) || v < 0) {
        throw new Error('INVALID_PARAMS: 储值卡抵扣金额无效')
      }
      if (Math.round(v * 100) !== v * 100) {
        throw new Error('INVALID_PARAMS: 储值卡抵扣金额最多保留 2 位小数')
      }
      if (v > cardBalance + 0.001) {
        throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
      }
      if (v > cap + 0.001) {
        throw new Error('INVALID_PARAMS: 储值卡抵扣金额超过应付金额')
      }
      prepaidCardAmount = Math.round(v * 100) / 100
    } else {
      prepaidCardAmount = Math.min(cardBalance, cap)
      prepaidCardAmount = Math.round(prepaidCardAmount * 100) / 100
    }
  }
  const paidAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100
  let effectivePaymentMethod
  if (paidAmount === 0) {
    effectivePaymentMethod = '无'
  } else {
    if (!['微信', '支付宝', '线下'].includes(paymentMethod)) {
      throw new Error('INVALID_PARAMS: 支付方式无效')
    }
    effectivePaymentMethod = paymentMethod
  }

  const now = new Date()
  await pg.query(
    `UPDATE sale_orders
     SET prepaid_card_amount = $1,
         paid_amount = $2,
         payment_method = $3,
         client_user_id = COALESCE(client_user_id, $4),
         updated_at = $5
     WHERE sale_order_id = $6 AND status = '待支付'`,
    [prepaidCardAmount, paidAmount, effectivePaymentMethod, userId, now, saleOrderId]
  )

  ctx.result = {
    orderNo: saleOrderId,
    saleOrderId,
    totalAmount,
    prepaidCardAmount,
    paidAmount,
    paymentMethod: effectivePaymentMethod,
    status: '待支付',
  }
}

/**
 * 全额抵扣确认支付（扫码页顾客点"确认支付"且 paid_amount=0 时调用）
 * 同事务：SELECT FOR UPDATE balance → 扣减 → INSERT card_transactions → 订单置'已支付'
 */
async function confirmPrepaidFull(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo

  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  await pg.transaction(async (client) => {
    const ordRes = await client.query(
      `SELECT sale_order_id, status, client_user_id, prepaid_card_amount, paid_amount
       FROM sale_orders WHERE sale_order_id = $1`,
      [saleOrderId]
    )
    if (ordRes.rows.length === 0) {
      throw new Error('INVALID_PARAMS: 订单不存在')
    }
    const order = ordRes.rows[0]
    if (order.status !== '待支付') {
      throw new Error('INVALID_PARAMS: 订单状态不允许支付')
    }
    if (order.client_user_id && order.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
    const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
    const paidAmount = Number(order.paid_amount || 0)
    if (paidAmount !== 0) {
      throw new Error('INVALID_PARAMS: 订单非全额抵扣，不能走此通道')
    }
    if (prepaidCardAmount <= 0) {
      throw new Error('INVALID_PARAMS: 订单无储值卡抵扣')
    }

    const cardRows = await client.query(
      `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
      [userId]
    )
    if (cardRows.rows.length === 0) {
      throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
    }
    const cardId = cardRows.rows[0].card_id
    const cardBalance = Number(cardRows.rows[0].balance)
    if (cardBalance + 0.001 < prepaidCardAmount) {
      throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
    }

    // 幂等：若已扣过则跳过写入
    const existDed = await client.query(
      `SELECT 1 FROM card_transactions
       WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
      [saleOrderId]
    )
    if (existDed.rows.length === 0) {
      await client.query(
        `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW()
         WHERE card_id = $2`,
        [prepaidCardAmount, cardId]
      )
      await client.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id)
         VALUES ($1, '扣款', $2, $3)`,
        [cardId, -prepaidCardAmount, saleOrderId]
      )
    }

    await client.query(
      `UPDATE sale_orders
       SET status = '已支付',
           client_user_id = COALESCE(client_user_id, $1),
           paid_at = NOW(),
           updated_at = NOW()
       WHERE sale_order_id = $2 AND status = '待支付'`,
      [userId, saleOrderId]
    )

    // 积分结算（订单链净额差值法，幂等）
    // confirmPrepaidFull 仅对 paid_amount=0 的纯卡抵扣订单：链净额=0 → delta=0 → 无写入（AC-05）
    // 保留调用以保证"所有状态转已支付的触发点"都走同一入口
    await settlePointsSafe(client, saleOrderId, 'clientApi.confirmPrepaidFull')
  })

  ctx.result = {
    status: '已支付',
    saleOrderId,
    orderNo: saleOrderId,
  }
}

/**
 * 继续支付（多次回款） — PR-C（Ticket 2026-04-24 multi-repayment）
 *
 * 顾客对 payable_amount > paid_amount 的未付清订单发起追加付款（微信/支付宝/储值卡）。
 *
 * 入参：
 *   saleOrderId         原销售单号（FY-XSD-...）
 *   paymentMethod       '微信' | '支付宝' | '储值卡'
 *   repayAmount         线上实付金额（微信/支付宝时 > 0，纯储值卡时 = 0）
 *   prepaidCardAmount?  储值卡抵扣金额（可选，默认 0）
 *
 * 事务内：
 *   a. SELECT 原单 FOR UPDATE，校验归属 + status ∈ {'部分支付','待支付'}
 *   b. 校验 repayAmount + prepaidCardAmount > 0 且不超过 (payable_amount - paid_amount)
 *   c. 禁止混合线上（微信/支付宝 + 支付宝/微信 同时）；储值卡可与单一线上组合
 *   d. 生成 FY-HKD-WX-... 凭证单（sale_order_type='回款单', ref_sale_order_id=原单）
 *   e. 若 prepaidCardAmount > 0：扣卡 + INSERT payments(回款/储值卡) status='已支付'
 *   f. 若 repayAmount > 0（线上）：不写 payments（payNotify 回调后补），凭证单 status='待支付'
 *   g. 纯储值卡付清：凭证单直接 '已支付'，重算原单 paid_amount + status
 *
 * 返回：
 *   { repaymentOrderId, status, paymentParams?, paidAmount, prepaidCardAmount, paymentMethod }
 */
async function repay(ctx) {
  const { userId } = ctx.auth
  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  const paymentMethod = payload.paymentMethod
  const repayAmountInput = Number(payload.repayAmount || 0)
  const prepaidCardAmountInput = Number(payload.prepaidCardAmount || 0)

  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }
  if (!['微信', '支付宝', '储值卡'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: paymentMethod 仅支持 微信/支付宝/储值卡')
  }
  if (!Number.isFinite(repayAmountInput) || repayAmountInput < 0) {
    throw new Error('INVALID_PARAMS: repayAmount 无效')
  }
  if (!Number.isFinite(prepaidCardAmountInput) || prepaidCardAmountInput < 0) {
    throw new Error('INVALID_PARAMS: prepaidCardAmount 无效')
  }
  if (Math.round(repayAmountInput * 100) !== repayAmountInput * 100
      || Math.round(prepaidCardAmountInput * 100) !== prepaidCardAmountInput * 100) {
    throw new Error('INVALID_PARAMS: 金额最多保留 2 位小数')
  }
  const totalNew = Math.round((repayAmountInput + prepaidCardAmountInput) * 100) / 100
  if (totalNew <= 0) {
    throw new Error('INVALID_PARAMS: 回款金额必须大于 0')
  }
  // 储值卡通道：repayAmount 必须为 0，prepaidCardAmount 必须 > 0
  if (paymentMethod === '储值卡') {
    if (repayAmountInput > 0) {
      throw new Error('INVALID_PARAMS: 储值卡通道 repayAmount 必须为 0')
    }
    if (prepaidCardAmountInput <= 0) {
      throw new Error('INVALID_PARAMS: 储值卡通道必须指定 prepaidCardAmount')
    }
  } else {
    // 微信/支付宝通道：repayAmount 必须 > 0（可叠加 prepaidCardAmount）
    if (repayAmountInput <= 0) {
      throw new Error('INVALID_PARAMS: 线上通道 repayAmount 必须大于 0')
    }
  }

  // 预生成凭证单号（事务内无 advisory lock 时避免冲突——沿用 create 同模式）
  let repaymentOrderId
  let onlineStatus // 凭证单 status：'已支付'（纯储值卡）或 '待支付'（线上）
  const isPureCard = paymentMethod === '储值卡'
  const now = new Date()

  await pg.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    // 1. 锁原单 + 校验归属 + 状态
    const origRes = await client.query(
      `SELECT * FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE`,
      [saleOrderId]
    )
    if (origRes.rows.length === 0) {
      throw new Error('INVALID_PARAMS: 订单不存在')
    }
    const origOrder = origRes.rows[0]
    if (origOrder.client_user_id && origOrder.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
    if (!['待支付', '部分支付'].includes(origOrder.status)) {
      throw new Error('INVALID_PARAMS: 订单状态不允许回款')
    }
    if (origOrder.sale_order_type !== '销售单') {
      throw new Error('INVALID_PARAMS: 仅销售单支持回款')
    }

    // 2. 计算欠款 = payable_amount - 已到账金额
    const payableAmount = Number(origOrder.payable_amount || 0) > 0
      ? Number(origOrder.payable_amount)
      : Math.round((Number(origOrder.total_amount || 0) - Number(origOrder.prepaid_card_amount || 0)) * 100) / 100
    const paidSumRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS paid_sum
       FROM sale_order_payments
       WHERE sale_order_id = $1
         AND status = '已支付'
         AND change_type IN ('首次支付','回款','退款')`,
      [saleOrderId]
    )
    const alreadyPaid = Number(paidSumRes.rows[0]?.paid_sum || 0)
    // 兼容：若 payments 表为空（尚未有首次到账行），以 sale_orders.paid_amount 列为已到账
    const hasPayments = await client.query(
      `SELECT 1 FROM sale_order_payments WHERE sale_order_id = $1 LIMIT 1`,
      [saleOrderId]
    )
    const effectivePaid = hasPayments.rows.length > 0 ? alreadyPaid : Number(origOrder.paid_amount || 0)
    // 注意：paid_amount 列在旧逻辑下初始化为 "payable - prepaid" 的剩余应付；
    // 新逻辑下应为 "已实际到账"。本 PR 采用 payments 有无行区分：
    //   - 有 payments 行：以 Σ 为准
    //   - 无 payments 行：以 paid_amount 列为"已到账"——但 create 时 paid_amount=payable（非0）,
    //     这意味着订单还没任何支付就无欠款。故直接取 0 更安全。
    const realPaid = hasPayments.rows.length > 0 ? effectivePaid : 0
    const remaining = Math.round((payableAmount - realPaid) * 100) / 100
    if (remaining <= 0) {
      throw new Error('INVALID_PARAMS: 订单无欠款')
    }
    if (totalNew > remaining + 0.001) {
      throw new Error('INVALID_PARAMS: 回款金额超过剩余应付')
    }

    // 3. 储值卡扣款（若有）：校验 + 扣减 + INSERT payments(回款/储值卡) + card_transactions
    let cardIdUsed = null
    if (prepaidCardAmountInput > 0) {
      const cardRes = await client.query(
        `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
        [userId]
      )
      if (cardRes.rows.length === 0
          || Number(cardRes.rows[0].balance) + 0.001 < prepaidCardAmountInput) {
        throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
      }
      cardIdUsed = cardRes.rows[0].card_id
      await client.query(
        `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW()
         WHERE card_id = $2`,
        [prepaidCardAmountInput, cardIdUsed]
      )
    }

    // 4. 生成 FY-HKD 凭证单号（事务+锁内防并发）
    const dateStr = now.toISOString().slice(2, 10).replace(/-/g, '')
    const seqRes = await client.query(
      `SELECT sale_order_id FROM sale_orders
       WHERE sale_order_id LIKE $1
       ORDER BY sale_order_id DESC LIMIT 1`,
      [`FY-HKD-WX-${dateStr}%`]
    )
    let seq = 1
    if (seqRes.rows.length > 0) {
      seq = parseInt(seqRes.rows[0].sale_order_id.slice(-4)) + 1
    }
    repaymentOrderId = `FY-HKD-WX-${dateStr}${String(seq).padStart(4, '0')}`

    // 5. INSERT 凭证单（sale_order_type='回款单' + ref_sale_order_id=原单）
    onlineStatus = isPureCard ? '已支付' : '待支付'
    const repayPaymentMethod = isPureCard
      ? '储值卡'
      : paymentMethod // 微信/支付宝
    // 纯储值卡：total_amount=prepaidCardAmountInput, paid_amount=prepaidCardAmountInput（凭证单闭环）
    // 线上：total_amount = repayAmount + prepaidCardAmount, paid_amount = prepaidCardAmount（已抵扣）
    const credTotal = totalNew
    const credPaid = isPureCard ? credTotal : prepaidCardAmountInput
    const credPrepaid = prepaidCardAmountInput
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, ref_sale_order_id,
        market_name, store_id, sale_order_datetime,
        client_user_id, client_phone, customer_name,
        total_amount, prepaid_card_amount, paid_amount, payable_amount, payment_method,
        paid_at, created_at, updated_at
      ) VALUES ($1, $2, '回款单', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $7, $7)`,
      [
        repaymentOrderId, onlineStatus, origOrder.document_type,
        saleOrderId, origOrder.market_name, origOrder.store_id, now,
        origOrder.client_user_id || userId, origOrder.client_phone, origOrder.customer_name,
        credTotal, credPrepaid, credPaid, repayAmountInput, repayPaymentMethod,
        isPureCard ? now : null,
      ]
    )

    // 6. 若储值卡抵扣 > 0：写 card_transactions(扣款) + payments(回款/储值卡) 到原单
    if (prepaidCardAmountInput > 0 && cardIdUsed) {
      await client.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
         VALUES ($1, '扣款', $2, $3, NOW())`,
        [cardIdUsed, -prepaidCardAmountInput, repaymentOrderId]
      )
      // payments 行：sale_order_id=原单；change_type='回款' + payment_method='储值卡'
      // external_txn_id 为 NULL（储值卡不要求 txn）；CHECK (payment_method NOT IN ('微信','支付宝') OR txn != NULL) 通过
      await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method,
          external_txn_id, status, source_end, operator_employee_id,
          note, created_at, paid_at
        ) VALUES ($1, '回款', $2, '储值卡', NULL, '已支付', 'client', NULL, $3, $4, $4)`,
        [saleOrderId, prepaidCardAmountInput, `储值卡回款 凭证 ${repaymentOrderId}`, now]
      )
    }

    // 7. 线上回款：不写 payments 行（留给 payNotify 回调，对齐 pay/alipayPay 设计）
    //    只更新原单 payment_method 以反映最近回款通道
    if (!isPureCard) {
      await client.query(
        `UPDATE sale_orders SET payment_method = $1, updated_at = $2
         WHERE sale_order_id = $3`,
        [paymentMethod, now, saleOrderId]
      )
    }

    // 8. 重算原单 paid_amount + status（仅在储值卡抵扣写入了 payments 时；线上通道等 payNotify 触发）
    if (prepaidCardAmountInput > 0) {
      const sum2 = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS paid_sum
         FROM sale_order_payments
         WHERE sale_order_id = $1
           AND status = '已支付'
           AND change_type IN ('首次支付','回款','退款')`,
        [saleOrderId]
      )
      const newPaidSum = Number(sum2.rows[0]?.paid_sum || 0)
      const nowPaidRounded = Math.round(newPaidSum * 100) / 100
      const fullyPaid = nowPaidRounded + 0.001 >= payableAmount
      const newStatus = fullyPaid ? '已支付' : '部分支付'
      await client.query(
        `UPDATE sale_orders
         SET status = $1::order_status,
             paid_amount = $2,
             paid_at = CASE WHEN $1::text = '已支付' THEN COALESCE(paid_at, $3) ELSE paid_at END,
             updated_at = $3
         WHERE sale_order_id = $4`,
        [newStatus, nowPaidRounded, now, saleOrderId]
      )

      // 积分结算（纯卡回款时原单 paid_amount 已增加，需要 settle；线上通道等 payNotify 触发）
      await settlePointsSafe(client, saleOrderId, 'clientApi.repay')
    }
  })

  // 返回支付参数（微信/支付宝）或成功状态（储值卡）
  if (isPureCard) {
    ctx.result = {
      repaymentOrderId,
      saleOrderId,
      status: '已支付',
      paymentMethod: '储值卡',
      repayAmount: 0,
      prepaidCardAmount: prepaidCardAmountInput,
      paymentParams: null,
    }
    return
  }

  // 线上通道：返回 mock 支付参数，out_trade_no = repaymentOrderId
  // TODO: 接入真实微信/支付宝统一下单 API
  if (paymentMethod === '微信') {
    ctx.result = {
      repaymentOrderId,
      saleOrderId,
      status: '待支付',
      paymentMethod: '微信',
      repayAmount: repayAmountInput,
      prepaidCardAmount: prepaidCardAmountInput,
      mockMode: true,
      paymentParams: {
        timeStamp: String(Math.floor(Date.now() / 1000)),
        nonceStr: Math.random().toString(36).substr(2),
        package: `prepay_id=wx${Date.now()}`,
        signType: 'MD5',
        paySign: 'mock_sign',
        totalFee: Math.round(repayAmountInput * 100),
      },
    }
    return
  }
  // 支付宝
  ctx.result = {
    repaymentOrderId,
    saleOrderId,
    status: '待支付',
    paymentMethod: '支付宝',
    repayAmount: repayAmountInput,
    prepaidCardAmount: prepaidCardAmountInput,
    mockMode: true,
    qrCodeUrl: `https://qr.alipay.com/mock_${repaymentOrderId}`,
  }
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
  scanDetail,
  scanAdjust,
  confirmPrepaidFull,
  repay,
}
