/**
 * 充值卡模块路由（员工端 / 店长替顾客充值）
 *
 * 独立充值流程：不走通用 order.create，脱离购物车 3 步弹层。
 *
 * 两种档位来源：
 *   A) 真实 product_kind='充值卡' 的 SKU（卡面值 = product_skus.price）
 *   B) 自定义金额 → 虚拟 SKU 'sku-recharge-virtual'（面值 = 用户输入，实付走 matchTier）
 *
 * 入账：线下走 order.confirmOffline 识别段，微信走 clientApi payNotify 识别段。
 * 两侧识别逻辑均以 "sale_items → product_skus → product_categories 且 product_kind='充值卡'" 为统一过滤，
 * 面值按 (虚拟 SKU → product_name 正则解析) / (真实 SKU → product_skus.price) 分支取值。
 */

const pg = require('../db/pg')
const { requireManager } = require('../middleware/auth')
const {
  RECHARGE_TIERS,
  RECHARGE_MIN_AMOUNT,
  RECHARGE_MAX_AMOUNT,
  RECHARGE_VIRTUAL_SKU_ID,
  matchTier,
} = require('../utils/recharge')

// ================= 路由 =================

/**
 * 返回店长可售的充值卡档位 + 自定义金额配置
 *
 * tiers 来自 product_skus（product_kind='充值卡'），price=面值，special_price=实付。
 * customConfig 提供前端即时校验所需的边界 + tier 断点。
 */
async function rechargeSkus(ctx) {
  await requireManager()(ctx, async () => {})

  const rows = await pg.query(`
    SELECT sk.sku_id, sk.spec_name, sk.price, sk.special_price, sk.sort_order, sk.product_type,
           pc.category_id, pc.category_name
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    WHERE pc.product_kind = '充值卡'
      AND sk.is_enabled = true
      AND pc.is_valid = true
      AND sk.sku_id <> $1
    ORDER BY sk.price ASC, sk.sort_order ASC
  `, [RECHARGE_VIRTUAL_SKU_ID])

  const tiers = rows.map(r => {
    const price = Number(r.price)
    const payAmount = r.special_price != null ? Number(r.special_price) : price
    const bonus = Math.round((price - payAmount) * 100) / 100
    const discount = price > 0 ? Math.round((payAmount / price) * 100) / 100 : 1
    return {
      skuId: r.sku_id,
      productName: r.spec_name,
      specName: r.spec_name,
      faceValue: price,
      payAmount,
      bonus,
      discount,
      productType: r.product_type,
      categoryId: r.category_id,
      categoryName: r.category_name,
    }
  })

  ctx.result = {
    tiers,
    customConfig: {
      minAmount: RECHARGE_MIN_AMOUNT,
      maxAmount: RECHARGE_MAX_AMOUNT,
      tierBreakpoints: RECHARGE_TIERS.map(t => ({
        faceValue: t.faceValue,
        discount: t.discount,
        payAmount: Math.round(t.faceValue * t.discount * 100) / 100,
      })),
    },
  }
}

/**
 * 店长替顾客开充值卡订单
 *
 * payload: {
 *   clientUserId: string,              // 必填，已注册顾客 user_id
 *   skuId?: string,                    // 档位 SKU（与 customAmount 互斥）
 *   customAmount?: number,             // 自定义金额（与 skuId 互斥）
 *   paymentMethod: '线下'|'微信',
 *   remark?: string
 * }
 *
 * 返回: { saleOrderId, saleItemId, skuId, faceValue, payAmount, paymentMethod, status }
 */
async function recharge(ctx) {
  await requireManager()(ctx, async () => {})

  const payload = ctx.event.payload || {}
  const { clientUserId, skuId, customAmount, paymentMethod, remark } = payload

  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')
  if (!paymentMethod) throw new Error('INVALID_PARAMS: 缺少 paymentMethod')
  if (!['线下', '微信'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式')
  }

  const hasSkuId = !!skuId
  const hasCustomAmount = customAmount !== undefined && customAmount !== null && customAmount !== ''
  if (!hasSkuId && !hasCustomAmount) {
    throw new Error('INVALID_PARAMS: 请选择档位或输入自定义金额')
  }
  if (hasSkuId && hasCustomAmount) {
    throw new Error('INVALID_PARAMS: skuId 与 customAmount 只能二选一')
  }

  const storeId = ctx.auth.storeId
  const marketName = ctx.auth.marketName || ''
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  // 解析档位 → {resolvedSkuId, productName, skuSpecName, productType, salesCategory, faceValue, payAmount}
  let resolvedSkuId
  let productName
  let skuSpecName
  let productType
  let salesCategory = null
  let faceValue
  let payAmount

  if (hasSkuId) {
    if (skuId === RECHARGE_VIRTUAL_SKU_ID) {
      // 显式传虚拟 SKU 但未给 customAmount —— 拒绝（避免面值零订单）
      throw new Error('INVALID_PARAMS: 虚拟 SKU 需通过 customAmount 下单')
    }
    const skuRows = await pg.query(`
      SELECT sk.sku_id, sk.spec_name, sk.price, sk.special_price, sk.product_type,
             pc.product_kind, pc.sales_category
      FROM product_skus sk
      JOIN product_categories pc ON sk.category_id = pc.category_id
      WHERE sk.sku_id = $1 AND sk.is_enabled = true
    `, [skuId])
    if (skuRows.length === 0) throw new Error('INVALID_PARAMS: SKU 不存在或已下架')
    const sku = skuRows[0]
    if (sku.product_kind !== '充值卡') throw new Error('INVALID_PARAMS: 该 SKU 不是充值卡')
    resolvedSkuId = skuId
    productName = sku.spec_name
    skuSpecName = sku.spec_name
    productType = sku.product_type
    salesCategory = sku.sales_category || null
    faceValue = Number(sku.price)
    payAmount = sku.special_price != null ? Number(sku.special_price) : faceValue
  } else {
    const amt = Number(customAmount)
    const { payAmount: computed } = matchTier(amt)
    resolvedSkuId = RECHARGE_VIRTUAL_SKU_ID
    // product_name 必须含 "¥{面值}"，payNotify / confirmOffline 依赖正则解析
    productName = `预付充值卡 ¥${amt}`
    skuSpecName = '预付充值卡（虚拟）'
    productType = '院装产品'
    faceValue = amt
    payAmount = computed
  }

  if (!(faceValue > 0)) throw new Error('INVALID_PARAMS: 充值卡面值异常')

  // 查顾客 + document_type
  const userRows = await pg.query(
    `SELECT user_id, phone, name, customer_type FROM client_wechat_users WHERE user_id = $1`,
    [clientUserId]
  )
  if (userRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const user = userRows[0]
  const clientPhone = user.phone || null
  const customerName = user.name || null
  const documentType = user.customer_type === '会员客' ? '售后' : '售前'

  // 并发守卫：同顾客不能有另一笔待支付订单（uq_sale_orders_client_pending 也会兜底）
  const pendingRows = await pg.query(
    `SELECT sale_order_id FROM sale_orders
     WHERE client_user_id = $1 AND status = '待支付' LIMIT 1`,
    [clientUserId]
  )
  if (pendingRows.length > 0) {
    const err = new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
    err.data = { pendingOrderNo: pendingRows[0].sale_order_id }
    throw err
  }

  // 事务内：advisory lock + 生成订单号/流水号 + INSERT
  let saleOrderId
  let saleItemId
  await pg.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sale_order_id_gen'])

    const now = new Date()
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
    saleOrderId = `FY-XSD-WX-${dateStrOrder}${String(orderSeq).padStart(4, '0')}`

    const dateStrItem = now.toISOString().slice(0, 10).replace(/-/g, '')
    const itemSeqResult = await client.query(
      `SELECT sale_item_id FROM sale_items
       WHERE sale_item_id LIKE $1
       ORDER BY sale_item_id DESC LIMIT 1`,
      [`XSLSH-WX-${dateStrItem}%`]
    )
    let itemSeq = 1
    if (itemSeqResult.rows.length > 0) {
      itemSeq = parseInt(itemSeqResult.rows[0].sale_item_id.slice(-4)) + 1
    }
    saleItemId = `XSLSH-WX-${dateStrItem}${String(itemSeq).padStart(4, '0')}`

    // 线下 → 待确认收款；微信 → 待支付（等 payNotify 回调入账）
    const initialStatus = paymentMethod === '线下' ? '待确认收款' : '待支付'

    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id,
        sale_order_datetime, total_amount, client_user_id, client_phone, customer_name,
        payment_method, opened_by, remark,
        created_at, updated_at
      ) VALUES ($1, $2, '销售单', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $6, $6)`,
      [
        saleOrderId, initialStatus, documentType, marketName, storeId, now,
        payAmount, clientUserId, clientPhone, customerName,
        paymentMethod, ctx.auth.staffWfId, remark || null,
      ]
    )

    await client.query(
      `INSERT INTO sale_items (
        sale_item_id, sale_order_id, store_id, item_direction, sku_id,
        product_name, sku_spec_name, product_type,
        session_count, remaining_sessions,
        unit_price, quantity, unit_real_price, sale_amount, received,
        sales_category, service_fee
      ) VALUES ($1, $2, $3, '购买', $4, $5, $6, $7, NULL, NULL, $8, 1, $9, $9, $9, $10, 0)`,
      [
        saleItemId, saleOrderId, storeId, resolvedSkuId,
        productName, skuSpecName, productType,
        faceValue, payAmount,
        salesCategory,
      ]
    )
  })

  ctx.result = {
    saleOrderId,
    saleItemId,
    skuId: resolvedSkuId,
    faceValue,
    payAmount,
    paymentMethod,
    status: paymentMethod === '线下' ? '待确认收款' : '待支付',
    message: '开单成功',
  }
}

module.exports = { rechargeSkus, recharge }
