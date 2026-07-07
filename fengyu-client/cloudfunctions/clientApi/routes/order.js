

const cloud = require('wx-server-sdk')
const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { getMemberThreshold } = require('../utils/config')
const { settlePointsSafe } = require('../utils/points')
const { recalcMemberLevel } = require('../utils/member-level')
const { isMember, resolveUnitPrice } = require('../utils/member-pricing')
const { recalcPaidSessionsForOrder } = require('../utils/paid-sessions')
const { capturePaymentAllocatables, refreshOrderAllocationRollup } = require('../utils/payment-allocatable')
const lakalaClient = require('../utils/lakala-client')
const lakalaConfig = require('../utils/lakala-config')
const { shanghaiYMD, shanghaiYYMMDD } = require('../utils/datetime')


async function resolveLakalaMerchant(storeId) {
  if (!lakalaConfig.isReady()) return null
  if (!storeId) return null
  const rows = await pg.query(
    `SELECT lm.merchant_no, lm.term_no, lm.enabled
       FROM stores s
       JOIN lakala_merchants lm ON lm.id = s.lakala_merchant_id
      WHERE s.store_id = $1`,
    [storeId]
  )
  if (rows.length === 0) return null
  const row = rows[0]
  if (!row.enabled) return null
  const merchantNo = row.merchant_no
  if (!merchantNo) return null
  const termNo = row.term_no
  if (!termNo) {
    throw new Error('INVALID_STATE: LAKALA_TERM_NO_MISSING: 该门店未配置拉卡拉终端号，请联系管理员')
  }
  return { merchantNo, termNo }
}


function getRequestIp() {
  try {
    const ctx = cloud.getWXContext() || {}
    return ctx.CLIENTIP || '0.0.0.0'
  } catch {
    return '0.0.0.0'
  }
}


async function createLakalaPreorder({
  orderNo, merchantNo, termNo,
  payAmountYuan, accountType, transType,
  openid, subAppid, requestIp,
  subject, attach,
}) {
  const totalAmountFen = Math.round(payAmountYuan * 100)
  const outTradeNo = `${orderNo}_${Math.floor(Date.now() / 1000)}`

  const resp = await lakalaClient.requestPreorder({
    merchantNo, termNo, outTradeNo,
    accountType, transType,
    totalAmountFen,
    requestIp: requestIp || '0.0.0.0',
    subject: subject || `凤御美容订单 ${orderNo}`,
    attach: attach || orderNo,
    subAppid, openid,
    timeoutExpressMin: 10,
  })

  
  if (accountType === 'WECHAT' && transType === '71') {
    if (subAppid && resp.lakalaAppId && resp.lakalaAppId !== subAppid) {
      throw new Error(`INVALID_STATE: LAKALA_APPID_MISMATCH: 拉卡拉返回 app_id=${resp.lakalaAppId} 与 sub_appid=${subAppid} 不一致`)
    }
  }

  
  
  
  
  await pg.query(
    'UPDATE sale_orders SET lakala_out_order_no = $1, updated_at = NOW() WHERE sale_order_id = $2',
    [outTradeNo, orderNo]
  )

  if (accountType === 'WECHAT' && transType === '71') {
    return { outTradeNo, tradeNo: resp.tradeNo, paymentParams: resp.paymentParams }
  }
  if (accountType === 'ALIPAY' && transType === '41') {
    return { outTradeNo, tradeNo: resp.tradeNo, alipayQrUrl: resp.alipayQrUrl }
  }
  return { outTradeNo, tradeNo: resp.tradeNo }
}


async function createLakalaAlipayShareCode({
  orderNo, merchantNo, termNo,
  payAmountYuan, requestIp, bizLink,
  outTradeNo,  
}) {
  const cfg = lakalaConfig.readConfig()
  if (!cfg.alipayShareSource) {
    throw new Error('INVALID_STATE: ALIPAY_NOT_AVAILABLE: 暂不支持支付宝，请使用微信支付')
  }
  const totalAmountFen = Math.round(payAmountYuan * 100)
  const resp = await lakalaClient.requestAlipayShareCode({
    merchantNo, termNo, outTradeNo,
    totalAmountFen,
    requestIp: requestIp || '0.0.0.0',
    source: cfg.alipayShareSource,
    bizLink,
  })
  return { shareToken: resp.shareToken, expireDate: resp.expireDate, tradeNo: resp.tradeNo }
}


async function closeExpiredOrder(orderNo) {
  return await pg.transaction(async (client) => {
    const result = await client.query(
      "UPDATE sale_orders SET status = '已关闭', updated_at = NOW() WHERE sale_order_id = $1 AND status = '待支付' AND opened_by IS NULL",
      [orderNo]
    )
    if (result.rowCount > 0) {
      await client.query(
        `UPDATE user_coupons SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
         WHERE used_sale_order_id = $1`,
        [orderNo]
      )
      return true
    }
    return false
  })
}


async function closeExpiredOrdersByUser(userId) {
  const expired = await pg.query(
    `SELECT sale_order_id FROM sale_orders
     WHERE client_user_id = $1 AND status = '待支付' AND opened_by IS NULL
     AND sale_order_datetime < NOW() - INTERVAL '10 minutes'`,
    [userId]
  )
  for (const row of expired) {
    await closeExpiredOrder(row.sale_order_id)
  }
}


async function _loadAndValidateBundle(bundleProductId, items) {
  if (!bundleProductId) return null

  
  const productRows = await pg.query(
    `SELECT product_id, is_bundle FROM products
     WHERE product_id = $1 AND deleted_at IS NULL AND is_visible = true`,
    [bundleProductId]
  )
  if (productRows.length === 0 || !productRows[0].is_bundle) {
    throw new Error('INVALID_PARAMS: BUNDLE_NOT_FOUND: 套餐不存在或已下架')
  }

  
  const groupRows = await pg.query(
    `SELECT id, group_name, pick_count
     FROM mall_bundle_groups WHERE product_id = $1`,
    [bundleProductId]
  )
  
  const mpsRows = await pg.query(
    `SELECT sku_id, bundle_group_id, bundle_price, bundle_list_price
     FROM mall_product_skus WHERE product_id = $1`,
    [bundleProductId]
  )

  
  const skuToBundlePrice = new Map()
  const skuToGroupId = new Map()
  for (const r of mpsRows) {
    skuToBundlePrice.set(r.sku_id, { listPrice: r.bundle_list_price, salePrice: r.bundle_price })
    skuToGroupId.set(r.sku_id, r.bundle_group_id != null ? Number(r.bundle_group_id) : null)
  }

  
  for (const item of items) {
    if (!skuToBundlePrice.has(item.skuId)) {
      throw new Error(`INVALID_PARAMS: BUNDLE_SKU_NOT_BELONG: SKU ${item.skuId} 不属于该套餐`)
    }
  }

  
  
  
  
  const pickedQtyByGroup = new Map()  
  const pickedSkusByGroup = new Map() 
  for (const item of items) {
    const gid = skuToGroupId.get(item.skuId)
    if (gid == null) continue 
    const qty = Number(item.quantity) || 0
    pickedQtyByGroup.set(gid, (pickedQtyByGroup.get(gid) || 0) + qty)
    if (!pickedSkusByGroup.has(gid)) pickedSkusByGroup.set(gid, new Set())
    pickedSkusByGroup.get(gid).add(item.skuId)
  }

  
  const totalSkusByGroup = new Map()
  for (const r of mpsRows) {
    if (r.bundle_group_id == null) continue
    const gid = Number(r.bundle_group_id)
    totalSkusByGroup.set(gid, (totalSkusByGroup.get(gid) || 0) + 1)
  }

  for (const g of groupRows) {
    const gid = Number(g.id)
    if (g.pick_count == null) {
      
      const total = totalSkusByGroup.get(gid) || 0
      const distinct = pickedSkusByGroup.has(gid) ? pickedSkusByGroup.get(gid).size : 0
      if (distinct !== total) {
        throw new Error(`INVALID_PARAMS: BUNDLE_GROUP_PICK_MISMATCH: 组「${g.group_name}」需全选 ${total} 项，实际 ${distinct} 项`)
      }
    } else {
      
      const pickedQty = pickedQtyByGroup.get(gid) || 0
      if (pickedQty !== Number(g.pick_count)) {
        throw new Error(`INVALID_PARAMS: BUNDLE_GROUP_PICK_MISMATCH: 组「${g.group_name}」需选 ${g.pick_count} 件，实际 ${pickedQty} 件`)
      }
    }
  }

  return skuToBundlePrice
}


async function scanDetail(ctx) {
  await requirePhone()(ctx, async () => {})

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

  
  
  

  
  
  const PAYABLE_STATUSES = ['待支付', '部分支付']
  if (!PAYABLE_STATUSES.includes(order.status)) {
    const statusMsgMap = {
      '已支付': '该订单已完成支付',
      '已完成': '该订单已完成',
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

  
  
  
  const items = await pg.query(`
    SELECT
      si.sale_item_id, si.unit_price, si.quantity, si.received,
      si.sale_amount, si.session_count,
      si.product_name,
      (SELECT p.cover_image FROM mall_product_skus mps
       JOIN products p ON mps.product_id = p.product_id
       WHERE mps.sku_id = si.sku_id LIMIT 1) AS cover_image
    FROM sale_items si
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [targetOrderId])

  
  const totalAmount = Number(order.total_amount || 0)
  const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
  const payableAmount = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmount - prepaidCardAmount) * 100) / 100
  const received = Number(order.received || 0)
  const refundedAmount = Number(order.refunded_amount || 0)
  
  const firstPaymentAmount = order.first_payment_amount != null
    ? Number(order.first_payment_amount)
    : null

  ctx.result = {
    order: {
      orderNo: order.sale_order_id,
      status: order.status,
      storeId: order.store_id,
      storeName: order.store_name || '',
      openerName: order.opener_name || '',
      orderType: order.sale_order_type,
      totalAmount,
      prepaidCardAmount,
      payableAmount,
      received,
      refundedAmount,
      firstPaymentAmount,
      paymentMethod: order.payment_method || '微信',
      couponDiscount: Number(order.coupon_discount || 0)
    },
    items: items.map(i => ({
      saleItemId: i.sale_item_id,
      productName: i.product_name,
      unitPrice: i.unit_price,
      quantity: i.quantity,
      
      saleAmount: i.sale_amount,
      sessionCount: i.session_count,
      received: i.received,
      coverImage: i.cover_image || ''
    }))
  }
}


async function create(ctx) {
  
  await requirePhone()(ctx, async () => {})

  const { userId, boundStoreId } = ctx.auth
  const payload = ctx.event.payload

  
  if (!boundStoreId) {
    throw new Error('INVALID_PARAMS: 请先绑定门店后再下单')
  }

  const {
    storeId,
    items, 
    bundleProductId, 
    preferredStaffWfId, 
    paymentMethod, 
    orderType: orderTypeParam, 
    couponId: inputCouponId, 
    useCard, 
    prepaidCardAmount: inputPrepaidCardAmount 
  } = payload

  
  if (Array.isArray(inputCouponId)) {
    throw new Error('INVALID_PARAMS: MULTIPLE_COUPON_NOT_SUPPORTED: 一张订单仅支持 1 张优惠券')
  }

  if (!storeId || !items || !Array.isArray(items) || items.length === 0 || !paymentMethod) {
    throw new Error('INVALID_PARAMS: 参数不完整')
  }

  
  const storeRows = await pg.query(
    `SELECT s.store_id, s.store_name, pm.id AS market_id, pm.name AS market_name
     FROM stores s
     LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
     LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
     WHERE s.store_id = $1`,
    [storeId]
  )
  if (storeRows.length === 0) {
    throw new Error('INVALID_PARAMS: 门店不存在')
  }
  const marketId = storeRows[0].market_id
  const marketName = storeRows[0].market_name || ''

  
  await closeExpiredOrdersByUser(userId)

  
  
  const existingOrders = await pg.query(
    `SELECT sale_order_id FROM sale_orders
     WHERE client_user_id = $1 AND status = '待支付' AND opened_by IS NULL`,
    [userId]
  )
  if (existingOrders.length > 0) {
    const err = new Error('INVALID_PARAMS: 您已有待支付订单，请先完成支付或取消订单')
    err.data = { pendingOrderNo: existingOrders[0].sale_order_id }
    throw err
  }

  const now = new Date()

  
  
  const skuIds = items.map(i => i.skuId)
  const skuResults = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      sk.category_id, sk.is_experience, pc.sales_category
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    WHERE sk.sku_id = ANY($1) AND sk.deleted_at IS NULL
  `, [skuIds])

  
  const skuMap = {}
  for (const sku of skuResults) {
    skuMap[sku.sku_id] = sku
  }

  
  for (const item of items) {
    if (!skuMap[item.skuId]) {
      throw new Error(`INVALID_PARAMS: 商品 ${item.skuId} 不存在`)
    }
  }

  
  
  let customerName = null
  let documentType = '售前'
  let buyerIsMember = false
  {
    const userRows = await pg.query(
      'SELECT name, customer_type, member_level FROM client_wechat_users WHERE user_id = $1',
      [userId]
    )
    if (userRows.length > 0) {
      if (userRows[0].name) customerName = userRows[0].name
      if (userRows[0].customer_type === '会员客') documentType = '售后'
      buyerIsMember = isMember(userRows[0].customer_type, userRows[0].member_level)
    }
  }

  
  
  
  
  
  
  const bundlePriceMap = await _loadAndValidateBundle(bundleProductId, items)

  
  
  
  let totalAmount = 0
  const itemsData = items.map(item => {
    const sku = skuMap[item.skuId]
    
    const bundleEntry = bundlePriceMap ? bundlePriceMap.get(item.skuId) : null
    
    const resolved = resolveUnitPrice(sku, buyerIsMember)
    const listUnit = bundleEntry && bundleEntry.listPrice != null   
      ? Number(bundleEntry.listPrice)
      : resolved.listUnit
    const basePrice = bundleEntry && bundleEntry.salePrice != null  
      ? Number(bundleEntry.salePrice)
      : resolved.realUnit
    const quantity = item.quantity || 1
    
    const sessionCount = sku.session_count != null ? Number(sku.session_count) * quantity : null
    const saleAmount = Math.round(basePrice * quantity * 100) / 100   
    const listTotal = Math.round(listUnit * quantity * 100) / 100     
    
    const denom = (sessionCount != null && sessionCount > 0) ? sessionCount : quantity
    const unitRealPrice = denom > 0 ? Math.round((saleAmount / denom) * 100) / 100 : saleAmount
    const unitPrice = denom > 0 ? Math.round((listTotal / denom) * 100) / 100 : listTotal
    totalAmount += saleAmount
    return {
      skuId: item.skuId,
      productName: sku.spec_name,
      productType: sku.product_type,
      sessionCount,
      remainingSessions: sessionCount,
      listUnit,                       
      unitPrice,
      unitRealPrice,
      quantity,
      saleAmount,
      received: saleAmount,
      salesCategory: sku.sales_category || null,
      isExperience: !!sku.is_experience
    }
  })
  totalAmount = Math.round(totalAmount * 100) / 100

  
  

  
  let couponDiscount = 0
  let couponInfo = null
  if (inputCouponId) {
    
    const couponRows = await pg.query(
      `SELECT uc.coupon_id, uc.user_id, uc.expire_at,
              ct.coupon_type,
              COALESCE(uc.face_value_override, ct.discount_value) AS discount_value,
              ct.min_spend, ct.max_discount,
              ct.applicable_category_ids, ct.applicable_store_ids,
              ct.applicable_product_ids, ct.applicable_market_ids
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

    
    if (couponInfo.applicable_store_ids && couponInfo.applicable_store_ids.length > 0) {
      if (!couponInfo.applicable_store_ids.includes(storeId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此门店')
      }
    }

    
    if (couponInfo.applicable_market_ids && couponInfo.applicable_market_ids.length > 0) {
      if (!marketId || !couponInfo.applicable_market_ids.includes(marketId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此市场')
      }
    }

    
    
    const skuMeta = await pg.query(
      `SELECT ps.sku_id, ps.category_id, mps.product_id
       FROM product_skus ps
       LEFT JOIN mall_product_skus mps ON ps.sku_id = mps.sku_id
       WHERE ps.sku_id = ANY($1) AND ps.deleted_at IS NULL`,
      [skuIds]
    )
    const skuCatMap = new Map()
    const skuProductMap = new Map()
    for (const r of skuMeta) {
      skuCatMap.set(r.sku_id, r.category_id)
      skuProductMap.set(r.sku_id, r.product_id)
    }

    
    
    
    
    let eligibleItems
    if (couponInfo.applicable_category_ids && couponInfo.applicable_category_ids.length > 0) {
      if (couponInfo.applicable_product_ids && couponInfo.applicable_product_ids.length > 0) {
        
        eligibleItems = itemsData.filter(d =>
          couponInfo.applicable_category_ids.includes(skuCatMap.get(d.skuId)) &&
          couponInfo.applicable_product_ids.includes(skuProductMap.get(d.skuId))
        )
      } else {
        
        eligibleItems = itemsData.filter(d =>
          couponInfo.applicable_category_ids.includes(skuCatMap.get(d.skuId))
        )
      }
    } else if (couponInfo.applicable_product_ids && couponInfo.applicable_product_ids.length > 0) {
      
      eligibleItems = itemsData.filter(d =>
        couponInfo.applicable_product_ids.includes(skuProductMap.get(d.skuId))
      )
    } else {
      
      eligibleItems = itemsData
    }
    if (eligibleItems.length === 0) {
      throw new Error('INVALID_PARAMS: 该优惠券不适用于当前商品')
    }

    
    const eligibleTotalRaw = eligibleItems.reduce((s, d) => s + d.saleAmount, 0)
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

    
    
    
    let distributedDiscount = 0
    for (let i = 0; i < eligibleItems.length; i++) {
      const item = eligibleItems[i]
      let share
      if (i === eligibleItems.length - 1) {
        share = couponDiscount - distributedDiscount
      } else {
        share = Math.round(couponDiscount * (item.saleAmount / eligibleTotal) * 100) / 100
        distributedDiscount += share
      }
      item.saleAmount = Math.max(0, Math.round((item.saleAmount - share) * 100) / 100)
      item.received = item.saleAmount
    }

    
    
    
    for (const d of itemsData) {
      const denom = (d.sessionCount != null && d.sessionCount > 0) ? d.sessionCount : (d.quantity || 1)
      const listTotalRow = Math.round(Number(d.listUnit || 0) * (d.quantity || 1) * 100) / 100
      d.unitRealPrice = denom > 0
        ? Math.round((Number(d.saleAmount || 0) / denom) * 100) / 100
        : Number(d.saleAmount || 0)
      d.unitPrice = denom > 0
        ? Math.round((listTotalRow / denom) * 100) / 100
        : listTotalRow
    }

    totalAmount = itemsData.reduce((s, d) => s + d.saleAmount, 0)
    totalAmount = Math.round(totalAmount * 100) / 100
  }

  
  if (documentType === '售前') {
    const threshold = await getMemberThreshold()
    if (totalAmount >= threshold) documentType = '售后'
  }

  
  let orderNo
  let finalPrepaidCardAmount = 0
  let finalPaidAmount = totalAmount
  let finalPaymentMethod = paymentMethod
  let cardIdForDeduction = null
  let prepaidFullPaid = false
  
  
  
  let zeroPayable = false
  await pg.transaction(async (client) => {
    
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    
    
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
        
        if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) {
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
    finalPrepaidCardAmount = prepaidCardAmount
    finalPaidAmount = paidAmount
    finalPaymentMethod = effectivePaymentMethod
    cardIdForDeduction = cardId
    prepaidFullPaid = paidAmount === 0 && prepaidCardAmount > 0
    zeroPayable = paidAmount === 0  

    
    const dateStrOrder = shanghaiYYMMDD(now)
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

    
    const today = new Date()
    const dateStr = shanghaiYMD(today)
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

    
    
    
    
    
    const initialStatus = zeroPayable ? '已支付' : '待支付'
    const initialReceived = zeroPayable ? prepaidCardAmount : 0
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, prepaid_card_amount, received, payable_amount, payment_method,
        preferred_employee_id, coupon_id, coupon_discount,
        paid_at, created_at, updated_at
      ) VALUES ($1, $2, '销售单', $3, $4, $5, (SELECT store_name FROM stores WHERE store_id = $5), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $6, $6)`,
      [
        orderNo, initialStatus, documentType, marketName, storeId, now, userId,
        ctx.auth.phone || null, customerName,
        totalAmount, prepaidCardAmount, initialReceived, paidAmount, effectivePaymentMethod,
        preferredStaffWfId || null, inputCouponId || null, couponDiscount,
        zeroPayable ? now : null
      ]
    )

    
    
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

    
    for (let i = 0; i < itemsData.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemsData[i]
      
      
      
      await client.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, sku_id,
          product_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price,
          sale_amount, received, pending_received, sales_category, is_experience
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '0', $13, $14, $15)`,
        [
          saleItemId, orderNo, storeId, d.skuId,
          d.productName, d.productType,
          d.sessionCount, d.remainingSessions,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount, d.received, d.salesCategory || null, d.isExperience
        ]
      )
    }

    

    
    if (prepaidFullPaid) {
      
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
          `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
           VALUES ($1, '扣款', $2, $3, $4)
           ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
          [cardIdForDeduction, -prepaidCardAmount, orderNo, `card-deduct-${orderNo}`]
        )
        
        
        const fullCardPayRes = await client.query(
          `INSERT INTO sale_order_payments (
            sale_order_id, change_type, amount, payment_method,
            external_txn_id, status, source_end, created_at, paid_at
          ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'client', $3, $3)
          RETURNING id`,
          [orderNo, prepaidCardAmount, now]
        )
        
        
        const fullCardPaymentId = fullCardPayRes.rows[0] && fullCardPayRes.rows[0].id
        if (fullCardPaymentId && prepaidCardAmount > 0) {
          await capturePaymentAllocatables(client, {
            salePaymentId: fullCardPaymentId,
            saleOrderId: orderNo,
            eventAmount: prepaidCardAmount,
            directedItems: null,
          })
          await refreshOrderAllocationRollup(client, orderNo)
        }
      }
    }

    
    
    
    await recalcPaidSessionsForOrder(client, orderNo)

    
    
    
    
    if (zeroPayable) {
      await settlePointsSafe(client, orderNo, 'clientApi.create.zeroPayable')
      await recalcMemberLevel(client, userId, await getMemberThreshold(), 'clientApi')
    }
  })

  if (zeroPayable) {
    ctx.result = {
      orderNo,
      saleOrderId: orderNo,
      totalAmount,
      prepaidCardAmount: finalPrepaidCardAmount,
      paidAmount: finalPaidAmount,
      paymentMethod: finalPaymentMethod,
      status: '已支付',
      
      
      reason: finalPrepaidCardAmount > 0 ? 'prepaid_card_full' : 'coupon_full',
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


async function calcPaymentRemaining(orderNo, orderRow) {
  const totalAmount = Number(orderRow.total_amount || 0)
  const prepaidCardAmount = Number(orderRow.prepaid_card_amount || 0)
  const payableAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100

  
  
  const rows = await pg.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid_sum
     FROM sale_order_payments
     WHERE sale_order_id = $1
       AND status = '已支付'
       AND change_type IN ('首次支付','回款','储值卡抵扣','退款')`,
    [orderNo]
  )
  const paidSum = Number(rows[0]?.paid_sum || 0)
  const remaining = Math.round((payableAmount - paidSum) * 100) / 100
  return { payableAmount, paidSum, remaining }
}


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

  
  
  if (order.status === '待支付') {
    const orderTime = new Date(order.sale_order_datetime)
    if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
      const closed = await closeExpiredOrder(orderNo)
      if (closed) throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
    }
  }

  const now = new Date()

  
  
  const totalAmount0 = Number(order.total_amount || 0)
  const prepaidCardAmount0 = Number(order.prepaid_card_amount || 0)
  const payableAmount0 = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmount0 - prepaidCardAmount0) * 100) / 100
  if (payableAmount0 === 0 && order.status === '待支付') {
    ctx.result = {
      orderNo,
      status: '已支付',
      reason: 'prepaid_card_full',
      paymentParams: null,
    }
    return
  }

  
  const { remaining } = await calcPaymentRemaining(orderNo, order)
  const effectiveRemaining = remaining

  
  let thisPayAmount
  if (payAmountInput !== undefined && payAmountInput !== null) {
    const v = Number(payAmountInput)
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error('INVALID_PARAMS: 支付金额无效')
    }
    
    if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) {
      throw new Error('INVALID_PARAMS: 支付金额最多保留 2 位小数')
    }
    if (v > effectiveRemaining + 0.001) {
      throw new Error('INVALID_PARAMS: 支付金额超过剩余应付')
    }
    thisPayAmount = Math.round(v * 100) / 100
  } else {
    thisPayAmount = effectiveRemaining
  }

  
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

  const merchant = await resolveLakalaMerchant(order.store_id)
  if (!merchant) {
    throw new Error('INVALID_STATE: LAKALA_NOT_CONFIGURED: 该门店未启用拉卡拉聚合支付，请联系管理员')
  }
  const cfg = lakalaConfig.readConfig()
  const { paymentParams } = await createLakalaPreorder({
    orderNo,
    merchantNo: merchant.merchantNo,
    termNo: merchant.termNo,
    payAmountYuan: thisPayAmount,
    accountType: 'WECHAT',
    transType: '71',
    openid: ctx.auth.openid,
    subAppid: cfg.subAppid,
    requestIp: getRequestIp(),
  })
  
  
  await pg.query(
    'UPDATE sale_orders SET first_payment_amount = NULL, updated_at = $1 WHERE sale_order_id = $2 AND first_payment_amount IS NOT NULL',
    [now, orderNo]
  )
  ctx.result = {
    orderNo,
    totalAmount,
    paidAmount: thisPayAmount,
    paymentMethod: '微信',
    paymentParams,  
  }
}


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

  
  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许付款')
  }

  
  const orderTimeOffline = new Date(order.sale_order_datetime)
  if (Date.now() - orderTimeOffline.getTime() > 10 * 60 * 1000) {
    const closed = await closeExpiredOrder(orderNo)
    if (closed) throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
  }

  
  const totalAmountOff = Number(order.total_amount || 0)
  const prepaidCardAmountOff = Number(order.prepaid_card_amount || 0)
  const payableAmountOff = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmountOff - prepaidCardAmountOff) * 100) / 100
  if (payableAmountOff === 0) {
    ctx.result = {
      orderNo,
      status: '已支付',
      reason: 'prepaid_card_full',
    }
    return
  }

  const now = new Date()
  const offlineUpd = await pg.query(
    "UPDATE sale_orders SET client_user_id = COALESCE(client_user_id, $1), payment_method = '线下', updated_at = $2 WHERE sale_order_id = $3 AND status = '待支付'",
    [userId, now, orderNo]
  )
  if (offlineUpd.rowCount === 0) {
    throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:sale_orders:${orderNo}:待支付→线下锁定`)
  }

  
  

  ctx.result = {
    orderNo,
    status: '待支付',
    message: '已选择线下支付,请到店付款'
  }
}


async function list(ctx) {
  const { userId } = ctx.auth
  const { status, statuses, page: pageParam, pageSize: pageSizeParam } = ctx.event.payload || {}

  
  const pageSize = Math.min(Math.max(Number(pageSizeParam) || 20, 1), 50)
  const page = Math.max(Number(pageParam) || 1, 1)
  const offset = (page - 1) * pageSize

  
  if (page === 1) {
    await closeExpiredOrdersByUser(userId)
  }

  let whereClause = 'WHERE o.client_user_id = $1'
  const params = [userId]

  
  
  if (Array.isArray(statuses) && statuses.length > 0) {
    params.push(statuses)
    whereClause += ` AND o.status = ANY($${params.length})`
  } else if (status) {
    params.push(status)
    whereClause += ` AND o.status = $${params.length}`
  }

  
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
      o.payable_amount,
      o.prepaid_card_amount,
      o.received,
      o.refunded_amount,
      o.created_at
    FROM sale_orders o
    LEFT JOIN stores s ON o.store_id = s.store_id
    ${whereClause}
    ORDER BY o.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params)

  const hasMore = orders.length > pageSize
  if (hasMore) orders.pop()

  
  if (orders.length > 0) {
    const orderIds = orders.map(o => o.sale_order_id)
    const items = await pg.query(`
      SELECT
        si.sale_order_id,
        si.sale_item_id,
        si.quantity,
        si.received,
        si.sale_amount,
        si.session_count,
        si.remaining_sessions,
        si.paid_sessions,
        si.product_name,
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

  
  
  if (order.status === '待支付') {
    const orderTime = new Date(order.sale_order_datetime)
    if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
      const closed = await closeExpiredOrder(orderNo)
      if (closed) order.status = '已关闭'
    }
  }

  
  const items = await pg.query(`
    SELECT
      si.sale_item_id,
      si.sku_id,
      si.product_name,
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.paid_sessions,
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

  
  let expireAt = null
  if (order.status === '待支付') {
    expireAt = new Date(new Date(order.sale_order_datetime).getTime() + 10 * 60 * 1000).toISOString()
  }

  
  
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
      `SELECT id, change_type, amount, payment_method, status,
              paid_at, created_at,
              note, refund_reason, audit_employee_id, audit_at, audit_remark
       FROM sale_order_payments
       WHERE sale_order_id = $1
       ORDER BY created_at ASC, id ASC`,
      [orderNo]
    )
  ])

  
  const payments = paymentRows.map(p => ({
    change_type: p.change_type,
    amount: Number(p.amount),
    payment_method: p.payment_method,
    status: p.status,
    paid_at: p.paid_at,
    created_at: p.created_at,
    note: p.note,
    refund_reason: p.refund_reason || null,
    audit_at: p.audit_at || null,
    audit_remark: p.audit_remark || null,
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

  
  
  
  const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
  const totalAmountCnl = Number(order.total_amount || 0)
  const payableAmountCnl = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmountCnl - prepaidCardAmount) * 100) / 100
  const isPrepaidFull = prepaidCardAmount > 0 && payableAmountCnl === 0
  const cancelableStatuses = ['待支付']
  if (isPrepaidFull && order.status === '已支付') {
    
    cancelableStatuses.push('已支付')
  }
  if (!cancelableStatuses.includes(order.status)) {
    throw new Error('INVALID_PARAMS: 当前订单状态不允许取消')
  }

  const now = new Date()
  await pg.transaction(async (client) => {
    
    let hasDeducted = false
    if (prepaidCardAmount > 0) {
      const existDed = await client.query(
        `SELECT id FROM card_transactions
         WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
        [orderNo]
      )
      hasDeducted = existDed.rows.length > 0
    }

    
    
    const allowedStatusList = cancelableStatuses 
    const updRes = await client.query(
      `UPDATE sale_orders SET status = '已关闭', updated_at = $1
       WHERE sale_order_id = $2
         AND client_user_id = $3
         AND status = ANY($4::order_status[])`,
      [now, orderNo, userId, allowedStatusList]
    )
    if (updRes.rowCount !== 1) {
      throw new Error('CONFLICT: 订单状态已变更，请刷新后重试')
    }
    
    await client.query(
      `UPDATE user_coupons
       SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
       WHERE used_sale_order_id = $1`,
      [orderNo]
    )

    
    if (hasDeducted) {
      
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
            `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
             VALUES ($1, '充值', $2, $3, $4)
             ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
            [cardId, prepaidCardAmount, orderNo, `card-cancel-rev-${orderNo}`]
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
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.paid_sessions,
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
      AND si.product_type = '疗程卡'
      -- 在途退款冻结：原订单存在 '待审批' 退款时排除整单的卡
      AND NOT EXISTS (
        SELECT 1 FROM sale_order_payments sop
        WHERE sop.sale_order_id = o.sale_order_id
          AND sop.change_type = '退款' AND sop.status = '待审批'
      )
      -- 审批后隐藏已退完的卡：仅当订单存在已审批退款时按 paid_sessions 有效余量判定（不影响无退款的分期卡）
      AND (
        NOT EXISTS (
          SELECT 1 FROM sale_order_payments sop
          WHERE sop.sale_order_id = o.sale_order_id
            AND sop.change_type = '退款' AND sop.status = '已支付'
        )
        OR si.paid_sessions IS NULL
        OR si.paid_sessions > (si.session_count - si.remaining_sessions)
      )
    ORDER BY o.paid_at DESC, si.sale_item_id
  `, [userId])

  
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
      productType: item.product_type,
      sessionCount: item.session_count,
      remainingSessions: item.remaining_sessions,
      paidSessions: item.paid_sessions,
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

  
  if (order.status === '待支付') {
    const orderTimeAlipay = new Date(order.sale_order_datetime)
    if (Date.now() - orderTimeAlipay.getTime() > 10 * 60 * 1000) {
      const closed = await closeExpiredOrder(orderNo)
      if (closed) throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
    }
  }

  const totalAmount = Number(order.total_amount || 0)

  
  
  const prepaidCardAmountAli = Number(order.prepaid_card_amount || 0)
  const payableAmountAli = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmount - prepaidCardAmountAli) * 100) / 100
  if (payableAmountAli === 0 && order.status === '待支付') {
    ctx.result = {
      orderNo,
      status: '已支付',
      reason: 'prepaid_card_full',
      paymentParams: null,
    }
    return
  }

  
  const { remaining } = await calcPaymentRemaining(orderNo, order)
  const effectiveRemaining = remaining

  let thisPayAmount
  if (payAmountInput !== undefined && payAmountInput !== null) {
    const v = Number(payAmountInput)
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error('INVALID_PARAMS: 支付金额无效')
    }
    
    if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) {
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

  const merchantAli = await resolveLakalaMerchant(order.store_id)
  if (!merchantAli) {
    throw new Error('INVALID_STATE: LAKALA_NOT_CONFIGURED: 该门店未启用拉卡拉聚合支付，请联系管理员')
  }
  const cfgAli = lakalaConfig.readConfig()
  if (!cfgAli.alipayShareSource) {
    throw new Error('INVALID_STATE: ALIPAY_NOT_AVAILABLE: 暂不支持支付宝，请使用微信支付')
  }
  const requestIpAli = getRequestIp()
  
  const preorderRespAli = await createLakalaPreorder({
    orderNo,
    merchantNo: merchantAli.merchantNo,
    termNo: merchantAli.termNo,
    payAmountYuan: thisPayAmount,
    accountType: 'ALIPAY',
    transType: '41',
    requestIp: requestIpAli,
  })
  
  const shareCodeResp = await createLakalaAlipayShareCode({
    orderNo,
    merchantNo: merchantAli.merchantNo,
    termNo: merchantAli.termNo,
    outTradeNo: preorderRespAli.outTradeNo,
    payAmountYuan: thisPayAmount,
    requestIp: requestIpAli,
    bizLink: preorderRespAli.alipayQrUrl,
  })
  
  
  
  await pg.query(
    'UPDATE sale_orders SET first_payment_amount = NULL, updated_at = $1 WHERE sale_order_id = $2 AND first_payment_amount IS NOT NULL',
    [now, orderNo]
  )
  ctx.result = {
    orderNo,
    totalAmount,
    paidAmount: thisPayAmount,
    paymentMethod: '支付宝',
    alipayShareToken: shareCodeResp.shareToken,
    alipayExpireDate: shareCodeResp.expireDate,
    status: order.status,
  }
}


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

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许调整')
  }
  
  if (!order.opened_by && !order.client_user_id) {
    throw new Error('INVALID_PARAMS: 订单归属未确定')
  }
  if (order.client_user_id && order.client_user_id !== userId) {
    throw new Error('PERMISSION_DENIED: 无权操作该订单')
  }

  const totalAmount = Number(order.total_amount || 0)

  
  
  let cardBalance = 0
  const cardRows = await pg.query(
    'SELECT card_id, balance, updated_at FROM prepaid_cards WHERE user_id = $1',
    [userId]
  )
  if (cardRows.length > 0) {
    cardBalance = Number(cardRows[0].balance)
  }

  
  let prepaidCardAmount = 0
  if (useCard) {
    const cap = Math.round(totalAmount * 100) / 100
    if (inputPrepaidCardAmount !== undefined && inputPrepaidCardAmount !== null) {
      const v = Number(inputPrepaidCardAmount)
      if (!Number.isFinite(v) || v < 0) {
        throw new Error('INVALID_PARAMS: 储值卡抵扣金额无效')
      }
      
      if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) {
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
         payable_amount = $2,
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
    
    balanceSnapshot: cardRows.length > 0 ? {
      cardId: cardRows[0].card_id,
      balance: Number(cardRows[0].balance),
      updatedAt: cardRows[0].updated_at,
    } : null,
  }
}


async function confirmPrepaidFull(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  
  
  const expectedBalanceUpdatedAt = payload.expectedBalanceUpdatedAt

  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  await pg.transaction(async (client) => {
    const ordRes = await client.query(
      `SELECT sale_order_id, status, client_user_id, prepaid_card_amount, payable_amount, total_amount
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
    const payableAmount = Number(order.payable_amount || 0) > 0
      ? Number(order.payable_amount)
      : Math.round((Number(order.total_amount || 0) - prepaidCardAmount) * 100) / 100
    if (payableAmount !== 0) {
      throw new Error('INVALID_PARAMS: 订单非全额抵扣，不能走此通道')
    }
    if (prepaidCardAmount <= 0) {
      throw new Error('INVALID_PARAMS: 订单无储值卡抵扣')
    }

    const cardRows = await client.query(
      `SELECT card_id, balance, updated_at FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
      [userId]
    )
    if (cardRows.rows.length === 0) {
      throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
    }
    const cardId = cardRows.rows[0].card_id
    const cardBalance = Number(cardRows.rows[0].balance)
    
    
    
    if (expectedBalanceUpdatedAt) {
      const lockedTs = new Date(cardRows.rows[0].updated_at).getTime()
      const expectedTs = new Date(expectedBalanceUpdatedAt).getTime()
      if (!Number.isFinite(expectedTs) || lockedTs !== expectedTs) {
        throw new Error('CONFLICT: 储值卡余额已变动，请刷新页面后重新选择抵扣金额')
      }
    }
    if (cardBalance + 0.001 < prepaidCardAmount) {
      throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
    }

    
    const existDed = await client.query(
      `SELECT 1 FROM card_transactions
       WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
      [saleOrderId]
    )
    let cardPaymentId = null
    if (existDed.rows.length === 0) {
      await client.query(
        `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW()
         WHERE card_id = $2`,
        [prepaidCardAmount, cardId]
      )
      await client.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
         VALUES ($1, '扣款', $2, $3, $4)
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
        [cardId, -prepaidCardAmount, saleOrderId, `card-deduct-${saleOrderId}`]
      )
      
      
      const cardPayRes = await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method,
          external_txn_id, status, source_end, created_at, paid_at
        ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'client', NOW(), NOW())
        RETURNING id`,
        [saleOrderId, prepaidCardAmount]
      )
      cardPaymentId = cardPayRes.rows[0] && cardPayRes.rows[0].id
    }

    
    
    await client.query(
      `UPDATE sale_orders so
       SET received = COALESCE((
             SELECT SUM(amount) FROM sale_order_payments
             WHERE sale_order_id = so.sale_order_id
               AND status = '已支付'
               AND change_type IN ('首次支付','回款','储值卡抵扣')
           ), 0),
           refunded_amount = COALESCE((
             SELECT -SUM(amount) FROM sale_order_payments
             WHERE sale_order_id = so.sale_order_id
               AND status = '已支付'
               AND change_type = '退款'
           ), 0),
           status = '已支付',
           client_user_id = COALESCE(client_user_id, $1),
           paid_at = COALESCE(paid_at, NOW()),
           updated_at = NOW()
       WHERE so.sale_order_id = $2 AND so.status = '待支付'`,
      [userId, saleOrderId]
    )

    
    
    if (cardPaymentId && prepaidCardAmount > 0) {
      await capturePaymentAllocatables(client, {
        salePaymentId: cardPaymentId,
        saleOrderId,
        eventAmount: prepaidCardAmount,
        directedItems: null,
      })
      await refreshOrderAllocationRollup(client, saleOrderId)
    }

    
    
    
    await recalcPaidSessionsForOrder(client, saleOrderId)

    
    
    
    await settlePointsSafe(client, saleOrderId, 'clientApi.confirmPrepaidFull')

    
    await recalcMemberLevel(client, userId, await getMemberThreshold(), 'clientApi')
  })

  ctx.result = {
    status: '已支付',
    saleOrderId,
    orderNo: saleOrderId,
  }
}


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
  if (!['微信', '支付宝', '储值卡', '线下'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 支付方式仅支持 微信/支付宝/储值卡/线下')
  }
  if (!Number.isFinite(repayAmountInput) || repayAmountInput < 0) {
    throw new Error('INVALID_PARAMS: 还款金额无效')
  }
  if (!Number.isFinite(prepaidCardAmountInput) || prepaidCardAmountInput < 0) {
    throw new Error('INVALID_PARAMS: 储值卡抵扣金额无效')
  }
  
  if (Math.abs(Math.round(repayAmountInput * 100) - repayAmountInput * 100) > 1e-6
      || Math.abs(Math.round(prepaidCardAmountInput * 100) - prepaidCardAmountInput * 100) > 1e-6) {
    throw new Error('INVALID_PARAMS: 金额最多保留 2 位小数')
  }
  const totalNew = Math.round((repayAmountInput + prepaidCardAmountInput) * 100) / 100
  if (totalNew <= 0) {
    throw new Error('INVALID_PARAMS: 回款金额必须大于 0')
  }
  
  if (paymentMethod === '储值卡') {
    if (repayAmountInput > 0) {
      throw new Error('INVALID_PARAMS: 储值卡通道 repayAmount 必须为 0')
    }
    if (prepaidCardAmountInput <= 0) {
      throw new Error('INVALID_PARAMS: 储值卡通道必须指定 prepaidCardAmount')
    }
  } else {
    
    if (repayAmountInput <= 0) {
      throw new Error('INVALID_PARAMS: 线上/线下通道 repayAmount 必须大于 0')
    }
  }
  
  if (paymentMethod === '线下' && prepaidCardAmountInput > 0) {
    throw new Error('INVALID_PARAMS: 线下通道不支持储值卡抵扣')
  }

  const isPureCard = paymentMethod === '储值卡'
  const isOffline = paymentMethod === '线下'
  const now = new Date()
  let finalStatus 
  let currentStatus 
  let storeId    

  await pg.transaction(async (client) => {
    
    const origRes = await client.query(
      `SELECT * FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE`,
      [saleOrderId]
    )
    if (origRes.rows.length === 0) {
      throw new Error('INVALID_PARAMS: 订单不存在')
    }
    const origOrder = origRes.rows[0]
    storeId = origOrder.store_id
    if (origOrder.client_user_id && origOrder.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
    if (!['待支付', '部分支付'].includes(origOrder.status)) {
      throw new Error('INVALID_STATE: 订单状态不允许回款')
    }
    if (origOrder.sale_order_type !== '销售单') {
      throw new Error('INVALID_PARAMS: 仅销售单支持回款')
    }
    currentStatus = origOrder.status

    
    const payableAmount = Number(origOrder.payable_amount || 0) > 0
      ? Number(origOrder.payable_amount)
      : Math.round((Number(origOrder.total_amount || 0) - Number(origOrder.prepaid_card_amount || 0)) * 100) / 100
    const received = Number(origOrder.received || 0)
    const refundedAmount = Number(origOrder.refunded_amount || 0)
    const netReceived = Math.round((received - refundedAmount) * 100) / 100
    const remaining = Math.round((payableAmount - netReceived) * 100) / 100
    if (remaining <= 0) {
      throw new Error('INVALID_STATE: 订单无欠款')
    }
    if (totalNew > remaining + 0.001) {
      throw new Error('INVALID_PARAMS: 回款金额超过剩余应付')
    }
    
    
    if (totalNew + 0.001 < remaining) {
      throw new Error('INVALID_PARAMS: 继续支付必须支付全部未付金额')
    }

    
    
    
    let cardPaymentId = null
    await client.query(
      `UPDATE sale_order_payments SET status = '已作废'
       WHERE sale_order_id = $1 AND change_type = '储值卡抵扣' AND status = '待支付'`,
      [saleOrderId]
    )
    
    
    
    if (prepaidCardAmountInput > 0 && isPureCard) {
      const cardRes = await client.query(
        `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
        [userId]
      )
      if (cardRes.rows.length === 0
          || Number(cardRes.rows[0].balance) + 0.001 < prepaidCardAmountInput) {
        throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
      }
      const cardIdUsed = cardRes.rows[0].card_id
      await client.query(
        `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW()
         WHERE card_id = $2`,
        [prepaidCardAmountInput, cardIdUsed]
      )
      
      await client.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
         VALUES ($1, '扣款', $2, $3, $4, NOW())
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
        [cardIdUsed, -prepaidCardAmountInput, saleOrderId, `card-repay-${saleOrderId}-${now.getTime()}`]
      )
      
      
      
      
      const cardPayRes = await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method,
          external_txn_id, status, source_end, note, created_at, paid_at
        ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'client', $3, $4, $4)
        RETURNING id`,
        [saleOrderId, prepaidCardAmountInput, '储值卡继续支付（client.repay）', now]
      )
      cardPaymentId = cardPayRes.rows[0] && cardPayRes.rows[0].id
    } else if (prepaidCardAmountInput > 0) {
      
      
      
      const cardRes = await client.query(
        `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE`,
        [userId]
      )
      if (cardRes.rows.length === 0
          || Number(cardRes.rows[0].balance) + 0.001 < prepaidCardAmountInput) {
        throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
      }
      await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method,
          external_txn_id, status, source_end, note, created_at, paid_at
        ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '待支付', 'client', $3, $4, NULL)`,
        [saleOrderId, prepaidCardAmountInput, '储值卡抵扣待线上到账（client.repay 混合支付）', now]
      )
    }

    
    if (!isPureCard) {
      
      await client.query(
        `UPDATE sale_orders SET payment_method = $1, updated_at = $2
         WHERE sale_order_id = $3`,
        [paymentMethod, now, saleOrderId]
      )
    }

    
    
    if (isPureCard && prepaidCardAmountInput > 0) {
      const aggRes = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣') THEN amount END), 0) AS received_sum,
           COALESCE(-SUM(CASE WHEN status='已支付' AND change_type='退款' THEN amount END), 0) AS refunded_sum
         FROM sale_order_payments
         WHERE sale_order_id = $1`,
        [saleOrderId]
      )
      const newReceived = Math.round(Number(aggRes.rows[0]?.received_sum || 0) * 100) / 100
      const newRefunded = Math.round(Number(aggRes.rows[0]?.refunded_sum || 0) * 100) / 100
      const newNet = Math.round((newReceived - newRefunded) * 100) / 100
      const fullyPaid = newNet + 0.001 >= payableAmount
      finalStatus = fullyPaid ? '已支付' : '部分支付'
      
      
      
      const repayUpd = await client.query(
        `UPDATE sale_orders
         SET status = $1::order_status,
             received = $2,
             refunded_amount = $3,
             prepaid_card_amount = COALESCE(prepaid_card_amount, 0) + $6,
             payable_amount = COALESCE(payable_amount, total_amount) - $6,
             paid_at = CASE WHEN $1::text = '已支付' THEN COALESCE(paid_at, $4) ELSE paid_at END,
             updated_at = $4
         WHERE sale_order_id = $5
           AND status IN ('待支付', '部分支付')`,
        [finalStatus, newReceived, newRefunded, now, saleOrderId, prepaidCardAmountInput]
      )
      if (repayUpd.rowCount === 0) {
        throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:sale_orders:${saleOrderId}:→${finalStatus}`)
      }
      
      
      if (cardPaymentId && prepaidCardAmountInput > 0) {
        await capturePaymentAllocatables(client, {
          salePaymentId: cardPaymentId,
          saleOrderId,
          eventAmount: prepaidCardAmountInput,
          directedItems: null,
        })
        await refreshOrderAllocationRollup(client, saleOrderId)
      }
      
      
      
      await recalcPaidSessionsForOrder(client, saleOrderId)
      
      await settlePointsSafe(client, saleOrderId, 'clientApi.repay')
      
      await recalcMemberLevel(client, userId, await getMemberThreshold(), 'clientApi')
    }
  })

  
  if (isPureCard) {
    ctx.result = {
      saleOrderId,
      status: finalStatus || '部分支付',
      paymentMethod: '储值卡',
      repayAmount: 0,
      prepaidCardAmount: prepaidCardAmountInput,
      paymentParams: null,
    }
    return
  }

  
  
  if (isOffline) {
    ctx.result = {
      saleOrderId,
      status: currentStatus,
      paymentMethod: '线下',
      repayAmount: repayAmountInput,
      prepaidCardAmount: 0,
      paymentParams: null,
    }
    return
  }

  
  const repayMerchant = await resolveLakalaMerchant(storeId)
  if (!repayMerchant) {
    throw new Error('INVALID_STATE: LAKALA_NOT_CONFIGURED: 该门店未启用拉卡拉聚合支付，请联系管理员')
  }
  const repayCfg = lakalaConfig.readConfig()
  const repayRequestIp = getRequestIp()

  if (paymentMethod === '微信') {
    const { paymentParams: repayPaymentParams } = await createLakalaPreorder({
      orderNo: saleOrderId,
      merchantNo: repayMerchant.merchantNo,
      termNo: repayMerchant.termNo,
      payAmountYuan: repayAmountInput,
      accountType: 'WECHAT',
      transType: '71',
      openid: ctx.auth.openid,
      subAppid: repayCfg.subAppid,
      requestIp: repayRequestIp,
    })
    ctx.result = {
      saleOrderId,
      status: '待支付',
      paymentMethod,
      repayAmount: repayAmountInput,
      prepaidCardAmount: prepaidCardAmountInput,
      paymentParams: repayPaymentParams,
    }
  } else {
    
    if (!repayCfg.alipayShareSource) {
      throw new Error('INVALID_STATE: ALIPAY_NOT_AVAILABLE: 暂不支持支付宝，请使用微信支付')
    }
    const repayPreorderResp = await createLakalaPreorder({
      orderNo: saleOrderId,
      merchantNo: repayMerchant.merchantNo,
      termNo: repayMerchant.termNo,
      payAmountYuan: repayAmountInput,
      accountType: 'ALIPAY',
      transType: '41',
      requestIp: repayRequestIp,
    })
    const repayShareCodeResp = await createLakalaAlipayShareCode({
      orderNo: saleOrderId,
      merchantNo: repayMerchant.merchantNo,
      termNo: repayMerchant.termNo,
      outTradeNo: repayPreorderResp.outTradeNo,
      payAmountYuan: repayAmountInput,
      requestIp: repayRequestIp,
      bizLink: repayPreorderResp.alipayQrUrl,
    })
    ctx.result = {
      saleOrderId,
      status: '待支付',
      paymentMethod,
      repayAmount: repayAmountInput,
      prepaidCardAmount: prepaidCardAmountInput,
      alipayShareToken: repayShareCodeResp.shareToken,
      alipayExpireDate: repayShareCodeResp.expireDate,
    }
  }
}


async function queryLakalaStatus(ctx) {
  const { userId } = ctx.auth
  const p = ctx.event.payload || {}
  const orderNo = p.saleOrderId || p.orderNo
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    'SELECT sale_order_id, status, store_id, lakala_out_order_no, client_user_id FROM sale_orders WHERE sale_order_id = $1',
    [orderNo]
  )
  if (orders.length === 0) {
    throw new Error('NOT_FOUND: 订单不存在')
  }
  const order = orders[0]
  if (order.client_user_id && order.client_user_id !== userId) {
    throw new Error('PERMISSION_DENIED: 无权查询该订单')
  }

  
  let merchant = null
  if (order.lakala_out_order_no) {
    merchant = await resolveLakalaMerchant(order.store_id)
  }
  if (!order.lakala_out_order_no || !merchant) {
    ctx.result = { orderNo, localStatus: order.status, lakalaQueried: false }
    return
  }

  const resp = await lakalaClient.queryTrade({
    merchantNo: merchant.merchantNo,
    termNo: merchant.termNo,
    outTradeNo: order.lakala_out_order_no,
  })
  ctx.result = {
    orderNo,
    localStatus: order.status,
    lakalaQueried: true,
    lakalaOk: resp.ok,
    lakalaTradeState: resp.tradeState || null,  
    lakalaCode: resp.code,
  }
}


function decideReconcile(localStatus, hasLakalaOrder, tradeState) {
  const terminal = new Set(['已支付', '已完成', '已关闭', '支付失败'])
  if (terminal.has(localStatus)) return 'skip'
  if (localStatus !== '待支付' && localStatus !== '部分支付') return 'skip'
  if (!hasLakalaOrder) return 'skip'
  if (tradeState !== 'SUCCESS') return 'wait'
  return 'reconcile'
}


async function confirmPayment(ctx) {
  const { userId } = ctx.auth
  const p = ctx.event.payload || {}
  const orderNo = p.saleOrderId || p.orderNo
  if (!orderNo) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }

  const orders = await pg.query(
    'SELECT sale_order_id, status, store_id, lakala_out_order_no, client_user_id, payment_method FROM sale_orders WHERE sale_order_id = $1',
    [orderNo]
  )
  if (orders.length === 0) {
    throw new Error('NOT_FOUND: 订单不存在')
  }
  const order = orders[0]
  if (order.client_user_id && order.client_user_id !== userId) {
    throw new Error('PERMISSION_DENIED: 无权操作该订单')
  }

  const localStatus = order.status
  const hasLakalaOrder = !!order.lakala_out_order_no

  
  if (decideReconcile(localStatus, hasLakalaOrder, null) === 'skip') {
    ctx.result = {
      saleOrderId: orderNo,
      status: localStatus,
      reconciled: false,
      reason: hasLakalaOrder ? 'terminal' : 'no_lakala_order',
    }
    return
  }

  
  let merchant
  try {
    merchant = await resolveLakalaMerchant(order.store_id)
  } catch (e) {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, reason: 'lakala_not_configured', message: e.message }
    return
  }
  if (!merchant) {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, reason: 'lakala_not_configured' }
    return
  }

  let resp
  try {
    resp = await lakalaClient.queryTrade({
      merchantNo: merchant.merchantNo,
      termNo: merchant.termNo,
      outTradeNo: order.lakala_out_order_no,
    })
  } catch (e) {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, reason: 'query_failed', message: e.message }
    return
  }

  const tradeState = resp.tradeState || ''
  
  if (decideReconcile(localStatus, hasLakalaOrder, tradeState) !== 'reconcile') {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, lakalaTradeState: tradeState, reason: 'not_success' }
    return
  }

  
  const payAmount = Math.round(Number(resp.totalAmountFen || 0)) / 100
  if (!(payAmount > 0)) {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, lakalaTradeState: tradeState, reason: 'invalid_amount' }
    return
  }
  const paymentMethod = order.payment_method === '支付宝' ? '支付宝' : '微信'
  let payNotifyResult
  try {
    const r = await cloud.callFunction({
      name: 'payNotify',
      data: {
        orderNo: order.lakala_out_order_no,
        transactionId: resp.tradeNo,
        payAmount,
        paymentMethod,
        tradeInfo: resp.raw || null,
      },
    })
    payNotifyResult = r && r.result
  } catch (e) {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, reason: 'paynotify_call_failed', message: e.message }
    return
  }

  
  const after = await pg.query('SELECT status FROM sale_orders WHERE sale_order_id = $1', [orderNo])
  const newStatus = (after[0] && after[0].status) || localStatus
  ctx.result = {
    saleOrderId: orderNo,
    status: newStatus,
    reconciled: !!(payNotifyResult && payNotifyResult.code === 'SUCCESS' && newStatus !== localStatus),
    payNotifyResult,
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
  queryLakalaStatus,
  confirmPayment,
  decideReconcile,
}
