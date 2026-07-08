

const pg = require('../db/pg')
const { requireStaffBound, requireManager } = require('../middleware/auth')
const { assertOrderInScope, isStoreInScope, restrictToBoundEmployee } = require('../utils/scope')
const { generateWxacode, uploadToCloudStorage } = require('../utils/wxacode')
const { getMemberThreshold } = require('../utils/config')


const { settlePointsSafe } = require('../utils/points')
const { recalcMemberLevel } = require('../utils/member-level')
const { isMember, resolveUnitPrice } = require('../utils/member-pricing')
const { recalcPaidSessionsForOrder, computePaidSessionsForItem } = require('../utils/paid-sessions')
const { capturePaymentAllocatables, refreshOrderAllocationRollup } = require('../utils/payment-allocatable')
const {
  buildRefundDetails,
  capRefundAmounts,
  splitRefundByOriginalPayment,
  resolveRefundPaymentMethod,
  assertNoPendingRefund,
  notifyRefundCreated,
  notifyRefundResult,
} = require('../utils/refund')
const { logOperation, logTransition } = require('../utils/operation-log')
const { shanghaiYMD, shanghaiYYMMDD } = require('../utils/datetime')


const qrcodeCache = new Map()



const DEPOSIT_RECEIPT_NOTE = '寄存单初始化实收'








const DEPOSIT_REAL_PRICE_RECALC_SQL = `UPDATE sale_items
      SET unit_real_price = CASE
            WHEN session_count > 0 AND received > 0
              THEN ROUND(received::numeric / session_count, 2)
            ELSE unit_price
          END,
          updated_at = NOW()
      WHERE sale_order_id = $1 AND item_direction = '购买' AND product_type = '疗程卡'
      -- DEPOSIT_REAL_PRICE`


async function refreshSpendingTier(client, clientUserId) {
  if (!clientUserId) return
  
  
  
  await client.query(
    `UPDATE client_wechat_users
     SET spending_tier = CASE
       WHEN t.total >= 100000 THEN '10W+'
       WHEN t.total >= 60000  THEN '6-10W'
       WHEN t.total >= 30000  THEN '3-6W'
       WHEN t.total >= 10000  THEN '1-3W'
       WHEN t.total >= 1990   THEN '1990-1W'
       ELSE '<1990'
     END::spending_tier,
     updated_at = NOW()
     FROM (
       SELECT COALESCE(SUM(GREATEST((received::numeric) - (refunded_amount::numeric), 0)), 0) AS total
       FROM sale_orders
       WHERE client_user_id = $1
         AND status IN ('已支付', '已完成')
         AND sale_order_type IN ('销售单','转换单')
     ) t
     WHERE user_id = $1`,
    [clientUserId]
  )
}


async function recalcCustomerType(client, clientUserId) {
  if (!clientUserId) return

  
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
           AND o.total_amount >= $2
           -- 2026-04-26 sale-order-domain-refactor：回款单 → sale_order_payments[change_type='回款']
           -- total_amount 在 sale_orders 上是订单总额（不含回款 amount），保留 total_amount >= $2 直接判定
       ) THEN '会员客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         WHERE o.client_user_id = $1
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND si.is_experience = false
       ) THEN '小美客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         WHERE o.client_user_id = $1
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND si.is_experience = true
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

  
  if (updateResult.rowCount > 0 && updateResult.rows[0].customer_type === '会员客') {
    await client.query(
      `UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = $1`,
      [clientUserId]
    )
    
    
    await client.query(
      `UPDATE sale_orders SET is_membership_upgrade = true
       WHERE sale_order_id = (
         SELECT o.sale_order_id FROM sale_orders o
         WHERE o.client_user_id = $1
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND o.total_amount >= $2
         ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC
         LIMIT 1
       )`,
      [clientUserId, threshold]
    )
  }
}


async function deductPrepaidCardAtCreation(client, { saleOrderId, clientUserId, amount, staffWfId, note, now }) {
  if (!(amount > 0) || !clientUserId) return
  
  const dupCheck = await client.query(
    `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款' LIMIT 1`,
    [saleOrderId]
  )
  if (dupCheck.rows.length > 0) return

  const balRes = await client.query(
    'SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE',
    [clientUserId]
  )
  if (balRes.rows.length === 0) {
    throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
  }
  const currentBalance = Number(balRes.rows[0].balance)
  if (currentBalance + 0.001 < amount) {
    throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足')
  }
  const cardId = balRes.rows[0].card_id
  await client.query(
    `UPDATE prepaid_cards SET balance = balance - $1, updated_at = NOW() WHERE card_id = $2`,
    [amount, cardId]
  )
  await client.query(
    `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
     VALUES ($1, '扣款', $2, $3, $4, NOW())
     ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
    [cardId, -amount, saleOrderId, `card-deduct-${saleOrderId}`]
  )
  const ins = await client.query(
    `INSERT INTO sale_order_payments (
      sale_order_id, change_type, amount, payment_method, external_txn_id,
      status, source_end, operator_employee_id, note, created_at, paid_at
    ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'staff', $3, $4, $5, $5) RETURNING id`,
    [saleOrderId, amount, staffWfId, note, now]
  )
  return ins.rows[0].id
}


async function settlePaidByCardAtCreation(client, { saleOrderId, clientUserId, receivedAmount, now }) {
  if (clientUserId) {
    await refreshSpendingTier(client, clientUserId)
    await recalcCustomerType(client, clientUserId)
    
    await recalcMemberLevel(client, clientUserId, await getMemberThreshold(), 'staffApi')
  }
  await settlePointsSafe(client, saleOrderId, 'staffApi.createPaidByCard')
  
  if (clientUserId) {
    try {
      await client.query('SAVEPOINT sp_share_gift')
      const { grantShareGift } = require('../share-gift')
      await grantShareGift(client, { saleOrderId, clientUserId, paidAmount: receivedAmount, source: 'staffApi' })
      await client.query('RELEASE SAVEPOINT sp_share_gift')
    } catch (sgErr) {
      try { await client.query('ROLLBACK TO SAVEPOINT sp_share_gift') } catch (e) {}
      console.error('[staffApi/share-gift] error (non-fatal):', sgErr)
    }
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
    `SELECT id, group_name, pick_count FROM mall_bundle_groups WHERE product_id = $1`,
    [bundleProductId]
  )
  const mpsRows = await pg.query(
    `SELECT sku_id, bundle_group_id, bundle_price, bundle_list_price
     FROM mall_product_skus WHERE product_id = $1`,
    [bundleProductId]
  )

  const skuToPrice = new Map()
  const skuToGroupId = new Map()
  for (const r of mpsRows) {
    skuToPrice.set(r.sku_id, { listPrice: r.bundle_list_price, salePrice: r.bundle_price })
    skuToGroupId.set(r.sku_id, r.bundle_group_id != null ? Number(r.bundle_group_id) : null)
  }

  for (const item of items) {
    if (!skuToPrice.has(item.skuId)) {
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

  return skuToPrice
}


async function create(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const {
    items,
    paymentMethod,
    saleOrderType: saleOrderTypeParam,
    preferredStaffWfId,
    couponId: inputCouponId,
    remark: orderRemark,
    useCard,
    prepaidCardAmount: inputPrepaidCardAmount,
    isActivity,
    bundleProductId,
  } = payload

  
  
  let clientPhone = payload.clientPhone
  let clientName = payload.clientName

  const storeId = ctx.auth.effectiveStoreId
  
  const marketName = ctx.auth.marketName || ''

  
  if (Array.isArray(inputCouponId)) {
    throw new Error('INVALID_PARAMS: MULTIPLE_COUPON_NOT_SUPPORTED: 一张订单仅支持 1 张优惠券')
  }

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
  
  
  if (!['微信', '支付宝', '线下'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式')
  }
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  
  
  const saleOrderType = saleOrderTypeParam || '销售单'
  if (['回款单', '退款单'].includes(saleOrderType)) {
    throw new Error('INVALID_PARAMS: 回款/退款已下沉至 sale_order_payments，order.create 不再支持此类型')
  }
  if (!['销售单', '内部单'].includes(saleOrderType)) {
    throw new Error('INVALID_PARAMS: 订单类型不合法（仅支持 销售单/内部单）')
  }

  
  if (saleOrderType === '内部单' && inputCouponId) {
    throw new Error('INVALID_PARAMS: 内部单不允许叠加优惠券')
  }

  
  

  
  
  const clientUsers = await pg.query(
    'SELECT user_id, bound_store_id, is_cross_store_temp, customer_type, member_level, phone, name FROM client_wechat_users WHERE phone = $1 LIMIT 1',
    [clientPhone]
  )
  if (clientUsers.length === 0 || !clientUsers[0].bound_store_id) {
    throw new Error('CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店')
  }
  
  
  
  if (!isStoreInScope(ctx.auth, clientUsers[0].bound_store_id) && !clientUsers[0].is_cross_store_temp) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法开单')
  }
  const clientUserId = clientUsers[0].user_id
  
  const buyerIsMember = isMember(clientUsers[0].customer_type, clientUsers[0].member_level)

  
  
  
  
  if (clientUsers[0].phone) clientPhone = clientUsers[0].phone
  if (clientUsers[0].name) clientName = clientUsers[0].name

  
  const bundleSkuPrices = await _loadAndValidateBundle(bundleProductId, items)

  
  const rawItemDataList = await Promise.all(
    items.map(async (item) => {
      const skuRows = await pg.query(
        `SELECT s.sku_id, s.product_type, s.spec_name, s.price, s.special_price, s.session_count,
                s.service_fee, s.is_shengmei, s.is_experience, s.is_manager_special,
                pc.sales_category, pc.product_kind
         FROM product_skus s
         JOIN product_categories pc ON s.category_id = pc.category_id
         WHERE s.sku_id = $1 AND s.deleted_at IS NULL`,
        [item.skuId]
      )
      if (skuRows.length === 0) {
        throw new Error(`INVALID_PARAMS: 商品 ${item.skuId} 不存在`)
      }
      const sku = skuRows[0]

      let sessionCount = null
      let salesCategory = sku.sales_category || null
      
      const skuPriceCeil = Number(sku.price)
      
      const applicableUnit = resolveUnitPrice(sku, buyerIsMember).realUnit

      
      let inputListUnit, inputRealUnit, useFrontendPrice
      if (saleOrderType === '内部单') {
        
        inputListUnit = skuPriceCeil
        inputRealUnit = Math.round(skuPriceCeil * 50) / 100
        useFrontendPrice = false
      } else {
        const bp = bundleSkuPrices ? bundleSkuPrices.get(item.skuId) : null
        if (bp) {
          
          const bundleListUnit = bp.listPrice != null ? Number(bp.listPrice) : skuPriceCeil
          const bundleSaleUnit = bp.salePrice != null ? Number(bp.salePrice) : bundleListUnit
          inputListUnit = item.unitPrice != null ? Number(item.unitPrice) : bundleListUnit
          inputRealUnit = item.unitRealPrice != null ? Number(item.unitRealPrice) : bundleSaleUnit
          if (!Number.isFinite(inputListUnit) || !Number.isFinite(inputRealUnit)
              || inputListUnit > bundleListUnit + 0.005
              || inputRealUnit > inputListUnit + 0.005
              || inputRealUnit < 0) {
            throw new Error('INVALID_PARAMS: 单价不能高于商品标价或为非法值')
          }
          useFrontendPrice = true
        } else if (sku.is_manager_special === true) {
          
          
          const qtyForUnit = item.quantity || 1
          inputListUnit = skuPriceCeil
          inputRealUnit = item.unitRealPrice != null
            ? Number(item.unitRealPrice)
            : (item.saleAmount != null ? Number(item.saleAmount) / qtyForUnit : applicableUnit)
          if (!Number.isFinite(inputRealUnit) || inputRealUnit < 0
              || inputRealUnit > applicableUnit + 0.005) {
            throw new Error('INVALID_PARAMS: 应付单价不能高于该顾客适用价或为非法值')
          }
          useFrontendPrice = false  
        } else {
          
          inputListUnit = skuPriceCeil
          inputRealUnit = applicableUnit
          useFrontendPrice = false
        }
      }
      const unitPrice = inputRealUnit  

      sessionCount = sku.session_count != null ? Number(sku.session_count) : null

      const quantity = item.quantity || 1
      
      
      if (sessionCount != null) sessionCount = sessionCount * quantity
      
      
      
      const priceLine = (useFrontendPrice && item.saleAmount != null)
        ? Math.round(Number(item.saleAmount) * 100) / 100
        : Math.round(unitPrice * quantity * 100) / 100
      if (!Number.isFinite(priceLine) || priceLine < 0) {
        throw new Error('INVALID_PARAMS: 行小计金额非法')
      }
      
      const listLineMax = Math.round(inputListUnit * quantity * 100) / 100
      if (priceLine > listLineMax + 0.005) {
        throw new Error('INVALID_PARAMS: 行小计金额不能高于标价小计')
      }

      
      const inputReceived = item.received !== undefined && item.received !== null
        ? Number(item.received)
        : null
      if (inputReceived !== null && (!Number.isFinite(inputReceived) || inputReceived < 0)) {
        throw new Error('INVALID_PARAMS: 行实付金额必须为非负数')
      }

      
      
      const serviceFee = Math.round(Number(sku.service_fee || 0) * quantity * 100) / 100

      return {
        skuId: item.skuId,
        productName: sku.spec_name,
        productType: sku.product_type,
        productKind: sku.product_kind,
        sessionCount,
        remainingSessions: sessionCount,
        unitPrice,
        
        listUnitPrice: inputListUnit,
        quantity,
        
        unitRealPrice: unitPrice,
        saleAmount: priceLine,
        priceLine,
        inputReceived,
        
        received: priceLine,
        salesCategory,
        serviceFee,
        isShengmei: sku.is_shengmei ?? null,
        isExperience: sku.is_experience === true,
        
        isManagerSpecial: sku.is_manager_special === true,
      }
    })
  )

  
  
  
  
  
  
  
  
  const itemDataList = []
  for (const d of rawItemDataList) {
    if (d.productType === '疗程卡' && d.quantity > 1) {
      const n = d.quantity
      const perSession = d.sessionCount != null ? Math.round(d.sessionCount / n) : null
      const perSaleAmount = Math.round((d.saleAmount * 100) / n) / 100
      const perPriceLine = Math.round((d.priceLine * 100) / n) / 100
      const perServiceFee = Math.round((d.serviceFee * 100) / n) / 100
      for (let i = 0; i < n; i++) {
        const isLast = i === n - 1
        const saleAmountRow = isLast
          ? Math.round((d.saleAmount - perSaleAmount * (n - 1)) * 100) / 100
          : perSaleAmount
        const priceLineRow = isLast
          ? Math.round((d.priceLine - perPriceLine * (n - 1)) * 100) / 100
          : perPriceLine
        const serviceFeeRow = isLast
          ? Math.round((d.serviceFee - perServiceFee * (n - 1)) * 100) / 100
          : perServiceFee
        itemDataList.push({
          ...d,
          quantity: 1,
          sessionCount: perSession,
          remainingSessions: perSession,
          priceLine: priceLineRow,
          saleAmount: saleAmountRow,
          
          received: saleAmountRow,
          unitRealPrice: saleAmountRow,
          
          inputReceived: d.inputReceived,
          serviceFee: serviceFeeRow,
        })
      }
    } else {
      itemDataList.push(d)
    }
  }

  
  let couponDiscount = 0
  let couponInfo = null
  if (inputCouponId && clientUserId) {
    const couponRows = await pg.query(
      `SELECT uc.coupon_id, uc.user_id, uc.expire_at,
              ct.coupon_type, ct.min_spend, ct.max_discount,
              ct.applicable_category_ids, ct.applicable_store_ids,
              ct.applicable_product_ids, ct.applicable_market_ids,
              COALESCE(uc.face_value_override, ct.discount_value) AS discount_value
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

    
    if (couponInfo.applicable_store_ids && couponInfo.applicable_store_ids.length > 0) {
      if (!storeId || !couponInfo.applicable_store_ids.includes(storeId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此门店')
      }
    }

    
    if (couponInfo.applicable_market_ids && couponInfo.applicable_market_ids.length > 0) {
      if (!storeId) {
        throw new Error('INVALID_PARAMS: 该优惠券仅限特定市场使用')
      }
      const marketRows = await pg.query(
        `SELECT o.parent_id AS market_id
         FROM stores s
         JOIN org_nodes o ON s.org_node_id = o.id
         WHERE s.store_id = $1 AND o.type = 'store'`,
        [storeId]
      )
      if (marketRows.length === 0) {
        throw new Error('INVALID_PARAMS: 门店数据异常')
      }
      const storeMarketId = marketRows[0].market_id
      if (!couponInfo.applicable_market_ids.includes(storeMarketId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此市场')
      }
    }

    
    const skuIdList = itemDataList.map(d => d.skuId)
    const skuInfos = await pg.query(
      `SELECT ps.sku_id, ps.category_id, mps.product_id
       FROM product_skus ps
       LEFT JOIN mall_product_skus mps ON ps.sku_id = mps.sku_id
       WHERE ps.sku_id = ANY($1) AND ps.deleted_at IS NULL`,
      [skuIdList]
    )
    const catMap = new Map()
    const prodMap = new Map()
    for (const r of skuInfos) {
      catMap.set(r.sku_id, r.category_id)
      prodMap.set(r.sku_id, r.product_id)
    }

    let eligibleItems
    if (
      (couponInfo.applicable_category_ids && couponInfo.applicable_category_ids.length > 0) ||
      (couponInfo.applicable_product_ids && couponInfo.applicable_product_ids.length > 0)
    ) {
      eligibleItems = itemDataList.filter(d => {
        const catMatch = !couponInfo.applicable_category_ids ||
          couponInfo.applicable_category_ids.length === 0 ||
          couponInfo.applicable_category_ids.includes(catMap.get(d.skuId))
        const prodMatch = !couponInfo.applicable_product_ids ||
          couponInfo.applicable_product_ids.length === 0 ||
          couponInfo.applicable_product_ids.includes(prodMap.get(d.skuId))
        return catMatch && prodMatch
      })
    } else {
      eligibleItems = itemDataList
    }
    if (eligibleItems.length === 0) {
      throw new Error('INVALID_PARAMS: 该优惠券不适用于当前商品')
    }

    
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

    
    
    let distributedTotal = 0
    for (let i = 0; i < eligibleItems.length; i++) {
      const item = eligibleItems[i]
      let share
      if (i === eligibleItems.length - 1) {
        share = couponDiscount - distributedTotal
      } else {
        share = Math.round(couponDiscount * (item.saleAmount / eligibleTotal) * 100) / 100
        distributedTotal += share
      }
      item.saleAmount = Math.max(0, Math.round((item.saleAmount - share) * 100) / 100)
      
      item.unitRealPrice = item.quantity > 0 ? Math.round((item.saleAmount / item.quantity) * 100) / 100 : 0
    }
  }

  
  
  
  
  
  
  const skuGroups = new Map()  
  for (const d of itemDataList) {
    if (!skuGroups.has(d.skuId)) skuGroups.set(d.skuId, [])
    skuGroups.get(d.skuId).push(d)
  }
  for (const group of skuGroups.values()) {
    
    const groupInputReceived = group[0].inputReceived
    if (groupInputReceived === null || groupInputReceived === undefined) {
      
      for (const d of group) d.received = d.saleAmount
    } else {
      let remainingCents = Math.round(Number(groupInputReceived) * 100)
      for (const d of group) {
        const capCents = Math.round(Number(d.saleAmount || 0) * 100)
        const takenCents = Math.max(0, Math.min(remainingCents, capCents))
        d.received = Math.round(takenCents) / 100
        remainingCents -= takenCents
      }
      
      if (remainingCents > 0 && group.length > 0) {
        const last = group[group.length - 1]
        last.received = Math.round((last.received * 100 + remainingCents)) / 100
      }
    }
  }

  
  
  
  
  for (const d of itemDataList) {
    const denom = (d.sessionCount != null && d.sessionCount > 0) ? d.sessionCount : (d.quantity || 1)
    const listBase = Number(d.listUnitPrice != null ? d.listUnitPrice : d.unitPrice || 0)
    const listTotalRow = Math.round(listBase * (d.quantity || 1) * 100) / 100
    d.unitRealPrice = denom > 0 ? Math.round((Number(d.saleAmount || 0) / denom) * 100) / 100 : Number(d.saleAmount || 0)
    d.unitPrice = denom > 0 ? Math.round((listTotalRow / denom) * 100) / 100 : listTotalRow
  }

  const now = new Date()
  
  
  let saleOrderId
  
  const totalAmount = Math.round(itemDataList.reduce((sum, d) => sum + d.saleAmount, 0) * 100) / 100
  
  
  const sumItemReceived = Math.round(itemDataList.reduce((sum, d) => sum + d.received, 0) * 100) / 100

  
  
  let prepaidCardAmount = 0
  if (useCard) {
    const balanceRows = await pg.query(
      'SELECT balance FROM prepaid_cards WHERE user_id = $1',
      [clientUserId]
    )
    const currentBalance = balanceRows.length > 0 ? Number(balanceRows[0].balance) : 0

    
    
    const maxPrepayable = Math.min(totalAmount, sumItemReceived)

    if (inputPrepaidCardAmount !== undefined && inputPrepaidCardAmount !== null) {
      const inputAmount = Number(inputPrepaidCardAmount)
      if (!Number.isFinite(inputAmount) || inputAmount < 0) {
        throw new Error('INVALID_PARAMS: 充值卡抵扣金额必须为非负数')
      }
      if (inputAmount > currentBalance) {
        throw new Error('INSUFFICIENT_BALANCE: 充值卡余额不足')
      }
      if (inputAmount > maxPrepayable) {
        throw new Error('INVALID_PARAMS: 充值卡抵扣金额超过应抵上限')
      }
      prepaidCardAmount = Math.round(inputAmount * 100) / 100
    } else {
      
      prepaidCardAmount = Math.min(currentBalance, maxPrepayable)
      prepaidCardAmount = Math.round(prepaidCardAmount * 100) / 100
    }
  }

  
  
  
  
  
  const payableAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100
  
  
  
  const zeroPayable = payableAmount === 0

  
  
  
  const isOnlineMethod = paymentMethod === '微信' || paymentMethod === '支付宝'
  let receivedAmount
  if (isOnlineMethod) {
    receivedAmount = 0
  } else {
    receivedAmount = Math.min(sumItemReceived, payableAmount)
    receivedAmount = Math.round(receivedAmount * 100) / 100
  }

  
  
  
  
  const paidAmount = 0

  
  
  
  let effectivePaymentMethod
  if (zeroPayable) {
    effectivePaymentMethod = '无'
  } else {
    effectivePaymentMethod = paymentMethod
  }

  
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
    
    
    
    
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clientUserId])
    const existing = await client.query(
      "SELECT sale_order_id FROM sale_orders WHERE client_user_id = $1 AND status = '待支付' LIMIT 1",
      [clientUserId]
    )
    if (existing.rows.length > 0) {
      throw new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
    }

    
    
    saleOrderId = await generateOrderNo(undefined, client)

    const today = now
    const dateStr = shanghaiYMD(today)
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

    
    
    
    
    
    
    
    
    
    
    const isFullCardCoverage = payableAmount === 0 && prepaidCardAmount > 0
    
    
    
    const initialStatus = zeroPayable ? '已支付' : '待支付'
    
    
    const receivedColumn = zeroPayable ? prepaidCardAmount : paidAmount
    
    
    const paidAtValue = (paidAmount > 0 || zeroPayable) ? now : null
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, total_amount, client_user_id, client_phone, customer_name,
        payment_method, opened_by,
        preferred_employee_id, coupon_id, coupon_discount, remark, is_activity, allocation_status,
        prepaid_card_amount, received, payable_amount, paid_at,
        created_at, updated_at
      ) VALUES ($1, $17, $2, $3, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $5), $4), $5, (SELECT store_name FROM stores WHERE store_id = $5), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $22, '待分配', $18, $19, $20, $21, $6, $6)`,
      [
        saleOrderId, saleOrderType, documentType, marketName, storeId, now,
        totalAmount, clientUserId, clientPhone, clientName,
        effectivePaymentMethod, ctx.auth.staffWfId,
        preferredStaffWfId || null,
        inputCouponId || null, couponDiscount,
        orderRemark || null,
        initialStatus,
        prepaidCardAmount, receivedColumn, payableAmount,
        paidAtValue,
        isActivity === true,
      ]
    )

    
    
    
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

    
    
    
    
    
    

    
    for (let i = 0; i < itemDataList.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemDataList[i]
      
      d.saleItemId = saleItemId

      
      const sc = d.productType === '家居产品' ? null : d.sessionCount
      const rs = d.productType === '家居产品' ? null : d.remainingSessions

      
      
      
      await client.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction, sku_id,
          product_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received, pending_received,
          sales_category, service_fee, is_shengmei, is_experience, is_manager_special
        ) VALUES ($1, $2, $3, '购买', $4, $5, $6, $7, $8, $9, $10, $11, $12, '0', $13, $14, $15, $16, $17, $18)`,
        [
          saleItemId, saleOrderId, storeId, d.skuId,
          d.productName, d.productType,
          sc, rs,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount, d.received,
          d.salesCategory || null,
          d.serviceFee || 0,
          d.isShengmei ?? null,
          
          
          d.isExperience === true,
          
          d.isManagerSpecial === true,
        ]
      )
    }

    
    
    

    
    let fullCardPaymentId = null
    if (isFullCardCoverage) {
      fullCardPaymentId = await deductPrepaidCardAtCreation(client, {
        saleOrderId,
        clientUserId,
        amount: prepaidCardAmount,
        staffWfId: ctx.auth.staffWfId,
        note: '店长开单-储值卡全额抵扣',
        now,
      })
    }

    
    
    if (fullCardPaymentId && prepaidCardAmount > 0) {
      await capturePaymentAllocatables(client, {
        salePaymentId: fullCardPaymentId,
        saleOrderId,
        eventAmount: prepaidCardAmount,
        directedItems: null,
      })
      await refreshOrderAllocationRollup(client, saleOrderId)
    }

    
    
    
    
    
    await recalcPaidSessionsForOrder(client, saleOrderId)

    
    
    if (zeroPayable) {
      await settlePaidByCardAtCreation(client, {
        saleOrderId,
        clientUserId,
        receivedAmount: prepaidCardAmount,
        now,
      })
    }
    
    await logOperation(client, ctx, 'order.create', 'sale_order', saleOrderId, {
      _v: 3,
      storeId,
      saleOrderType,
      totalAmount,
      itemCount: items.length,
      couponId: inputCouponId || null,
      couponDiscount: couponDiscount > 0 ? couponDiscount : null,
      clientUserId,
    })
  })

  
  
  const resolvedStatus = zeroPayable ? '已支付' : '待支付'

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


async function qrcode(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  const orders = await pg.query(
    `SELECT o.sale_order_id, o.status, o.sale_order_type, o.client_phone, o.customer_name,
            o.payment_method, o.paid_at, o.store_id, o.opened_by,
            o.total_amount, o.prepaid_card_amount, o.payable_amount,
            o.received, o.refunded_amount
     FROM sale_orders o
     WHERE o.sale_order_id = $1`,
    [saleOrderId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  
  if (!isStoreInScope(ctx.auth, order.store_id)) {
    throw new Error('PERMISSION_DENIED: 订单不在当前门店范围内')
  }
  if (!ctx.auth.roles.includes('manager') && order.store_id !== ctx.auth.effectiveStoreId) {
    throw new Error('PERMISSION_DENIED: 无权查看该订单')
  }

  const items = await pg.query(`
    SELECT
      si.sale_item_id, si.received, si.pending_received, si.sale_amount,
      si.product_name
    FROM sale_items si
    WHERE si.sale_order_id = $1
  `, [saleOrderId])

  
  
  const totalAmount = Number(order.total_amount || 0)

  
  const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
  let actualPayable
  if (order.status === '部分支付') {
    
    const payable = Number(order.payable_amount || 0) > 0
      ? Number(order.payable_amount)
      : Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)
    const netReceived = Math.round((Number(order.received || 0) - Number(order.refunded_amount || 0)) * 100) / 100
    actualPayable = Math.max(0, Math.round((payable - netReceived) * 100) / 100)
  } else if (order.sale_order_type === '充值单' || order.sale_order_type === '转换单') {
    
    
    
    
    const payable = Number(order.payable_amount || 0) > 0
      ? Number(order.payable_amount)
      : Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)
    actualPayable = Math.max(0, Math.round(payable * 100) / 100)
  } else {
    
    
    const sumItemReal = items.reduce(
      (s, i) => s + Number(i.pending_received != null ? i.pending_received : (i.sale_amount || 0)),
      0
    )
    actualPayable = Math.max(0, Math.round((sumItemReal - prepaidCardAmount) * 100) / 100)
  }

  
  
  
  let qrCodeStatus
  if (['已支付', '已完成'].includes(order.status)) {
    qrCodeStatus = '已支付'
  } else if (order.status === '待支付' && order.payment_method === '线下') {
    qrCodeStatus = '待确认收款'
  } else if (order.status === '待支付') {
    qrCodeStatus = '待扫码'
  } else if (order.status === '部分支付') {
    
    qrCodeStatus = '待扫码'
  } else {
    qrCodeStatus = order.status
  }

  
  let qrcodeUrl = ''
  let qrcodeError = ''
  if (order.status === '待支付' || order.status === '部分支付') {
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
    actualPayable,
    items: items.map(i => ({
      saleItemId: i.sale_item_id,
      productName: i.product_name,
      received: i.received
    })),
    qrcodeUrl,
    qrcodeError
  }
}


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
  
  if (!['待支付', '部分支付'].includes(order.status)) {
    throw new Error(`INVALID_PARAMS: 订单当前状态为"${order.status}"，不可确认收款`)
  }

  const now = new Date()

  
  const items = await pg.query(
    `SELECT si.sale_item_id, si.sku_id, si.received, si.pending_received, si.product_type
     FROM sale_items si
     WHERE si.sale_order_id = $1`,
    [saleOrderId]
  )

  const totalReceived = items.reduce((s, i) => s + Number(i.received || 0), 0)
  
  
  const pendingTotal = Math.round(items.reduce((s, i) => s + Number(i.pending_received || 0), 0) * 100) / 100

  
  
  
  
  
  
  
  
  const orderTotal = Number(order.total_amount || 0)
  const orderPrepaid = Number(order.prepaid_card_amount || 0)
  const orderReceived = Number(order.received || 0)
  const orderPayable = order.payable_amount != null
    ? Number(order.payable_amount)
    : Math.round((orderTotal - orderPrepaid) * 100) / 100
  const remainingPayable = Math.round((orderPayable - orderReceived) * 100) / 100
  const pendingRemaining = pendingTotal > 0
    ? Math.max(0, Math.min(remainingPayable, Math.round((pendingTotal - orderPrepaid - orderReceived) * 100) / 100))
    : remainingPayable

  let confirmAmount
  if (inputConfirmAmount === undefined || inputConfirmAmount === null) {
    confirmAmount = pendingRemaining
  } else {
    confirmAmount = Number(inputConfirmAmount)
    if (!Number.isFinite(confirmAmount) || confirmAmount < 0) {
      throw new Error('INVALID_PARAMS: 本次确认金额必须为非负数')
    }
    if (confirmAmount > remainingPayable + 0.001) {
      throw new Error('INVALID_PARAMS: 本次确认金额不能超过剩余应付金额')
    }
    confirmAmount = Math.round(confirmAmount * 100) / 100
  }

  
  
  
  const settleTarget = Math.round((orderPayable + orderPrepaid) * 100) / 100
  
  
  
  let newReceived = 0
  let targetStatus = '部分支付'

  
  
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
    
    
    
    const prepaidAmount = Number(order.prepaid_card_amount || 0)
    
    let cashPaymentId = null
    let cardPaymentId = null
    if (prepaidAmount > 0 && order.client_user_id) {
      
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
          `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
           VALUES ($1, '扣款', $2, $3, $4, NOW())
           ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
          [cardId, -prepaidAmount, saleOrderId, `card-deduct-${saleOrderId}`]
        )
        
        const cardIns = await client.query(
          `INSERT INTO sale_order_payments (
            sale_order_id, change_type, amount, payment_method, external_txn_id,
            status, source_end, operator_employee_id, note, created_at, paid_at
          ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'staff', $3, $4, $5, $5) RETURNING id`,
          [saleOrderId, prepaidAmount, ctx.auth.staffWfId, '店长确认线下收款-储值卡抵扣', now]
        )
        cardPaymentId = cardIns.rows[0].id
      }
    }

    
    
    
    if (confirmAmount > 0) {
      const insRes = await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at, paid_at
        ) VALUES ($1, $2, $3, '线下', NULL, '已支付', 'staff', $4, $5, $6, $6)
        ON CONFLICT (sale_order_id)
          WHERE change_type = '首次支付' AND status = '已支付'
        DO NOTHING
        RETURNING id`,
        [saleOrderId, paymentChangeType, confirmAmount, ctx.auth.staffWfId, '店长确认线下收款', now]
      )
      if (insRes.rows.length === 0) {
        throw new Error('CONFLICT: 订单已收款，请勿重复提交')
      }
      cashPaymentId = insRes.rows[0].id
    }

    
    
    
    
    
    
    const sumRes = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
                           THEN amount::numeric ELSE 0 END), 0) AS new_received,
         COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                           THEN amount::numeric ELSE 0 END), 0) AS new_prepaid
       FROM sale_order_payments
       WHERE sale_order_id = $1`,
      [saleOrderId]
    )
    newReceived = Math.round(Number(sumRes.rows[0].new_received) * 100) / 100
    const newPrepaid = Math.round(Number(sumRes.rows[0].new_prepaid) * 100) / 100
    
    targetStatus = newReceived + 0.005 >= settleTarget ? '已支付' : '部分支付'

    
    
    const paidAtValue = targetStatus === '已支付' ? now : (order.paid_at || null)
    const updateResult = await client.query(
      `UPDATE sale_orders
       SET status = $1, received = $2, prepaid_card_amount = $3, paid_at = $4, updated_at = $5,
           offline_confirmed_by = $6, offline_confirmed_at = $5
       WHERE sale_order_id = $7 AND status = $8`,
      [targetStatus, newReceived, newPrepaid, paidAtValue, now, ctx.auth.staffWfId, saleOrderId, order.status]
    )
    if (updateResult.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 订单状态已变更，请刷新后重试')
    }

    

    
    
    
    
    if (targetStatus === '已支付' && order.client_user_id && order.sale_order_type === '充值单') {
      const faceValue = Number(order.total_amount)
      if (faceValue > 0) {
        const dupCheck = await client.query(
          `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
          [saleOrderId]
        )
        if (dupCheck.rows.length === 0) {
          
          const newCardId = `FY-CARD-${order.client_user_id}`
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
            `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
             VALUES ($1, '充值', $2, $3, $4, NOW())
             ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
            [cardId, faceValue, saleOrderId, `card-topup-${saleOrderId}`]
          )
        }
      }
    }

    
    
    const cashThis = cashPaymentId ? confirmAmount : 0
    const cardThis = cardPaymentId ? prepaidAmount : 0
    const allocEventAmount = Math.round((cashThis + cardThis) * 100) / 100
    const allocPrimaryId = cashPaymentId || cardPaymentId
    if (allocPrimaryId && allocEventAmount > 0) {
      await capturePaymentAllocatables(client, {
        salePaymentId: allocPrimaryId,
        saleOrderId,
        eventAmount: allocEventAmount,
        directedItems: null,
      })
      await refreshOrderAllocationRollup(client, saleOrderId)
    }

    
    
    await recalcPaidSessionsForOrder(client, saleOrderId)

    
    await refreshSpendingTier(client, order.client_user_id)
    
    await recalcCustomerType(client, order.client_user_id)
    
    await recalcMemberLevel(client, order.client_user_id, await getMemberThreshold(), 'staffApi')

    
    
    
    await settlePointsSafe(client, saleOrderId, 'staffApi.confirmOffline')

    
    
    
    if (targetStatus === '已支付' || targetStatus === '已完成') {
      try {
        await client.query('SAVEPOINT sp_share_gift')
        const { grantShareGift } = require('../share-gift')
        const sgRes = await grantShareGift(client, {
          saleOrderId,
          clientUserId: order.client_user_id,
          paidAmount: newReceived,
          source: 'staffApi',
        })
        await client.query('RELEASE SAVEPOINT sp_share_gift')
        if (sgRes.granted) {
          console.log('[staffApi/share-gift] granted', sgRes)
        } else {
          console.log('[staffApi/share-gift] skipped', sgRes.reason)
        }
      } catch (sgErr) {
        try { await client.query('ROLLBACK TO SAVEPOINT sp_share_gift') } catch (e) {}
        console.error('[staffApi/share-gift] error (non-fatal):', sgErr)
      }
    }

    
    await logTransition(client, ctx, 'order.confirmOffline', 'sale_order', saleOrderId, order.status, targetStatus, {
      confirmAmount,
      received: newReceived,
      prepaidCardAmount: orderPrepaid > 0 ? orderPrepaid : null,
    })
  })

  ctx.result = {
    saleOrderId,
    status: targetStatus,
    paidAt: targetStatus === '已支付' ? now : (order.paid_at || null),
    paidAmount: newReceived, 
    received: newReceived,
    confirmAmount,
    remainingPayable: Math.round((orderPayable - newReceived) * 100) / 100,
    totalReceived,
    message: targetStatus === '已支付' ? '线下收款已确认' : '已确认本次收款（订单仍部分支付）'
  }
}


async function close(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  
  await assertOrderInScope(pg, ctx.auth, saleOrderId)

  const orders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1',
    [saleOrderId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]
  const isManagerRole = ctx.auth.roles.includes('manager')
  const isCreator = order.opened_by && order.opened_by === ctx.auth.staffWfId

  if (isManagerRole) {
    if (!['待支付', '支付失败'].includes(order.status)) {
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
    
    await client.query(
      `UPDATE user_coupons
       SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
       WHERE used_sale_order_id = $1`,
      [saleOrderId]
    )
    
    await logTransition(client, ctx, 'order.close', 'sale_order', saleOrderId, order.status, '已关闭')
  })

  ctx.result = {
    saleOrderId,
    status: '已关闭',
    message: '订单已关闭'
  }
}


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
  await pg.transaction(async (client) => {
    const result = await client.query(
      "UPDATE sale_orders SET status = '待支付', updated_at = $1 WHERE sale_order_id = $2 AND status = '支付失败'",
      [now, saleOrderId]
    )
    if (result.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 订单状态已变更，请刷新后重试')
    }
    
    await logTransition(client, ctx, 'order.resetFailed', 'sale_order', saleOrderId, '支付失败', '待支付')
  })

  ctx.result = {
    saleOrderId,
    status: '待支付',
    message: '订单已重置，顾客可重新发起付款'
  }
}


async function list(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, page = 1, pageSize = 20 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.effectiveStoreId, pageSize, offset]
  let whereExtra = ''

  if (status) {
    
    if (status === '待支付') {
      params.push(['待支付', '部分支付'])
      whereExtra += ` AND o.status = ANY($${params.length}::order_status[])`
    } else {
      params.push(status)
      whereExtra += ` AND o.status = $${params.length}`
    }
  }

  
  if (!ctx.auth.roles.includes('manager')) {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND o.preferred_employee_id = $${params.length}`
  }

  
  
  
  const orders = await pg.query(`
    SELECT
      o.sale_order_id, o.status, o.sale_order_type, o.client_phone, o.customer_name,
      o.payment_method, o.preferred_employee_id,
      o.paid_at, o.created_at, o.opened_by, o.total_amount, o.is_activity,
      c.name AS cust_name, c.phone AS cust_phone,
      -- 营业额分配口径：仅销售单/转换单且非历史订单可分配（与 order.detail allocatable / allocation.js ALLOCATABLE_ORDER_TYPES 一致），控制列表页分配按钮显隐
      (o.sale_order_type IN ('销售单','转换单') AND o.legacy_source IS DISTINCT FROM 'workfine') AS allocatable,
      EXISTS(
        SELECT 1 FROM sale_order_payments sop
        WHERE sop.sale_order_id = o.sale_order_id
          AND sop.change_type = '退款'
          AND sop.status = '已支付'
      ) AS has_refund,
      EXISTS(
        SELECT 1 FROM sale_order_payments sop
        WHERE sop.sale_order_id = o.sale_order_id
          AND sop.change_type = '退款'
          AND sop.status = '待审批'
      ) AS has_pending_refund
    FROM sale_orders o
    LEFT JOIN client_wechat_users c ON c.user_id = o.client_user_id
    WHERE o.store_id = $1
    ${whereExtra}
    ORDER BY o.created_at DESC
    LIMIT $2 OFFSET $3
  `, params)

  
  const mapped = orders.map((o) => ({
    ...o,
    customer_name: o.cust_name || o.customer_name || null,
    client_phone: o.cust_phone || o.client_phone || null,
  }))
  ctx.result = { orders: mapped, page, pageSize }
}


async function detail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId')
  }

  
  
  const orders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1',
    [saleOrderId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  
  
  
  
  
  
  const inStoreScope = isStoreInScope(ctx.auth, order.store_id)
  const isManager = ctx.auth.roles.includes('manager')
  const isMgmt = ctx.auth.loginLevel === 'management'
  let visible = inStoreScope && (isManager || order.preferred_employee_id === ctx.auth.staffWfId)
  if (!visible && isMgmt && inStoreScope) {
    visible = true 
  }
  if (!visible && order.client_user_id) {
    
    
    
    const custRows = await pg.query(
      'SELECT bound_store_id, bound_employee_id FROM client_wechat_users WHERE user_id = $1',
      [order.client_user_id]
    )
    if (
      custRows.length > 0 &&
      isStoreInScope(ctx.auth, custRows[0].bound_store_id) &&
      (!restrictToBoundEmployee(ctx.auth) || custRows[0].bound_employee_id === ctx.auth.staffWfId)
    ) {
      visible = true
    }
  }
  if (!visible) {
    throw new Error('PERMISSION_DENIED: 无权查看该订单')
  }

  
  
  
  if (order.client_user_id) {
    const clientRows = await pg.query(
      'SELECT phone, name FROM client_wechat_users WHERE user_id = $1 LIMIT 1',
      [order.client_user_id]
    )
    if (clientRows.length > 0) {
      if (clientRows[0].phone) order.client_phone = clientRows[0].phone
      if (clientRows[0].name) order.customer_name = clientRows[0].name
    }
  }

  
  if (order.preferred_employee_id) {
    const staffRows = await pg.query(
      'SELECT name FROM staff_wechat_users WHERE employee_id = $1',
      [order.preferred_employee_id]
    )
    if (staffRows.length > 0) {
      order.preferred_staff_name = (staffRows[0].name || '').trim()
    }
  }

  
  if (order.offline_confirmed_by) {
    const confirmerRows = await pg.query(
      'SELECT name FROM staff_wechat_users WHERE employee_id = $1',
      [order.offline_confirmed_by]
    )
    if (confirmerRows.length > 0) {
      order.offline_confirmed_by_name = (confirmerRows[0].name || '').trim()
    }
  }

  const items = await pg.query(`
    SELECT
      si.sale_item_id, si.sku_id, si.session_count, si.remaining_sessions,
      si.paid_sessions,
      si.unit_price, si.quantity, si.unit_real_price, si.sale_amount, si.received,
      si.expire_date, si.remark, si.sales_category,
      si.product_name, si.product_type, si.picked_up_quantity
    FROM sale_items si
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [saleOrderId])

  
  const allocations = await pg.query(`
    SELECT
      sa.id, sa.sale_item_id, sa.employee_id, sa.department_name,
      sa.allocation_ratio, sa.total_amount, sa.is_void,
      sa.role_type, sa.commission_rate, sa.commission_amount,
      si.product_name AS sale_item_name,
      sw.name AS employee_name
    FROM sale_allocations sa
    JOIN sale_items si ON sa.sale_item_id = si.sale_item_id
    LEFT JOIN staff_wechat_users sw ON sa.employee_id = sw.employee_id
    WHERE si.sale_order_id = $1
    ORDER BY sa.id
  `, [saleOrderId])

  
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

  
  const paymentRows = await pg.query(
    `SELECT id, change_type, amount, payment_method, status,
            paid_at, created_at, note, allocation_status
     FROM sale_order_payments
     WHERE sale_order_id = $1
     ORDER BY created_at ASC, id ASC`,
    [saleOrderId]
  )
  const payments = paymentRows.map(p => ({
    id: p.id,
    change_type: p.change_type,
    amount: Number(p.amount),
    payment_method: p.payment_method,
    status: p.status,
    paid_at: p.paid_at,
    created_at: p.created_at,
    note: p.note,
    allocation_status: p.allocation_status,
  }))

  
  let cardBalance = null
  if (order.client_user_id) {
    const balRows = await pg.query(
      'SELECT balance FROM prepaid_cards WHERE user_id = $1 LIMIT 1',
      [order.client_user_id]
    )
    cardBalance = balRows.length > 0 ? Number(balRows[0].balance) : 0
  }

  ctx.result = {
    order: {
      ...order,
      coupon_name: couponName,
      
      allocatable: ['销售单', '转换单'].includes(order.sale_order_type) && order.legacy_source !== 'workfine',
    },
    items,
    allocations,
    payments,
    cardBalance,
  }
}














const { cascadeRefund } = require('../helpers/refund-cascade')


async function createRefund(ctx) {
  
  
  await requireStaffBound()(ctx, async () => {})

  const { refSaleOrderId, items, refundReason, handlingFee } = ctx.event.payload || {}

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  if (!items || !Array.isArray(items) || items.length === 0) throw new Error('INVALID_PARAMS: 退款明细不能为空')
  if (!refundReason) throw new Error('INVALID_PARAMS: 退款原因不能为空')

  
  await assertOrderInScope(pg, ctx.auth, refSaleOrderId)

  
  const origOrders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND status IN ('已支付', '已完成', '部分支付')",
    [refSaleOrderId]
  )
  if (origOrders.length === 0) throw new Error('INVALID_PARAMS: 原订单状态不允许退款')
  const origOrder = origOrders[0]

  
  
  if (origOrder.legacy_source === 'workfine') {
    throw new Error('INVALID_STATE: 历史订单不支持退款')
  }
  if (origOrder.sale_order_type !== '销售单') {
    if (origOrder.sale_order_type === '充值单') {
      throw new Error('INVALID_STATE: 充值卡退款请在「充值卡」入口发起')
    }
    throw new Error('INVALID_STATE: 仅销售单支持退款')
  }

  
  const inflightRefunds = await pg.query(
    `SELECT id FROM sale_order_payments
      WHERE sale_order_id = $1 AND change_type = '退款' AND status = '待审批' LIMIT 1`,
    [refSaleOrderId]
  )
  if (inflightRefunds.length > 0) {
    throw new Error('CONFLICT: 存在未完结退款')
  }

  
  
  
  const openSvc = await pg.query(
    `SELECT 1 FROM service_orders so2
       JOIN service_items sit ON sit.service_order_id = so2.service_order_id
       JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
      WHERE si.sale_order_id = $1 AND so2.status IN ('待服务','服务中','待客户确认') LIMIT 1`,
    [refSaleOrderId]
  )
  if (openSvc.length > 0) {
    throw new Error('INVALID_STATE: 该订单有未完成的服务单，请先完成或取消后再退款')
  }

  
  const origItems = await pg.query(
    "SELECT * FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'",
    [refSaleOrderId]
  )

  
  let { refundDetails, totalRefund } = buildRefundDetails(origItems, items)

  const fee = Math.max(0, Number(handlingFee) || 0)  
  
  
  
  const cardUnitPrices = refundDetails.filter((d) => d.productType === '疗程卡').map((d) => Number(d.unitRealPrice))
  if (cardUnitPrices.length > 0 && fee >= Math.min(...cardUnitPrices)) {
    throw new Error('INVALID_PARAMS: 手续费不能超过单次服务价格')
  }
  let finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
  if (finalRefundAmount <= 0) {
    throw new Error('INVALID_STATE: 无可退项')
  }

  
  
  
  
  
  
  const paymentsNetRows = await pg.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS net
       FROM sale_order_payments
      WHERE sale_order_id = $1 AND status = '已支付'`,
    [refSaleOrderId],
  )
  const paymentsNet = Number(paymentsNetRows[0]?.net || 0)
  
  
  
  const refundCap = Math.max(paymentsNet, Number(origOrder.received || 0) - Number(origOrder.refunded_amount || 0))
  if (finalRefundAmount > refundCap + 0.001) {
    
    
    
    
    const hasCourseCard = refundDetails.some((d) => d.productType === '疗程卡')
    if (!hasCourseCard) {
      throw new Error('INVALID_STATE: 退款金额超过订单可退余额，请减少退款数量')
    }
    const targetGross = Math.max(0, Math.round((refundCap + fee) * 100) / 100)
    totalRefund = capRefundAmounts(refundDetails, totalRefund, targetGross)
    finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
    if (finalRefundAmount <= 0) {
      throw new Error('INVALID_STATE: 无可退项')
    }
  }

  
  const origPrepaidCardAmount = Number(origOrder.prepaid_card_amount || 0)
  const origTotalAmount = Number(origOrder.total_amount || 0)
  const { refundByCard, refundByOrigin } = splitRefundByOriginalPayment(
    finalRefundAmount,
    origPrepaidCardAmount,
    origTotalAmount,
  )

  
  const refundPaymentMethod = resolveRefundPaymentMethod(origOrder.payment_method)

  const now = new Date()
  let paymentId
  
  
  
  
  
  const isWholeOrderRefund = origItems.length > 0 && origItems.every((oi) =>
    refundDetails.some((d) => d.refSaleItemId === oi.sale_item_id && d.isFullItemRefund),
  )
  const detailNote = JSON.stringify({
    _v: 2,
    refundByCard,
    refundByOrigin,
    handlingFee: fee,
    refundPaymentMethod,
    isWholeOrderRefund,
    items: refundDetails.map(d => ({
      refSaleItemId: d.refSaleItemId,
      quantity: d.quantity,
      refundAmount: d.refundAmount,
      productType: d.productType,
      isFullItemRefund: d.isFullItemRefund,
    })),
  })

  try {
  await pg.transaction(async (client) => {
    const sopRes = await client.query(
      `INSERT INTO sale_order_payments (
        sale_order_id, change_type, amount, payment_method, external_txn_id,
        status, source_end, operator_employee_id, refund_reason,
        ref_sale_item_id, session_count, note, created_at
      ) VALUES ($1, '退款', $2, $3::payment_method, NULL, '待审批', 'staff', $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        refSaleOrderId,
        -finalRefundAmount,
        refundPaymentMethod,
        ctx.auth.staffWfId,
        refundReason,
        
        
        refundDetails.length === 1 ? (refundDetails[0].refSaleItemId || null) : null,
        refundDetails.length === 1 ? (refundDetails[0].quantity || null) : null,
        detailNote,
        now,
      ]
    )
    paymentId = sopRes.rows[0].id

    
    await logOperation(client, ctx, 'order.createRefund', 'sale_order_payment', paymentId, {
      _v: 3,
      saleOrderId: refSaleOrderId,
      finalRefundAmount,
      refundByCard,
      refundByOrigin,
      handlingFee: fee,
    })

    
    await notifyRefundCreated(client, {
      paymentId,
      saleOrderId: refSaleOrderId,
      storeId: origOrder.store_id,
      operatorId: ctx.auth.staffWfId,
      amount: finalRefundAmount,
      customerName: origOrder.customer_name,
    })
  })
  } catch (e) {
    
    
    const code = e && (e.code || (e.cause && e.cause.code))
    if (code === '23505') throw new Error('CONFLICT: 存在未完结退款')
    throw e
  }

  ctx.result = {
    paymentId,
    paymentIds: [paymentId],   
    status: '待审批',
    totalAmount: -finalRefundAmount,    
    totalRefund: finalRefundAmount,
    refundByCard,
    refundByOrigin,
    finalRefundAmount,
    refundPaymentMethod,
    message: '退款已发起，等待审批',
  }
}


async function approveRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { paymentId, auditRemark } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  
  const sopRows = await pg.query(
    `SELECT sop.id, sop.sale_order_id, sop.amount, sop.status, sop.payment_method,
            sop.refund_reason, sop.ref_sale_item_id, sop.session_count, sop.note, sop.operator_employee_id,
            so.store_id, so.client_user_id, so.received, so.refunded_amount, so.sale_order_type
       FROM sale_order_payments sop
       JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
      WHERE sop.id = $1 AND sop.change_type = '退款'`,
    [paymentId]
  )
  if (sopRows.length === 0) throw new Error('NOT_FOUND: 退款流水不存在')
  const sopRow = sopRows[0]
  if (!isStoreInScope(ctx.auth, sopRow.store_id)) {
    throw new Error('PERMISSION_DENIED: 订单不在当前门店范围内')
  }
  if (sopRow.status !== '待审批') {
    throw new Error('INVALID_STATE: 退款流水状态不是待审批')
  }
  
  
  if (sopRow.sale_order_type === '充值单') {
    throw new Error('INVALID_STATE: 充值卡退款请在「充值卡」入口审批')
  }

  const refSaleOrderId = sopRow.sale_order_id
  const refundAbs = Math.abs(Number(sopRow.amount || 0))
  const now = new Date()

  await pg.transaction(async (client) => {
    
    
    const capNowRes = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS net FROM sale_order_payments
        WHERE sale_order_id = $1 AND status = '已支付'`,
      [refSaleOrderId]
    )
    const paymentsNetNow = Number(capNowRes.rows[0]?.net || 0)
    const refundCapNow = Math.max(paymentsNetNow, Number(sopRow.received || 0) - Number(sopRow.refunded_amount || 0))
    if (refundAbs > refundCapNow + 0.001) {
      throw new Error('INVALID_STATE: 订单可退余额已变化，请刷新后重新发起退款')
    }

    
    const cas = await client.query(
      `UPDATE sale_order_payments
          SET status = '已支付', paid_at = $1,
              audit_employee_id = $2, audit_at = $1, audit_remark = $3
        WHERE id = $4 AND status = '待审批'`,
      [now, ctx.auth.staffWfId, auditRemark || null, paymentId]
    )
    if (cas.rowCount !== 1) {
      throw new Error('INVALID_STATE: 退款流水状态已变更，请刷新后重试')
    }

    
    
    await client.query(
      `UPDATE sale_orders so
          SET refunded_amount = COALESCE((
                SELECT -SUM(sop.amount) FROM sale_order_payments sop
                WHERE sop.sale_order_id = so.sale_order_id
                  AND sop.change_type = '退款' AND sop.status = '已支付'
              ), 0),
              updated_at = $1
        WHERE so.sale_order_id = $2`,
      [now, refSaleOrderId]
    )

    
    
    
    

    
    let cascadeItems = []
    let cascadeWholeOrder = false
    try {
      const noteObj = sopRow.note ? (typeof sopRow.note === 'string' ? JSON.parse(sopRow.note) : sopRow.note) : null
      if (noteObj && Array.isArray(noteObj.items)) {
        cascadeItems = noteObj.items.map((it) => ({
          saleItemId: it.refSaleItemId,
          sessionCount: it.quantity,
          refundAmount: it.refundAmount ?? null,
          isFullItemRefund: !!it.isFullItemRefund,
        }))
        cascadeWholeOrder = !!noteObj.isWholeOrderRefund
      }
    } catch (_) { cascadeItems = [] }
    
    if (cascadeItems.length === 0 && sopRow.ref_sale_item_id) {
      cascadeItems = [{ saleItemId: sopRow.ref_sale_item_id, sessionCount: sopRow.session_count, refundAmount: refundAbs, isFullItemRefund: true }]
    }
    const cascadeResult = await cascadeRefund(client, {
      saleOrderId: refSaleOrderId,
      refundPaymentId: paymentId,
      items: cascadeItems,
      isWholeOrderRefund: cascadeWholeOrder,
      refundReason: sopRow.refund_reason || '退款审批通过',
    })

    
    
    await recalcPaidSessionsForOrder(client, refSaleOrderId)

    
    if (sopRow.client_user_id) {
      await refreshSpendingTier(client, sopRow.client_user_id)
      await recalcCustomerType(client, sopRow.client_user_id)
      
      await recalcMemberLevel(client, sopRow.client_user_id, await getMemberThreshold(), 'staffApi')
    }

    
    await logOperation(client, ctx, 'order.approveRefund', 'sale_order_payment', paymentId, {
      _v: 3,
      saleOrderId: refSaleOrderId,
      refundAbs,
      paymentMethod: sopRow.payment_method,
      cascade: cascadeResult,
    })

    
    if (sopRow.operator_employee_id && sopRow.operator_employee_id !== ctx.auth.staffWfId) {
      await notifyRefundResult(client, {
        paymentId,
        saleOrderId: refSaleOrderId,
        recipientEmployeeId: sopRow.operator_employee_id,
        approved: true,
        amount: refundAbs,
      })
    }

    
    
    
  })

  ctx.result = {
    paymentId,
    status: '已支付',
    refundAbs,
    saleOrderId: refSaleOrderId,
    message: '退款已审批通过，5 通道已级联回滚',
  }
}


async function rejectRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { paymentId, auditRemark, rejectedReason } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')
  
  const remark = auditRemark || rejectedReason || ''

  const sopRows = await pg.query(
    `SELECT sop.id, sop.sale_order_id, sop.status, sop.operator_employee_id, so.store_id, so.sale_order_type
       FROM sale_order_payments sop
       JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
      WHERE sop.id = $1 AND sop.change_type = '退款'`,
    [paymentId]
  )
  if (sopRows.length === 0) throw new Error('NOT_FOUND: 退款流水不存在')
  const sopRow = sopRows[0]
  if (!isStoreInScope(ctx.auth, sopRow.store_id)) {
    throw new Error('PERMISSION_DENIED: 订单不在当前门店范围内')
  }
  if (sopRow.status !== '待审批') {
    throw new Error('INVALID_STATE: 退款流水状态不是待审批')
  }
  
  if (sopRow.sale_order_type === '充值单') {
    throw new Error('INVALID_STATE: 充值卡退款请在「充值卡」入口审批')
  }

  const now = new Date()

  await pg.transaction(async (client) => {
    const cas = await client.query(
      `UPDATE sale_order_payments
          SET status = '已作废',
              audit_employee_id = $1, audit_at = $2, audit_remark = $3
        WHERE id = $4 AND status = '待审批'`,
      [ctx.auth.staffWfId, now, remark, paymentId]
    )
    if (cas.rowCount !== 1) {
      throw new Error('INVALID_STATE: 退款流水状态已变更，请刷新后重试')
    }

    
    await logOperation(client, ctx, 'order.rejectRefund', 'sale_order_payment', paymentId, {
      _v: 3,
      saleOrderId: sopRow.sale_order_id,
      rejectedReason: remark,
    })

    
    if (sopRow.operator_employee_id && sopRow.operator_employee_id !== ctx.auth.staffWfId) {
      await notifyRefundResult(client, {
        paymentId,
        saleOrderId: sopRow.sale_order_id,
        recipientEmployeeId: sopRow.operator_employee_id,
        approved: false,
        reason: remark,
      })
    }
  })

  ctx.result = { paymentId, status: '已作废', message: '退款已驳回' }
}




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
    idempotencyKey,
  } = payload
  const storeId = ctx.auth.effectiveStoreId

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  if (!paymentMethod) throw new Error('INVALID_PARAMS: 缺少 paymentMethod')
  
  
  if (!['线下', '储值卡'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式（仅支持 线下/储值卡）')
  }

  
  await assertNoPendingRefund(pg, refSaleOrderId)

  
  
  let repayItems = null
  if (Array.isArray(items) && items.length > 0) {
    repayItems = items
      .map((it) => ({
        saleItemId: String(it.saleItemId || ''),
        repayAmount: Math.max(0, Math.round((Number(it.repayAmount) || 0) * 100) / 100),
        prepaidCardAmount: Math.max(0, Math.round((Number(it.prepaidCardAmount) || 0) * 100) / 100),
      }))
      .filter((it) => it.saleItemId && (it.repayAmount > 0 || it.prepaidCardAmount > 0))
    if (repayItems.length === 0) repayItems = null
  }

  
  let repayAmount, prepaidCardAmount
  if (repayItems) {
    repayAmount = repayItems.reduce((s, it) => s + it.repayAmount, 0)
    prepaidCardAmount = repayItems.reduce((s, it) => s + it.prepaidCardAmount, 0)
  } else {
    repayAmount = (inputRepayAmount !== undefined && inputRepayAmount !== null) ? Number(inputRepayAmount) : 0
    prepaidCardAmount = Number(inputPrepaidCard) || 0
  }
  if (!Number.isFinite(repayAmount) || repayAmount < 0) {
    throw new Error('INVALID_PARAMS: 还款金额必须为非负数')
  }
  repayAmount = Math.round(repayAmount * 100) / 100
  prepaidCardAmount = Math.max(0, Math.round(prepaidCardAmount * 100) / 100)
  const totalThisTime = Math.round((repayAmount + prepaidCardAmount) * 100) / 100
  if (totalThisTime <= 0) {
    throw new Error('INVALID_PARAMS: 回款金额必须大于0')
  }

  
  if (paymentMethod === '储值卡' && repayAmount > 0) {
    throw new Error('INVALID_PARAMS: 储值卡付款方式下不应传还款金额（应通过储值卡抵扣金额传递）')
  }

  
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

  
  
  
  const repayRefId = `REPAY-${refSaleOrderId}-${Date.now()}`

  
  
  
  const repayIdempRef = idempotencyKey && prepaidCardAmount > 0
    ? `card-repay-${refSaleOrderId}-${idempotencyKey}`
    : null

  const result = await pg.transaction(async (client) => {
    
    const lockRes = await client.query(
      'SELECT * FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE',
      [refSaleOrderId]
    )
    if (lockRes.rows.length === 0) throw new Error('INVALID_PARAMS: 原订单不存在')
    const locked = lockRes.rows[0]

    
    if (locked.sale_order_type === '寄存单') {
      throw new Error('INVALID_STATE: 寄存单不支持回款')
    }
    if (locked.legacy_source === 'workfine') {
      throw new Error('INVALID_STATE: 历史订单不支持回款')
    }

    if (!['部分支付', '待支付'].includes(locked.status)) {
      throw new Error(`INVALID_STATE: 订单当前状态"${locked.status}"不允许回款`)
    }

    
    
    
    if (repayIdempRef) {
      const dupRes = await client.query(
        'SELECT 1 FROM card_transactions WHERE external_ref = $1 LIMIT 1',
        [repayIdempRef]
      )
      if (dupRes.rows.length > 0) {
        return {
          refSaleOrderId,
          repayAmount,
          prepaidCardAmount,
          refStatus: locked.status,
          refReceived: Number(locked.received || 0),
          refPrepaidCardAmount: Number(locked.prepaid_card_amount || 0),
          idempotent: true,
        }
      }
    }

    
    
    
    
    const origTotal = Number(locked.total_amount || 0)
    const origReceived = Number(locked.received || 0)
    const origRefunded = Number(locked.refunded_amount || 0)
    const remainingPayable = Math.round((origTotal - origReceived + origRefunded) * 100) / 100

    
    if (totalThisTime > remainingPayable + 0.001) {
      throw new Error('INVALID_PARAMS: 本次回款金额超过订单欠款')
    }

    
    if (repayItems) {
      const itemRows = await client.query(
        `SELECT sale_item_id, sale_amount::numeric AS sale_amount, received::numeric AS received
           FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
        [refSaleOrderId]
      )
      const itemMap = new Map(itemRows.rows.map((r) => [r.sale_item_id, r]))
      for (const it of repayItems) {
        const row = itemMap.get(it.saleItemId)
        if (!row) throw new Error(`INVALID_PARAMS: 子项 ${it.saleItemId} 不属于本订单`)
        const itemRemaining = Math.round((Number(row.sale_amount) - Number(row.received)) * 100) / 100
        const itemThis = Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100
        if (itemThis > itemRemaining + 0.001) {
          throw new Error(`INVALID_PARAMS: 子项 ${it.saleItemId} 回款额超过该行可回款额`)
        }
      }
    }

    
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
      await client.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
         VALUES ($1, '扣款', $2, $3, $4, NOW())
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
        
        
        [cardId, -prepaidCardAmount, refSaleOrderId, repayIdempRef || `card-repay-${repayRefId}`]
      )
    }

    
    
    
    
    const repayStatusRow = '已支付'
    const repayPaidAt = now
    
    let cashPaymentId = null
    let cardPaymentId = null
    if (repayAmount > 0) {
      const ins = await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at, paid_at
        ) VALUES ($1, '回款', $2, $3, NULL, $4, 'staff', $5, $6, $7, $8) RETURNING id`,
        [refSaleOrderId, repayAmount, paymentMethod, repayStatusRow, ctx.auth.staffWfId, note || '店长发起回款', now, repayPaidAt]
      )
      cashPaymentId = ins.rows[0].id
    }
    if (prepaidCardAmount > 0) {
      const ins = await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at, paid_at
        ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'staff', $3, $4, $5, $5) RETURNING id`,
        [refSaleOrderId, prepaidCardAmount, ctx.auth.staffWfId, '店长发起回款-储值卡抵扣', now]
      )
      cardPaymentId = ins.rows[0].id
    }
    
    const primaryPaymentId = cashPaymentId || cardPaymentId

    
    
    
    
    if (repayItems) {
      const repayValuesSql = repayItems
        .map((_, i) => `($${i * 2 + 2}::varchar, $${i * 2 + 3}::numeric)`)
        .join(', ')
      const repayParams = repayItems.flatMap((it) => [
        it.saleItemId,
        (Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100).toFixed(2),
      ])
      await client.query(
        `WITH repay (sale_item_id, delta) AS (VALUES ${repayValuesSql})
         UPDATE sale_items si
         SET pending_received = COALESCE(rp.delta, 0),
             updated_at = NOW()
         FROM (SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买') ai
         LEFT JOIN repay rp ON rp.sale_item_id = ai.sale_item_id
         WHERE si.sale_item_id = ai.sale_item_id`,
        [refSaleOrderId, ...repayParams]
      )
    }

    
    
    
    
    
    const sumRes = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
                           THEN amount::numeric ELSE 0 END), 0) AS new_received,
         COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                           THEN amount::numeric ELSE 0 END), 0) AS new_prepaid
       FROM sale_order_payments
       WHERE sale_order_id = $1`,
      [refSaleOrderId]
    )
    const newReceived = Math.round(Number(sumRes.rows[0].new_received) * 100) / 100
    const newPrepaid = Math.round(Number(sumRes.rows[0].new_prepaid) * 100) / 100
    const settled = newReceived
    
    
    
    
    const settleTarget = Math.round(Number(locked.total_amount || 0) * 100) / 100
    const targetStatus = settled + 0.001 >= settleTarget ? '已支付' : '部分支付'

    
    const paidAtValue = targetStatus === '已支付' ? now : (locked.paid_at || null)

    const updateRes = await client.query(
      `UPDATE sale_orders
         SET status = $1, received = $2, prepaid_card_amount = $3,
             paid_at = $4, updated_at = $5
       WHERE sale_order_id = $6 AND status = $7`,
      [targetStatus, newReceived, newPrepaid, paidAtValue, now, refSaleOrderId, locked.status]
    )
    if (updateRes.rowCount === 0) {
      throw new Error('INVALID_STATE: 原订单状态已变更，请刷新后重试')
    }

    
    
    const directedForCapture = repayItems
      ? repayItems.map((it) => ({
          saleItemId: it.saleItemId,
          amount: Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100,
        }))
      : null
    await capturePaymentAllocatables(client, {
      salePaymentId: primaryPaymentId,
      saleOrderId: refSaleOrderId,
      eventAmount: totalThisTime,
      directedItems: directedForCapture,
    })
    await refreshOrderAllocationRollup(client, refSaleOrderId)

    
    
    await recalcPaidSessionsForOrder(client, refSaleOrderId)

    
    await refreshSpendingTier(client, locked.client_user_id)
    await recalcCustomerType(client, locked.client_user_id)
    
    await recalcMemberLevel(client, locked.client_user_id, await getMemberThreshold(), 'staffApi')

    
    await logTransition(client, ctx, 'order.createRepayment', 'sale_order', refSaleOrderId, locked.status, targetStatus, {
      repayAmount,
      prepaidCardAmount,
      received: newReceived,
    })

    return {
      refSaleOrderId,
      repayAmount,
      prepaidCardAmount,
      refStatus: targetStatus,
      refReceived: newReceived,
      refPrepaidCardAmount: newPrepaid,
    }
  })

  ctx.result = {
    ...result,
    
    paymentParams: null,
    status: '已支付', 
    totalAmount: totalThisTime,
    
    repaymentOrderId: null,    
    saleOrderId: refSaleOrderId,
    message: result.refStatus === '已支付' ? '回款成功，订单已付清' : '回款成功，订单仍部分支付',
  }
}




async function createConversion(ctx) {
  await requireManager()(ctx, async () => {})

  const {
    clientUserId,
    convertOutSaleItemIds,
    convertInItems,
    paymentMethod,
    preferredStaffWfId,
    remark,
    prepaidCardAmount: inputPrepaidCardAmount,
    isActivity,
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
  if (!paymentMethod || !['微信', '支付宝', '线下'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 支付方式仅支持 微信/支付宝/线下')
  }
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  
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
  
  if (!isStoreInScope(ctx.auth, client.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法开单')
  }

  const now = new Date()
  
  
  let convOrderId

  const result = await pg.transaction(async (tx) => {
    
    convOrderId = await generateOrderNo('FY-XSD-WX-', tx)

    
    const heldResult = await tx.query(
      `SELECT si.sale_item_id,
              si.sale_order_id,
              si.store_id,
              si.item_direction,
              si.sku_id,
              si.product_name,
              si.product_type,
              si.session_count,
              si.remaining_sessions,
              si.quantity,
              si.picked_up_quantity,
              si.unit_price,
              si.unit_real_price,
              si.sales_category,
              si.service_fee,
              si.is_shengmei,
              si.is_experience,
              so.client_user_id,
              so.status AS order_status,
              pc.product_kind,
              pc_parent.category_name AS parent_category_name
       FROM sale_items si
       JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
       LEFT JOIN product_skus ps ON si.sku_id = ps.sku_id
       LEFT JOIN product_categories pc ON ps.category_id = pc.category_id
       LEFT JOIN product_categories pc_parent ON pc_parent.category_name = pc.product_kind AND pc_parent.product_kind IS NULL
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
      
      await assertNoPendingRefund(tx, row.sale_order_id)

      const unit = Number(row.unit_real_price)
      const productType = row.product_type
      
      let qty = 0
      if (productType === '疗程卡') {
        const rem = Number(row.remaining_sessions || 0)
        if (rem <= 0) throw new Error('INVALID_PARAMS: 部分卡已耗尽')
        qty = rem
      } else {
        throw new Error('INVALID_PARAMS: 所选行类型不支持折抵')
      }

      const amount = Math.round(unit * qty * 100) / 100
      totalOut += amount

      
      const origServiceFee = Number(row.service_fee || 0)
      const origQty = Number(row.quantity) || 1
      const outServiceFee = -Math.round((origServiceFee * qty / origQty) * 100) / 100

      outItems.push({
        refSaleItemId: row.sale_item_id,
        skuId: row.sku_id,
        productName: row.product_name,
        productType,
        sessionCount: row.session_count != null ? Number(row.session_count) : null,
        unitPrice: Number(row.unit_price),
        unitRealPrice: unit,
        quantity: qty,
        amount,
        salesCategory: row.sales_category,
        serviceFee: outServiceFee,
        isShengmei: row.is_shengmei ?? null,
        isExperience: row.is_experience === true,
      })
    }

    
    let totalIn = 0
    const inItems = []
    for (const req of convertInItems) {
      if (!req || !req.skuId) throw new Error('INVALID_PARAMS: 转入项目缺少 skuId')
      const skuRes = await tx.query(
        `SELECT s.sku_id, s.product_type, s.spec_name, s.price, s.session_count, s.service_fee,
                s.is_shengmei, s.is_experience, pc.sales_category
         FROM product_skus s
         JOIN product_categories pc ON s.category_id = pc.category_id
         WHERE s.sku_id = $1 AND s.deleted_at IS NULL`,
        [req.skuId]
      )
      if (skuRes.rows.length === 0) throw new Error(`INVALID_PARAMS: 商品 ${req.skuId} 不存在`)
      const sku = skuRes.rows[0]
      const qty = Number(req.quantity) || 1
      const amount = Math.round(Number(sku.price) * qty * 100) / 100
      totalIn += amount
      const inServiceFee = Math.round(Number(sku.service_fee || 0) * qty * 100) / 100
      
      const inSessionCount = sku.session_count != null ? Number(sku.session_count) * qty : null
      const inDenom = (inSessionCount != null && inSessionCount > 0) ? inSessionCount : qty
      
      const inPerSessionUnit = inDenom > 0 ? Math.round((amount / inDenom) * 100) / 100 : amount
      inItems.push({
        skuId: sku.sku_id,
        productName: sku.spec_name,
        productType: sku.product_type,
        sessionCount: inSessionCount,
        unitPrice: inPerSessionUnit,
        quantity: qty,
        amount,
        salesCategory: sku.sales_category,
        serviceFee: inServiceFee,
        isShengmei: sku.is_shengmei ?? null,
        isExperience: sku.is_experience === true,
      })
    }

    const priceDiff = Math.round((totalIn - totalOut) * 100) / 100
    const orderTotal = Math.max(0, priceDiff)

    
    
    let card = 0
    if (priceDiff > 0 && inputPrepaidCardAmount != null) {
      const v = Number(inputPrepaidCardAmount)
      if (!Number.isFinite(v) || v < 0) throw new Error('INVALID_PARAMS: 储值卡抵扣金额必须为非负数')
      card = Math.min(Math.round(v * 100) / 100, priceDiff)
    }
    const payable = Math.max(0, Math.round((orderTotal - card) * 100) / 100)
    const isFullCardCoverage = card > 0 && payable === 0
    
    
    const orderStatus = priceDiff > 0 ? (payable > 0 ? '待支付' : '已支付') : '已支付'
    const orderPaid = priceDiff <= 0 || isFullCardCoverage
    
    const effectivePaymentMethod = isFullCardCoverage ? '无' : paymentMethod

    
    let documentType = client.customer_type === '会员客' ? '售后' : '售前'
    if (documentType === '售前') {
      const threshold = await getMemberThreshold()
      if (totalIn >= threshold) documentType = '售后'
    }

    
    await tx.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type,
        market_name, store_id, store_name, sale_order_datetime,
        client_user_id, client_phone, customer_name,
        total_amount, payable_amount, prepaid_card_amount, received,
        payment_method, opened_by,
        preferred_employee_id, allocation_status, remark,
        paid_at, created_at, updated_at, is_activity
      ) VALUES ($1, $2, '转换单', $3, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $5), $4), $5, (SELECT store_name FROM stores WHERE store_id = $5), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, '待分配', $17, $18, $6, $6, $19)`,
      [
        convOrderId, orderStatus, documentType, marketName, storeId, now,
        clientUserId, client.phone || null, client.name || null,
        orderTotal.toFixed(2), payable.toFixed(2), card.toFixed(2),
        (isFullCardCoverage ? card : 0).toFixed(2),
        effectivePaymentMethod, ctx.auth.staffWfId,
        preferredStaffWfId || null,
        remark || null,
        orderPaid ? now : null,
        isActivity === true,
      ]
    )

    
    const dateStr = shanghaiYMD(now)
    const maxResult = await tx.query(
      `SELECT sale_item_id FROM sale_items WHERE sale_item_id LIKE $1
       ORDER BY sale_item_id DESC LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )
    let seq = 1
    if (maxResult.rows.length > 0) {
      seq = parseInt(maxResult.rows[0].sale_item_id.slice(-4)) + 1
    }

    
    for (const d of outItems) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq).padStart(4, '0')}`
      seq++
      await tx.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction, ref_sale_item_id,
          sku_id, product_name, product_type,
          session_count, unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee, is_shengmei, is_experience
        ) VALUES ($1, $2, $3, '转出', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          saleItemId, convOrderId, storeId, d.refSaleItemId,
          d.skuId, d.productName, d.productType,
          d.sessionCount, d.unitPrice, d.quantity, d.unitRealPrice,
          -d.amount, -d.amount,
          d.salesCategory, d.serviceFee,
          d.isShengmei ?? null,
          
          
          d.isExperience === true,
        ]
      )
      
      
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
      }
    }

    
    for (const d of inItems) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq).padStart(4, '0')}`
      seq++
      await tx.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction,
          sku_id, product_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee, is_shengmei, is_experience
        ) VALUES ($1, $2, $3, '转入', $4, $5, $6, $7, $7, $8, $9, $8, $10, $10, $11, $12, $13, $14)`,
        [
          saleItemId, convOrderId, storeId,
          d.skuId, d.productName, d.productType,
          d.sessionCount,
          d.unitPrice, d.quantity, d.amount,
          d.salesCategory, d.serviceFee,
          d.isShengmei ?? null,
          
          d.isExperience === true,
        ]
      )
    }

    
    
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
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
         VALUES ($1, '充值', $2, $3, $4)
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
        [cardId, creditAmount.toFixed(2), convOrderId, `card-conv-${convOrderId}`]
      )
    }

    
    
    let convFullCardPaymentId = null
    if (isFullCardCoverage) {
      convFullCardPaymentId = await deductPrepaidCardAtCreation(tx, {
        saleOrderId: convOrderId,
        clientUserId,
        amount: card,
        staffWfId: ctx.auth.staffWfId,
        note: '店长转换单-储值卡全额抵扣',
        now,
      })
    }

    
    
    if (convFullCardPaymentId && card > 0) {
      await capturePaymentAllocatables(tx, {
        salePaymentId: convFullCardPaymentId,
        saleOrderId: convOrderId,
        eventAmount: card,
        directedItems: null,
      })
      await refreshOrderAllocationRollup(tx, convOrderId)
    }

    
    
    
    await recalcPaidSessionsForOrder(tx, convOrderId)

    
    if (isFullCardCoverage) {
      await settlePaidByCardAtCreation(tx, {
        saleOrderId: convOrderId,
        clientUserId,
        receivedAmount: card,
        now,
      })
    }

    
    await logOperation(tx, ctx, 'order.createConversion', 'sale_order', convOrderId, {
      _v: 3,
      storeId,
      clientUserId,
      priceDiff,
      prepaidCardAmount: card,
      orderStatus,
    })

    return { totalIn, totalOut, priceDiff, orderStatus, prepaidCardCredit, prepaidCardAmount: card }
  })

  const convRemaining = Math.max(0, Math.round((result.priceDiff - result.prepaidCardAmount) * 100) / 100)
  ctx.result = {
    saleOrderId: convOrderId,
    status: result.orderStatus,
    totalIn: Math.round(result.totalIn * 100) / 100,
    totalOut: Math.round(result.totalOut * 100) / 100,
    priceDiff: result.priceDiff,
    prepaidCardCredit: result.prepaidCardCredit,
    prepaidCardAmount: result.prepaidCardAmount,
    message:
      result.priceDiff > 0
        ? (convRemaining > 0
            ? (result.prepaidCardAmount > 0
                ? `转换单已创建，储值卡抵扣 ¥${result.prepaidCardAmount.toFixed(2)}，请收款 ¥${convRemaining.toFixed(2)}`
                : '转换单已创建')
            : `转换单已完成，储值卡全额抵扣 ¥${result.prepaidCardAmount.toFixed(2)}`)
        : '转换单已创建',
  }
}


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
            si.product_type,
            si.remaining_sessions,
            (si.quantity - COALESCE(si.picked_up_quantity, 0)) AS remaining_quantity,
            si.unit_real_price,
            CASE
              WHEN si.product_type = '疗程卡'
                THEN si.unit_real_price * COALESCE(si.remaining_sessions, 0)
              ELSE 0
            END AS deductible_amount
     FROM sale_items si
     JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
     WHERE so.client_user_id = $1
       AND si.store_id = $2
       AND si.item_direction = '购买'
       AND so.status IN ('已支付', '已完成')
       AND si.product_type = '疗程卡'
       AND COALESCE(si.remaining_sessions, 0) > 0
       -- 在途退款冻结：原订单存在 '待审批' 退款时排除整单的卡
       AND NOT EXISTS (
         SELECT 1 FROM sale_order_payments sop
         WHERE sop.sale_order_id = si.sale_order_id
           AND sop.change_type = '退款' AND sop.status = '待审批'
       )
       -- 审批后隐藏已退完的卡：仅当订单存在已审批退款时按 paid_sessions 有效余量判定（不影响无退款的分期卡）
       AND (
         NOT EXISTS (
           SELECT 1 FROM sale_order_payments sop
           WHERE sop.sale_order_id = si.sale_order_id
             AND sop.change_type = '退款' AND sop.status = '已支付'
         )
         OR si.paid_sessions IS NULL
         OR si.paid_sessions > (si.session_count - si.remaining_sessions)
       )
     ORDER BY si.sale_order_id DESC`,
    [clientUserId, storeId]
  )

  ctx.result = {
    cards: rows.map(r => ({
      saleItemId: r.sale_item_id,
      sourceSaleOrderId: r.source_sale_order_id,
      productName: r.product_name,
      productType: r.product_type,
      remainingSessions: r.remaining_sessions != null ? Number(r.remaining_sessions) : null,
      remainingQuantity: r.remaining_quantity != null ? Number(r.remaining_quantity) : null,
      unitRealPrice: String(r.unit_real_price),
      deductibleAmount: Number(r.deductible_amount).toFixed(2),
    }))
  }
}




async function createPickup(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { saleItemId, pickupQuantity, remark, idempotencyKey } = ctx.event.payload || {}
  if (!saleItemId) throw new Error('INVALID_PARAMS: 缺少 saleItemId')
  if (!pickupQuantity || pickupQuantity <= 0) throw new Error('INVALID_PARAMS: 取货数量必须大于0')

  
  
  if (idempotencyKey) {
    const existRes = await pg.query(
      `SELECT id FROM pickup_records WHERE sale_item_id = $1 AND idempotency_key = $2 LIMIT 1`,
      [saleItemId, idempotencyKey]
    )
    if (existRes.length > 0) {
      const curRes = await pg.query(
        `SELECT quantity, COALESCE(picked_up_quantity, 0) AS picked_up_quantity
         FROM sale_items WHERE sale_item_id = $1`,
        [saleItemId]
      )
      const r = curRes[0]
      ctx.result = {
        saleItemId,
        pickedUp: Number(r.picked_up_quantity),
        total: Number(r.quantity),
        remaining: Number(r.quantity) - Number(r.picked_up_quantity),
        message: '取货成功（幂等）',
      }
      return
    }
  }

  
  const pickupOrderRows = await pg.query(`SELECT sale_order_id FROM sale_items WHERE sale_item_id = $1`, [saleItemId])
  if (pickupOrderRows.length > 0) await assertNoPendingRefund(pg, pickupOrderRows[0].sale_order_id)

  let updated
  await pg.transaction(async (client) => {
    
    const result = await client.query(
      `UPDATE sale_items
       SET picked_up_quantity = COALESCE(picked_up_quantity, 0) + $1, updated_at = NOW()
       WHERE sale_item_id = $2
         AND store_id = $3
         AND product_type = '家居产品'
         AND (COALESCE(picked_up_quantity, 0) + $1) <= quantity
       RETURNING sale_item_id, quantity, picked_up_quantity`,
      [pickupQuantity, saleItemId, ctx.auth.effectiveStoreId]
    )

    if (result.rowCount === 0) {
      
      const probe = await client.query(
        `SELECT store_id, product_type, quantity, COALESCE(picked_up_quantity, 0) AS picked_up_quantity
         FROM sale_items WHERE sale_item_id = $1`,
        [saleItemId]
      )
      const row = probe.rows[0]
      if (!row) throw new Error('INVALID_PARAMS: 商品不存在')
      if (row.store_id !== ctx.auth.effectiveStoreId) {
        throw new Error(`INVALID_PARAMS: 该商品仅在 ${row.store_id} 可提货，当前门店无法操作`)
      }
      if (row.product_type !== '家居产品') {
        throw new Error('INVALID_PARAMS: 该商品类型不支持提货')
      }
      throw new Error('INVALID_PARAMS: 取货数量超出可提货数量')
    }

    
    const itemRows = await client.query(
      `SELECT si.sale_order_id, o.client_user_id
       FROM sale_items si JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
       WHERE si.sale_item_id = $1`,
      [saleItemId]
    )
    const clientUserId = itemRows.rows.length > 0 ? itemRows.rows[0].client_user_id : null

    
    try {
      await client.query(
        `INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, client_user_id, confirmed_by, remark, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [saleItemId, pickupQuantity, ctx.auth.effectiveStoreId, clientUserId, ctx.auth.staffWfId, remark || null, idempotencyKey || null]
      )
    } catch (err) {
      if (err && err.code === '23505' && err.constraint === 'uq_pickup_idempotency') {
        throw new Error('CONFLICT: 提货请求重复，请勿重复提交')
      }
      throw err
    }

    updated = result.rows[0]

    
    await logOperation(client, ctx, 'order.createPickup', 'sale_item', saleItemId, {
      _v: 3,
      pickupQuantity,
      clientUserId,
      storeId: ctx.auth.effectiveStoreId,
      pickedUp: updated.picked_up_quantity,
      total: updated.quantity,
    })
  })

  ctx.result = {
    saleItemId,
    pickedUp: updated.picked_up_quantity,
    total: updated.quantity,
    remaining: updated.quantity - updated.picked_up_quantity,
    message: '取货成功',
  }
}


async function availablePickupItems(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId } = ctx.event.payload || {}
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')

  const rows = await pg.query(
    `SELECT si.sale_item_id,
            si.sale_order_id,
            si.product_name,
            si.product_name AS spec_name,
            si.quantity,
            COALESCE(si.picked_up_quantity, 0) AS picked_up_quantity,
            si.unit_real_price,
            o.store_id,
            o.paid_at,
            s.store_name
       FROM sale_items si
 INNER JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
  LEFT JOIN stores s ON s.store_id = o.store_id
      WHERE o.client_user_id = $1
        AND o.status = '已支付'
        AND si.item_direction = '购买'
        AND si.product_type = '家居产品'
        AND si.quantity > COALESCE(si.picked_up_quantity, 0)
   ORDER BY o.paid_at DESC, si.sale_item_id`,
    [clientUserId],
  )

  ctx.result = rows.map((r) => ({
    saleItemId: r.sale_item_id,
    saleOrderId: r.sale_order_id,
    productName: r.product_name || null,
    specName: r.spec_name || null,
    quantity: Number(r.quantity),
    pickedUpQuantity: Number(r.picked_up_quantity || 0),
    remaining: Number(r.quantity) - Number(r.picked_up_quantity || 0),
    unitRealPrice: r.unit_real_price ?? '0',
    storeId: r.store_id,
    storeName: r.store_name || null,
    paidAt: r.paid_at,
  }))
}


async function pickupRecordsList(ctx) {
  await requireManager()(ctx, async () => {})

  const {
    page = 1,
    pageSize = 20,
    storeId,
    startDate,
    endDate,
    clientUserId,
  } = ctx.event.payload || {}

  const limit = Math.max(1, Math.min(50, parseInt(pageSize, 10) || 20))
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit

  const conditions = []
  const params = []
  let idx = 1

  const scopeIds = ctx.auth.scopeStoreIds || []
  if (scopeIds.length === 0) {
    ctx.result = { items: [], total: 0, page: 1, pageSize: limit }
    return ctx.result
  }
  conditions.push(`pr.store_id = ANY($${idx}::text[])`)
  params.push(scopeIds)
  idx++

  if (storeId) {
    conditions.push(`pr.store_id = $${idx}`)
    params.push(storeId)
    idx++
  }
  if (clientUserId) {
    conditions.push(`pr.client_user_id = $${idx}`)
    params.push(clientUserId)
    idx++
  }
  if (startDate) {
    conditions.push(`pr.created_at >= $${idx}`)
    params.push(startDate)
    idx++
  }
  if (endDate) {
    conditions.push(`pr.created_at <= ($${idx}::date + INTERVAL '1 day')`)
    params.push(endDate)
    idx++
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const dataSql = `
    SELECT pr.id,
           pr.sale_item_id,
           pr.pickup_quantity,
           pr.store_id,
           pr.client_user_id,
           pr.confirmed_by,
           pr.remark,
           pr.created_at,
           s.store_name,
           cw.name AS client_name,
           cw.phone AS client_phone,
           sw.name AS confirmed_by_name,
           si.product_name,
           si.product_name AS spec_name,
           si.quantity AS item_quantity,
           si.picked_up_quantity AS item_picked_up_quantity,
           si.sale_order_id
      FROM pickup_records pr
 LEFT JOIN stores s ON s.store_id = pr.store_id
 LEFT JOIN client_wechat_users cw ON cw.user_id = pr.client_user_id
 LEFT JOIN staff_wechat_users sw ON sw.employee_id = pr.confirmed_by
 LEFT JOIN sale_items si ON si.sale_item_id = pr.sale_item_id
       ${whereSql}
  ORDER BY pr.created_at DESC
     LIMIT ${limit} OFFSET ${offset}
  `
  const countSql = `SELECT COUNT(*)::int AS cnt FROM pickup_records pr ${whereSql}`

  const [rows, countRow] = await Promise.all([
    pg.query(dataSql, params),
    pg.query(countSql, params),
  ])

  ctx.result = {
    items: rows.map((r) => ({
      id: r.id,
      saleItemId: r.sale_item_id,
      pickupQuantity: r.pickup_quantity,
      storeId: r.store_id,
      storeName: r.store_name || null,
      clientUserId: r.client_user_id,
      clientName: r.client_name || null,
      clientPhone: r.client_phone || null,
      confirmedBy: r.confirmed_by,
      confirmedByName: r.confirmed_by_name || null,
      remark: r.remark,
      createdAt: r.created_at,
      productName: r.product_name || null,
      specName: r.spec_name || null,
      itemQuantity: r.item_quantity == null ? null : Number(r.item_quantity),
      itemPickedUpQuantity:
        r.item_picked_up_quantity == null ? null : Number(r.item_picked_up_quantity),
      saleOrderId: r.sale_order_id || null,
    })),
    total: countRow[0]?.cnt ?? 0,
    page: Math.max(1, parseInt(page, 10) || 1),
    pageSize: limit,
  }
  return ctx.result
}




async function generateOrderNo(prefix, client) {
  if (!client) {
    throw new Error('generateOrderNo: client is required (must be called inside an outer transaction)')
  }
  if (!prefix) prefix = 'FY-XSD-WX-'
  
  const today = new Date()
  const dateStr = shanghaiYYMMDD(today)
  const likePattern = `${prefix}${dateStr}%`

  
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
}


async function refundList(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { status, page = 1, pageSize = 20 } = ctx.event.payload || {}
  const offset = (page - 1) * pageSize

  const params = [ctx.auth.effectiveStoreId, pageSize, offset]
  let whereExtra = ''
  if (status) {
    params.push(status)
    whereExtra += ` AND sop.status = $${params.length}`
  }
  if (!ctx.auth.roles.includes('manager')) {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND sop.operator_employee_id = $${params.length}`
  }

  const refunds = await pg.query(`
    SELECT
      sop.id AS payment_id,
      sop.sale_order_id AS ref_sale_order_id,
      sop.amount, sop.status, sop.payment_method,
      sop.created_at, sop.paid_at,
      so.client_phone, so.customer_name, so.sale_order_type,
      sop.refund_reason, sop.audit_remark,
      sop.operator_employee_id AS opened_by,
      sop.audit_employee_id AS approved_by,
      sop.audit_at AS approved_at,
      sop.note AS detail_note,
      opener.name AS opened_by_name,
      approver.name AS approved_by_name
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
    LEFT JOIN staff_wechat_users opener ON sop.operator_employee_id = opener.employee_id
    LEFT JOIN staff_wechat_users approver ON sop.audit_employee_id = approver.employee_id
    WHERE so.store_id = $1 AND sop.change_type = '退款'
    ${whereExtra}
    ORDER BY sop.created_at DESC
    LIMIT $2 OFFSET $3
  `, params)

  ctx.result = { refunds, page, pageSize }
}


async function refundDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { paymentId, saleOrderId } = ctx.event.payload || {}
  
  const queryPaymentId = paymentId || (typeof saleOrderId === 'number' ? saleOrderId : null)
  if (!queryPaymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  const sopRows = await pg.query(
    `SELECT
       sop.id AS payment_id, sop.sale_order_id, sop.amount, sop.status,
       sop.payment_method, sop.change_type, sop.created_at, sop.paid_at,
       so.store_id, so.client_user_id, so.client_phone, so.customer_name, so.sale_order_type,
       so.total_amount AS orig_total_amount, so.received AS orig_received,
       so.prepaid_card_amount AS orig_prepaid, so.payment_method AS orig_payment_method,
       so.sale_order_datetime,
       sop.operator_employee_id, sop.refund_reason, sop.ref_sale_item_id,
       sop.session_count, sop.note AS detail_note,
       sop.audit_employee_id, sop.audit_at, sop.audit_remark,
       opener.name AS opened_by_name,
       approver.name AS approved_by_name
     FROM sale_order_payments sop
     JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
     LEFT JOIN staff_wechat_users opener ON sop.operator_employee_id = opener.employee_id
     LEFT JOIN staff_wechat_users approver ON sop.audit_employee_id = approver.employee_id
     WHERE sop.id = $1 AND sop.change_type = '退款'`,
    [queryPaymentId]
  )
  if (sopRows.length === 0) throw new Error('NOT_FOUND: 退款流水不存在')
  const r = sopRows[0]

  
  if (r.store_id !== ctx.auth.effectiveStoreId) {
    throw new Error('PERMISSION_DENIED: 无权查看该退款')
  }
  
  if (!ctx.auth.roles.includes('manager') && r.operator_employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权查看该退款')
  }

  
  let detail = null
  if (r.detail_note) {
    try {
      detail = typeof r.detail_note === 'string' ? JSON.parse(r.detail_note) : r.detail_note
    } catch (_) { detail = null }
  }

  
  
  const noteItems = detail && Array.isArray(detail.items) ? detail.items : []
  const itemIds = noteItems.map(it => it.refSaleItemId).filter(Boolean)
  const nameMap = {}
  if (itemIds.length > 0) {
    const siRows = await pg.query(
      `SELECT sale_item_id, product_name, product_name AS spec_name, product_type
         FROM sale_items WHERE sale_item_id = ANY($1)`,
      [itemIds]
    )
    for (const si of siRows) {
      nameMap[si.sale_item_id] = si
    }
  }
  const refundItems = noteItems.map(it => {
    const si = nameMap[it.refSaleItemId] || {}
    return {
      saleItemId: it.refSaleItemId,
      productName: si.product_name || null,
      specName: si.spec_name || null,
      productType: it.productType || si.product_type || null,
      quantity: it.quantity,
      refundAmount: it.refundAmount,
    }
  })

  ctx.result = {
    payment: {
      paymentId: r.payment_id,
      saleOrderId: r.sale_order_id,
      amount: Number(r.amount),
      status: r.status,
      paymentMethod: r.payment_method,
      changeType: r.change_type,
      saleOrderType: r.sale_order_type,
      createdAt: r.created_at,
      paidAt: r.paid_at,
    },
    detail: {
      refundReason: r.refund_reason,
      refSaleItemId: r.ref_sale_item_id,
      sessionCount: r.session_count,
      operatorEmployeeId: r.operator_employee_id,
      operatorName: r.opened_by_name,
      auditEmployeeId: r.audit_employee_id,
      auditName: r.approved_by_name,
      auditAt: r.audit_at,
      auditRemark: r.audit_remark,
      noteJson: detail,
    },
    origOrder: {
      saleOrderId: r.sale_order_id,
      totalAmount: Number(r.orig_total_amount),
      received: Number(r.orig_received || 0),
      prepaidCardAmount: Number(r.orig_prepaid || 0),
      paymentMethod: r.orig_payment_method,
      saleOrderDatetime: r.sale_order_datetime,
      clientPhone: r.client_phone,
      customerName: r.customer_name,
    },
    refundItems,
  }
}




async function createDeposit(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const {
    clientUserId,
    items,
    remark,
    couponId,
    prepaidCardAmount,
    useCard,
  } = payload
  const storeId = ctx.auth.effectiveStoreId
  
  const marketName = ctx.auth.marketName || ''

  if (!clientUserId) throw new Error('INVALID_PARAMS: 寄存单必须指定顾客 clientUserId')
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('INVALID_PARAMS: 寄存单至少需要 1 个商品')
  }
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  
  if (couponId) {
    throw new Error('INVALID_STATE: DEPOSIT_NO_DISCOUNT: 寄存单不允许使用优惠券')
  }
  if (prepaidCardAmount || useCard) {
    throw new Error('INVALID_STATE: DEPOSIT_NO_DISCOUNT: 寄存单不允许使用储值卡')
  }
  const hasCustomPrice = items.some(
    it => it && (it.customPrice !== undefined && it.customPrice !== null)
  )
  if (hasCustomPrice) {
    throw new Error('INVALID_STATE: DEPOSIT_NO_DISCOUNT: 寄存单不允许手工改价')
  }
  const hasDiscount = items.some(it => it && Number(it.discount) > 0)
  if (hasDiscount) {
    throw new Error('INVALID_STATE: DEPOSIT_NO_DISCOUNT: 寄存单不允许行级优惠')
  }

  
  
  const clientRows = await pg.query(
    `SELECT user_id, phone, name, customer_type, bound_store_id
     FROM client_wechat_users WHERE user_id = $1 LIMIT 1`,
    [clientUserId]
  )
  if (clientRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const client = clientRows[0]
  if (!client.bound_store_id) {
    throw new Error('CLIENT_NOT_REGISTERED: 顾客未绑定门店')
  }
  
  if (!isStoreInScope(ctx.auth, client.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法开单')
  }

  
  const itemDataList = await Promise.all(items.map(async (item) => {
    if (!item || !item.skuId) {
      throw new Error('INVALID_PARAMS: items 缺少 skuId')
    }
    const skuRows = await pg.query(
      `SELECT s.sku_id, s.product_type, s.spec_name, s.price, s.special_price, s.session_count,
              s.service_fee, s.is_shengmei, s.is_experience,
              pc.sales_category, pc.product_kind
       FROM product_skus s
       JOIN product_categories pc ON s.category_id = pc.category_id
       WHERE s.sku_id = $1 AND s.deleted_at IS NULL`,
      [item.skuId]
    )
    if (skuRows.length === 0) {
      throw new Error(`INVALID_PARAMS: 商品 ${item.skuId} 不存在`)
    }
    const sku = skuRows[0]
    
    const quantity = Number(item.quantity) || 1
    if (quantity <= 0) {
      throw new Error('INVALID_PARAMS: quantity 必须为正')
    }
    
    const itemReceived = item.received != null ? Math.round((Number(item.received) || 0) * 100) / 100 : 0
    if (!Number.isFinite(itemReceived) || itemReceived < 0) {
      throw new Error('INVALID_PARAMS: received 必须为非负数')
    }
    
    const basePrice = Number(sku.special_price || sku.price)
    
    const sessionCount = sku.session_count != null
      ? Number(sku.session_count) * quantity
      : null
    const saleAmount = Math.round(basePrice * quantity * 100) / 100
    
    const denom = (sessionCount != null && sessionCount > 0) ? sessionCount : quantity
    const perSessionUnit = denom > 0 ? Math.round((saleAmount / denom) * 100) / 100 : saleAmount
    return {
      skuId: item.skuId,
      productName: sku.spec_name,
      productType: sku.product_type,
      productKind: sku.product_kind,
      sessionCount,
      remainingSessions: sessionCount,
      unitPrice: perSessionUnit,
      unitRealPrice: perSessionUnit,
      quantity,
      saleAmount,
      received: itemReceived,
      salesCategory: sku.sales_category || null,
      serviceFee: 0,
      isShengmei: sku.is_shengmei ?? null,
      isExperience: sku.is_experience === true,
    }
  }))

  const now = new Date()
  let saleOrderId

  await pg.transaction(async (tx) => {
    
    saleOrderId = await generateOrderNo('FY-XSD-WX-', tx)

    
    const documentType = '售后'

    
    await tx.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, total_amount, client_user_id, client_phone, customer_name,
        payment_method, opened_by,
        preferred_employee_id, coupon_id, coupon_discount, remark,
        prepaid_card_amount, received, payable_amount, paid_at,
        allocation_status, created_at, updated_at
      ) VALUES ($1, '已支付', '寄存单', $2, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $4), $3), $4, (SELECT store_name FROM stores WHERE store_id = $4), $5, 0, $6, $7, $8, '无', $9,
                NULL, NULL, 0, $10, 0, 0, 0, $5,
                '待分配', $5, $5)`,
      [
        saleOrderId, documentType, marketName, storeId, now,
        clientUserId, client.phone || null, client.name || null,
        ctx.auth.staffWfId,
        remark || null,
      ]
    )

    
    const dateStr = shanghaiYMD(now)
    const maxResult = await tx.query(
      `SELECT sale_item_id FROM sale_items
       WHERE sale_item_id LIKE $1
       ORDER BY sale_item_id DESC LIMIT 1`,
      [`XSLSH-WX-${dateStr}%`]
    )
    let seq = 1
    if (maxResult.rows.length > 0) {
      seq = parseInt(maxResult.rows[0].sale_item_id.slice(-4)) + 1
    }

    
    
    const receiptRows = []
    for (let i = 0; i < itemDataList.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemDataList[i]
      const sc = d.productType === '家居产品' ? null : d.sessionCount
      const rs = d.productType === '家居产品' ? null : d.remainingSessions
      if (d.received > 0) receiptRows.push({ saleItemId, received: d.received })

      await tx.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction, sku_id,
          product_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee, is_shengmei, is_experience
        ) VALUES ($1, $2, $3, '购买', $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, 0, $14, $15)`,
        [
          saleItemId, saleOrderId, storeId, d.skuId,
          d.productName, d.productType,
          sc, rs,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount,
          d.salesCategory,
          d.isShengmei ?? null,
          d.isExperience,
        ]
      )
    }

    
    
    
    
    if (receiptRows.length > 0) {
      for (const r of receiptRows) {
        await tx.query(
          `INSERT INTO sale_order_payments (
            sale_order_id, change_type, amount, payment_method, external_txn_id,
            status, source_end, operator_employee_id, ref_sale_item_id, note, created_at, paid_at
          ) VALUES ($1, '回款', $2, '线下', NULL, '已支付', 'staff', $3, $4, $5, $6, $6)`,
          [saleOrderId, r.received, ctx.auth.staffWfId, r.saleItemId, DEPOSIT_RECEIPT_NOTE, now]
        )
      }
      const totalReceived = receiptRows.reduce((s, r) => s + r.received, 0)
      await tx.query(
        `UPDATE sale_orders SET received = $1, updated_at = NOW() WHERE sale_order_id = $2`,
        [totalReceived, saleOrderId]
      )
    }

    
    
    
    await recalcPaidSessionsForOrder(tx, saleOrderId)

    
    
    await tx.query(DEPOSIT_REAL_PRICE_RECALC_SQL, [saleOrderId])

    
    await logOperation(tx, ctx, 'order.createDeposit', 'sale_order', saleOrderId, {
      _v: 3,
      clientUserId,
      itemCount: itemDataList.length,
      totalSessionCount: itemDataList.reduce(
        (acc, it) => acc + (it.sessionCount != null ? it.sessionCount : 0),
        0
      ),
    })
  })

  ctx.result = {
    saleOrderId,
    status: '已支付',
    itemCount: itemDataList.length,
    message: '寄存单已创建',
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
  createDeposit,
  availablePickupItems,
  pickupRecordsList,
}
