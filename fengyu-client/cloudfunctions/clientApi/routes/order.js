/**
 * 订单模块路由
 * 客户端订单相关接口
 */

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

/**
 * 解析门店的拉卡拉商户号 + 终端号
 *
 * 一店一商户、一店一终端，env 不留默认；支付失败就让失败，不兜底。
 * 收款配置已收敛到 lakala_merchants（一店一商户，N:1），门店经 stores.lakala_merchant_id 关联：
 * - 门店未关联商户 / lakala_merchants.enabled=false / merchant_no 为空 → 返回 null（上层报 LAKALA_NOT_CONFIGURED）
 * - term_no 为空（聚合主扫 term_no 必填 M）→ 抛 LAKALA_TERM_NO_MISSING 引导运维补配置
 */
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

/**
 * 提取客户端 IP（拉卡拉风控字段 location_info.request_ip 必送）。
 * CloudBase 云函数走 cloud.getWXContext().CLIENTIP；某些 callFunction 调用下可能为空，兜底 '0.0.0.0'。
 */
function getRequestIp() {
  try {
    const ctx = cloud.getWXContext() || {}
    return ctx.CLIENTIP || '0.0.0.0'
  } catch {
    return '0.0.0.0'
  }
}

/**
 * 调聚合主扫 preorder 拿到支付参数。
 *
 * out_trade_no = `${orderNo}_${unixSec}`（30 字符 ≤ 32 上限），同一 saleOrderId 多次发起支付会生成不同号。
 * payNotify 收到回调时按 `replace(/_\d+$/, '')` 剥离后缀得 saleOrderId（仍兼容旧规则）。
 *
 * @returns {Promise<{
 *   outTradeNo: string, tradeNo: string,
 *   paymentParams?: object,     // 微信小程序：wx.requestPayment 5 字段
 *   alipayQrUrl?: string,       // 支付宝 NATIVE：二维码 URL（喂给 share_code）
 * }>}
 */
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

  // 微信通道：校验拉卡拉返回的 app_id 与我方 subAppid 一致（防止拉卡拉商户绑定错误导致用户支付到别人账户）
  if (accountType === 'WECHAT' && transType === '71') {
    if (subAppid && resp.lakalaAppId && resp.lakalaAppId !== subAppid) {
      throw new Error(`INVALID_STATE: LAKALA_APPID_MISMATCH: 拉卡拉返回 app_id=${resp.lakalaAppId} 与 sub_appid=${subAppid} 不一致`)
    }
  }

  // 持久化本次商户流水号（聚合主扫的 out_trade_no），供后续 queryLakalaStatus 兜底查询。
  // CAS-EXEMPT：仅写 lakala_out_order_no（列名沿用，语义为"最近一次发起 preorder 的 out_trade_no"），不翻 status。
  // 同时刷新 updated_at，让 payNotify.runPaymentReconcile 定时补偿窗口能锚定"最近一次发起拉卡拉支付"
  // （sale_order_datetime 是下单时间不随回款变化，回款会覆写 lakala_out_order_no；updated_at 才能反映）。
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

/**
 * 调拉卡拉「申请支付宝吱口令」拿到 share_token，前端展示给用户复制后切到支付宝识别。
 *
 * 用同一笔 outTradeNo + 同金额（必须先调 preorder 走过流水落账后再调 share_code）。
 *
 * @returns {Promise<{ shareToken: string, expireDate: string, tradeNo: string }>}
 */
async function createLakalaAlipayShareCode({
  orderNo, merchantNo, termNo,
  payAmountYuan, requestIp, bizLink,
  outTradeNo,  // 与 preorder 同一笔 outTradeNo
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

/**
 * 关闭过期订单并释放关联优惠券（原子操作）。
 *
 * 仅关闭「顾客自助下单」(opened_by IS NULL) 的过期订单。员工开单订单
 * (opened_by IS NOT NULL) 由 admin/staff 生成二维码交顾客扫码支付，扫码时刻
 * 往往已超过 10 分钟，不应被自助下单的懒清理误关（issue #27）。
 *
 * @param {string} orderNo - 订单号
 * @returns {Promise<boolean>} true=确实关闭并释放了券；false=未命中（非待支付/员工单/不存在）
 */
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

/**
 * 批量关闭用户过期订单并释放优惠券
 * @param {string} userId - 用户ID
 */
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

/**
 * 组合套餐校验 + 定价 map
 *
 * 仅当 order.create payload 含 bundleProductId 时调用：
 *   - 校验该 productId 存在且 is_bundle = true
 *   - 校验每个 mall_bundle_groups 的配额：选 N 项（pick_count != null）按"数量合计 = pick_count"
 *     （同一 SKU 可选多件，与员工端口径一致，故 4 个商品可凑出"4 选 8"）；
 *     全选（pick_count IS NULL）按"SKU 种类数 = 组内 SKU 总数"
 *   - 校验所有 items.skuId 都属于该 bundle（mall_product_skus.product_id 等值）
 *
 * 返回 Map<skuId, {listPrice, salePrice}>；调用方据此把 unit_price 切到 bundle_list_price（标价划线）、
 * unit_real_price 切到 bundle_price（成交价=组会员价 ?? 标价）。bundleProductId 为空返回 null（普通商品路径）。
 */
async function _loadAndValidateBundle(bundleProductId, items) {
  if (!bundleProductId) return null

  // 1. 校验商品是套餐
  const productRows = await pg.query(
    `SELECT product_id, is_bundle FROM products
     WHERE product_id = $1 AND deleted_at IS NULL AND is_visible = true`,
    [bundleProductId]
  )
  if (productRows.length === 0 || !productRows[0].is_bundle) {
    throw new Error('INVALID_PARAMS: BUNDLE_NOT_FOUND: 套餐不存在或已下架')
  }

  // 2. 取分组定义
  const groupRows = await pg.query(
    `SELECT id, group_name, pick_count
     FROM mall_bundle_groups WHERE product_id = $1`,
    [bundleProductId]
  )
  // 3. 取套餐 SKU 关联（含 bundle_price + group_id）
  const mpsRows = await pg.query(
    `SELECT sku_id, bundle_group_id, bundle_price, bundle_list_price
     FROM mall_product_skus WHERE product_id = $1`,
    [bundleProductId]
  )

  // 构建 sku→{标价单价, 成交价} / group_id 索引（下沉副本）
  const skuToBundlePrice = new Map()
  const skuToGroupId = new Map()
  for (const r of mpsRows) {
    skuToBundlePrice.set(r.sku_id, { listPrice: r.bundle_list_price, salePrice: r.bundle_price })
    skuToGroupId.set(r.sku_id, r.bundle_group_id != null ? Number(r.bundle_group_id) : null)
  }

  // 4. 校验所有 items.skuId 都属于该 bundle
  for (const item of items) {
    if (!skuToBundlePrice.has(item.skuId)) {
      throw new Error(`INVALID_PARAMS: BUNDLE_SKU_NOT_BELONG: SKU ${item.skuId} 不属于该套餐`)
    }
  }

  // 5. 按 group_id 统计 items + 校验配额
  //    pick_count != null（选 N 项）：按"数量合计"校验（同一 SKU 可选多件，员工端口径），
  //                                   故 4 个候选商品可凑出"4 选 8"等数量。
  //    pick_count IS NULL（全选）：按"种类数"校验，每个 SKU 必须都在（数量恒 1）。
  const pickedQtyByGroup = new Map()  // groupId → Σ quantity（选 N 项用）
  const pickedSkusByGroup = new Map() // groupId → Set<skuId>（全选组用）
  for (const item of items) {
    const gid = skuToGroupId.get(item.skuId)
    if (gid == null) continue // 未分组 SKU，直接通过（mall_product_skus.bundle_group_id 为 NULL 的 SKU）
    const qty = Number(item.quantity) || 0
    pickedQtyByGroup.set(gid, (pickedQtyByGroup.get(gid) || 0) + qty)
    if (!pickedSkusByGroup.has(gid)) pickedSkusByGroup.set(gid, new Set())
    pickedSkusByGroup.get(gid).add(item.skuId)
  }

  // 每组 SKU 总数（pick_count IS NULL 时校验"全选"用）
  const totalSkusByGroup = new Map()
  for (const r of mpsRows) {
    if (r.bundle_group_id == null) continue
    const gid = Number(r.bundle_group_id)
    totalSkusByGroup.set(gid, (totalSkusByGroup.get(gid) || 0) + 1)
  }

  for (const g of groupRows) {
    const gid = Number(g.id)
    if (g.pick_count == null) {
      // 全选组：勾选的 SKU 种类数必须等于该组 SKU 总数
      const total = totalSkusByGroup.get(gid) || 0
      const distinct = pickedSkusByGroup.has(gid) ? pickedSkusByGroup.get(gid).size : 0
      if (distinct !== total) {
        throw new Error(`INVALID_PARAMS: BUNDLE_GROUP_PICK_MISMATCH: 组「${g.group_name}」需全选 ${total} 项，实际 ${distinct} 项`)
      }
    } else {
      // 选 N 项组：数量合计必须等于 pick_count
      const pickedQty = pickedQtyByGroup.get(gid) || 0
      if (pickedQty !== Number(g.pick_count)) {
        throw new Error(`INVALID_PARAMS: BUNDLE_GROUP_PICK_MISMATCH: 组「${g.group_name}」需选 ${g.pick_count} 件，实际 ${pickedQty} 件`)
      }
    }
  }

  return skuToBundlePrice
}

/**
 * 扫码查看订单详情（员工开单订单专用）
 * 不要求 client_user_id 匹配，仅限员工开单（opened_by IS NOT NULL）的订单
 *
 * 2026-04-26 sale-order-domain-refactor + audit-02 P0：
 *   - 字段 paid_amount → received（已到账金额聚合快照）
 *   - 退款不再以独立"退款单"行展示，而是聚合 sale_order_payments[change_type='退款',status='已支付']
 *   - 补 requirePhone() 守卫（audit-02 P0：scanDetail 缺鉴权）
 */
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

  // scanDetail 仅服务员工开单订单（SQL 自带 WHERE opened_by IS NOT NULL），员工单不套用
  // 自助下单的 10 分钟懒清理——closeExpiredOrder 的 opened_by IS NULL 守卫对员工单也总返回
  // false，故此处不再做超时检查（避免死代码）。顾客自助单的懒清理在 order.detail/list 处理。

  // 可支付状态：待支付（首付）/ 部分支付（回款——已有首付到账，扫码付剩余应付）
  // 非可支付状态返回提示
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

  // 查询商品明细（使用 sale_items 快照字段 + 商品封面）
  // 金额展示用 sale_amount（行应付总额，权威；= unit_real_price × quantity，会员价/多次卡都已折算），
  // 不能用 unit_price（非会员原价/单次价）：多次卡 quantity=1 但 session_count>1，unit_price×quantity 算不出行总额。
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

  // 应付实金 = total - prepaid_card_amount（payable_amount 列冗余，兜底现算）
  const totalAmount = Number(order.total_amount || 0)
  const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
  const payableAmount = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmount - prepaidCardAmount) * 100) / 100
  const received = Number(order.received || 0)
  const refundedAmount = Number(order.refunded_amount || 0)
  // 首付金额（admin 在线上分次开单时写入；NULL 表示按剩余应付全额收）
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
      // sale_amount = 行应付总额（权威），前端按此展示；unitPrice/sessionCount 仅供"×N次/单价"辅助提示
      saleAmount: i.sale_amount,
      sessionCount: i.session_count,
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

  const { userId, boundStoreId } = ctx.auth
  const payload = ctx.event.payload

  // 自助下单必须已绑定门店（与 card.recharge 口径一致；前端已拦，此处兜底防 globalData 过期/绕过）
  if (!boundStoreId) {
    throw new Error('INVALID_PARAMS: 请先绑定门店后再下单')
  }

  const {
    storeId,
    items, // [{ skuId, quantity }]
    bundleProductId, // 可选, 组合套餐 productId（service-detail bundle 流）
    preferredStaffWfId, // 可选,指定美容师
    paymentMethod, // '微信' | '线下' | '支付宝'
    orderType: orderTypeParam, // 可选, 'promo' | undefined
    couponId: inputCouponId, // 可选, 优惠券ID
    useCard, // 可选, 是否使用储值卡抵扣
    prepaidCardAmount: inputPrepaidCardAmount // 可选, 前端传的抵扣金额
  } = payload

  // J3 (B9 ticket follow-up): 拒绝数组形式 couponId — 一张订单仅支持 1 张优惠券
  if (Array.isArray(inputCouponId)) {
    throw new Error('INVALID_PARAMS: MULTIPLE_COUPON_NOT_SUPPORTED: 一张订单仅支持 1 张优惠券')
  }

  if (!storeId || !items || !Array.isArray(items) || items.length === 0 || !paymentMethod) {
    throw new Error('INVALID_PARAMS: 参数不完整')
  }

  // 查询门店信息（获取 market_id/market_name 快照，用于优惠券市场范围校验）
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

  // 先清理过期的待支付订单（10分钟超时，同时释放优惠券）
  await closeExpiredOrdersByUser(userId)

  // 检查是否已有自助待支付订单（仅查 opened_by IS NULL 自助单；DB uq 同口径仅兜底自助单，
  // 员工单并发由 staff/admin 端业务守卫 + advisory lock 串行化，不在 clientApi 此检查范围）
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

  // 查询 SKU 信息（product_skus → product_categories 两表 JOIN）
  // 2026-05-20 充值卡剥离 SKU 化：充值不再走 order.create，is_recharge_card 字段已下线
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

  // 构建 SKU 映射
  const skuMap = {}
  for (const sku of skuResults) {
    skuMap[sku.sku_id] = sku
  }

  // 验证所有 SKU 存在
  for (const item of items) {
    if (!skuMap[item.skuId]) {
      throw new Error(`INVALID_PARAMS: 商品 ${item.skuId} 不存在`)
    }
  }

  // 查询顾客姓名 + 会员身份（customer_type + member_level）
  // —— 会员价分流（会员价 vs 标价）与 document_type 判断共用，须在定价前完成。
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

  // ========== 组合套餐校验 + 定价 ==========
  // bundleProductId 出现时：
  // - 校验该商品 is_bundle=true
  // - 校验 items 中每个 skuId 都在 mall_product_skus 里属于该 bundle
  // - 校验每个 mall_bundle_groups 的配额：选 N 项按数量合计 = pick_count，全选按种类数全覆盖
  // - 返回每个 skuId 对应的 bundle_price，下面用作 unit_real_price
  const bundlePriceMap = await _loadAndValidateBundle(bundleProductId, items)

  // 预计算明细数据
  // 浮点 round 兜底（与 staff order.js L446 聚合点 round 对齐；行级 + 累加后双 round）
  // 见 notes/tickets/2026-05-17-client-order-no-coupon-rounding.md
  let totalAmount = 0
  const itemsData = items.map(item => {
    const sku = skuMap[item.skuId]
    // 套餐场景：标价单价/成交价取 mall_product_skus 下沉副本（bundle_list_price / bundle_price）
    const bundleEntry = bundlePriceMap ? bundlePriceMap.get(item.skuId) : null
    // 非套餐单品：按会员身份分流（会员→会员价 special_price、非会员→标价 price；体验卡同口径，#6=B 不再豁免）
    const resolved = resolveUnitPrice(sku, buyerIsMember)
    const listUnit = bundleEntry && bundleEntry.listPrice != null   // per-card 标价（划线）
      ? Number(bundleEntry.listPrice)
      : resolved.listUnit
    const basePrice = bundleEntry && bundleEntry.salePrice != null  // per-card 成交价
      ? Number(bundleEntry.salePrice)
      : resolved.realUnit
    const quantity = item.quantity || 1
    // session_count 是"次"维度（service.complete 按次扣减），应 = sku.session_count × quantity
    const sessionCount = sku.session_count != null ? Number(sku.session_count) * quantity : null
    const saleAmount = Math.round(basePrice * quantity * 100) / 100   // 行应付总额（权威）
    const listTotal = Math.round(listUnit * quantity * 100) / 100     // 行标价总额
    // per-session 派生：卡 = 行总额 / 总次数；非卡 = 行总额 / 数量（即 per-unit，退化）
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
      listUnit,                       // per-card 标价快照（供摊券后 per-session 重派 unit_price 使用）
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

  // 充值卡剥离 SKU 化（2026-05-20）后，order.create 不会有充值卡 SKU 入参，
  // D4 混单守卫已无意义（migration 0043 同步拆触发器）。

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

    // 门店匹配
    if (couponInfo.applicable_store_ids && couponInfo.applicable_store_ids.length > 0) {
      if (!couponInfo.applicable_store_ids.includes(storeId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此门店')
      }
    }

    // 市场匹配（市场必须在 applicable_market_ids 数组内，NULL/空 = 不限制）
    if (couponInfo.applicable_market_ids && couponInfo.applicable_market_ids.length > 0) {
      if (!marketId || !couponInfo.applicable_market_ids.includes(marketId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此市场')
      }
    }

    // 查询 SKU 的 category_id 和 product_id（用于品项/商品维度过滤）
    // product_id 不在 product_skus 表，需 LEFT JOIN mall_product_skus 取（与 staff order.js L520-526 同义）
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

    // eligibleItems 过滤：同时满足 category + product 两个维度（交集）
    // - applicable_category_ids: NULL/空 = 不限制
    // - applicable_product_ids: NULL/空 = 不限制
    // 任意一个维度限制不满足则排除
    let eligibleItems
    if (couponInfo.applicable_category_ids && couponInfo.applicable_category_ids.length > 0) {
      if (couponInfo.applicable_product_ids && couponInfo.applicable_product_ids.length > 0) {
        // 双重限制：同时满足 category AND product
        eligibleItems = itemsData.filter(d =>
          couponInfo.applicable_category_ids.includes(skuCatMap.get(d.skuId)) &&
          couponInfo.applicable_product_ids.includes(skuProductMap.get(d.skuId))
        )
      } else {
        // 仅 category 限制
        eligibleItems = itemsData.filter(d =>
          couponInfo.applicable_category_ids.includes(skuCatMap.get(d.skuId))
        )
      }
    } else if (couponInfo.applicable_product_ids && couponInfo.applicable_product_ids.length > 0) {
      // 仅 product 限制
      eligibleItems = itemsData.filter(d =>
        couponInfo.applicable_product_ids.includes(skuProductMap.get(d.skuId))
      )
    } else {
      // 无限制
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

    // 按 saleAmount 比例摊到各行：saleAmount 是权威源（券摊后行应付总额）
    // received 默认 = saleAmount（顾客端开单即应付=实付，无 inputReceived 概念）
    // 与 staff order.js L576-591 同义；A1 listUnit 字段保留 per-card 标价供 per-session 重派
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

    // per-session 重派 unit_real_price / unit_price（sale_amount 为权威行总额）
    // 卡 = 行总额 / 总次数；非卡 = 行总额 / 数量（per-unit 退化）
    // 与 staff order.js L604-612 同义
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

  // document_type：customer_type 已在定价前判定为初值；此处按订单金额阈值兜底升级为售后
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
  // zeroPayable：应付实金 = 0（券全额抵扣 / 储值卡全额抵扣 / 二者叠加把应付抵到 0）。
  // 这类订单无款可付，创建即结清为 '已支付'，否则会卡在 '待支付' 死循环（0 元发不起线上支付、
  // payment_method='无' 也走不了 confirmOffline）。prepaidFullPaid 是其"含储值卡"的子集。
  let zeroPayable = false
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
        // 浮点容差：39.8 * 100 在 JS 里是 3980.0000000000005，严格 !== 会误判
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
    zeroPayable = paidAmount === 0  // 券全额（prepaidCardAmount=0）也命中，prepaidFullPaid 不命中

    // 生成订单号（在事务+锁内，防并发重复）
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

    // 在事务内查询今日最大序号
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

    // 创建订单主表（全额抵扣时直接 '已支付' + paid_at）
    // 2026-04-26 sale-order-domain-refactor:
    //   - paid_amount 列已 DROP；统一改用 received（已到账金额，初始 0；全额储值卡抵扣时 = prepaidCardAmount）
    //   - payable_amount = total_amount - prepaid_card_amount（应付实金，取代旧 paid_amount 在 create 时的语义）
    //   - 全额抵扣单的 received = prepaidCardAmount（储值卡抵扣等同已收；券全额抵扣 prepaidCardAmount=0 → received=0）
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

    // 原子 claim 优惠券（在事务内防并发重用）
    // 必须在 INSERT sale_orders 之后：used_sale_order_id 有 FK → sale_orders（非 deferrable，立即校验）
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

    // 创建订单明细（流水号递增）
    for (let i = 0; i < itemsData.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemsData[i]
      // 行级 received 开单写 0（资金铁律：received/paid_sessions 只认 status='已支付' 流水），
      // 由下方 recalcPaidSessionsForOrder 从 sale_orders.received 派生（待支付=0；全额抵扣=prepaid 分摊）。
      // 顾客端应付=实付，pending_received 记下单应付（与 admin/staff 三端 INSERT 模式一致）。
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

    // 充值卡剥离 SKU 化后，D4 混单守卫已删除（migration 0043 同步拆触发器）

    // 全额抵扣：同事务扣减 balance + INSERT card_transactions（幂等）+ 写 sale_order_payments[储值卡抵扣]
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
          `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
           VALUES ($1, '扣款', $2, $3, $4)
           ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
          [cardIdForDeduction, -prepaidCardAmount, orderNo, `card-deduct-${orderNo}`]
        )
        // 同事务写 payments 流水：change_type='储值卡抵扣' / status='已支付'
        // 维护不变量 received = SUM(payments WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
        const fullCardPayRes = await client.query(
          `INSERT INTO sale_order_payments (
            sale_order_id, change_type, amount, payment_method,
            external_txn_id, status, source_end, created_at, paid_at
          ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'client', $3, $3)
          RETURNING id`,
          [orderNo, prepaidCardAmount, now]
        )
        // 按回款逐笔分配：全额储值卡抵扣即结清 → 捕获本次抵扣逐项可分配额 + 置回款待分配 + 汇总刷新
        // （client 路径一律「待分配」手动分配，无子项定向，不做自动分配——自动分配仅在 payNotify）
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

    // paid_sessions 初始写入（ticket 2026-05-19）：基于 sale_orders.received + prepaid_card_amount
    // 客户端 create 通常 received=0（待支付，等微信回调），paid_sessions=0 → service.create 时受 D6 限额阻塞
    // 必须在 capture 之后：新 STEP1 从 spai 聚合 received
    await recalcPaidSessionsForOrder(client, orderNo)

    // 零应付单（券/卡全额抵扣）补结算：积分链净额差值法（幂等）+ 会员等级即时重算。
    // 券全额单 received=0 → netSettled=0 → delta=0 → 无积分写入；卡全额单 received=卡额，
    // 与既有 confirmPrepaidFull 口径一致。零应付单永远不会有 payNotify/confirmOffline 来触发结算，
    // 故必须在创建时就地结算（与"所有转已支付的触发点走同一入口"原则一致）。
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
      // 卡全额抵扣保留 'prepaid_card_full'（前端老逻辑判定）；券全额抵扣用 'coupon_full'。
      // 两者前端处理一致（跳详情、不唤起支付），reason 仅供文案/埋点区分。
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

/**
 * 计算订单的"本次应付剩余"
 *
 * 2026-04-26 sale-order-domain-refactor 后：
 *   sale_orders.paid_amount / wechat_transaction_id / alipay_transaction_id 三列已 DROP；
 *   实付汇总改为 sale_orders.received（已到账金额冗余快照），
 *   退款汇总改为 sale_orders.refunded_amount（聚合 sale_order_payments[退款,已支付] 取负）。
 *
 * 对外"剩余应付"语义：
 *   payable_amount = total_amount - prepaid_card_amount
 *   remaining = payable_amount - 已到账金额 + 已退款金额（退款冲销已到账，需要补回欠款）
 *
 * 已到账金额（含储值卡抵扣）= Σ (payments.amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
 * 退款金额（取负）         = Σ (payments.amount WHERE status='已支付' AND change_type='退款')
 *
 * 这里 paidSum 返回净到账（已到账 + 退款），与 received - refunded_amount 等价。
 */
async function calcPaymentRemaining(orderNo, orderRow) {
  const totalAmount = Number(orderRow.total_amount || 0)
  const prepaidCardAmount = Number(orderRow.prepaid_card_amount || 0)
  const payableAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100

  // 净到账 = 首次支付/回款/储值卡抵扣 - 退款（amount<0 自带负号）
  // pg.query 返回 rows 数组（见 db/pg.js），不需要 .rows 解包
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

  // 10分钟超时检查仅对 '待支付' 且顾客自助单(opened_by 为空)生效：
  // 部分支付订单已有首次到账不自动过期；员工单不套用自助超时（closeExpiredOrder 内部跳过，issue #27）
  if (order.status === '待支付') {
    const orderTime = new Date(order.sale_order_datetime)
    if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
      const closed = await closeExpiredOrder(orderNo)
      if (closed) throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
    }
  }

  const now = new Date()

  // 全额储值卡抵扣：payable_amount = 0（total = prepaid_card_amount），订单已在 create 阶段置 '已支付'
  // 此分支属兜底防御——理论上不会进入本函数
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

  // 计算剩余应付 = payable_amount - 净到账（received - refunded_amount）
  const { remaining } = await calcPaymentRemaining(orderNo, order)
  const effectiveRemaining = remaining

  // 校验本次支付金额
  let thisPayAmount
  if (payAmountInput !== undefined && payAmountInput !== null) {
    const v = Number(payAmountInput)
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error('INVALID_PARAMS: 支付金额无效')
    }
    // 浮点容差：39.8 * 100 在 JS 里是 3979.9999999999995，严格 !== 会误判
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

  // 自动绑定 client_user_id（仅 staff 来源且未绑定时）
  if (!order.client_user_id && order.opened_by) {
    // CAS-EXEMPT: 仅写 PII（client_user_id）+ 支付方式，不翻 status
    await pg.query(
      'UPDATE sale_orders SET client_user_id = $1, payment_method = $2, updated_at = $3 WHERE sale_order_id = $4',
      [userId, '微信', now, orderNo]
    )
  } else {
    // CAS-EXEMPT: 仅设支付方式，不翻 status
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
  // 首付金额已发起拉卡拉支付：清空 first_payment_amount，让后续扫码（继续支付）按剩余应付走
  // 仅清空非空值，避免无谓写；不影响 NULL 默认（全额）订单
  await pg.query(
    'UPDATE sale_orders SET first_payment_amount = NULL, updated_at = $1 WHERE sale_order_id = $2 AND first_payment_amount IS NOT NULL',
    [now, orderNo]
  )
  ctx.result = {
    orderNo,
    totalAmount,
    paidAmount: thisPayAmount,
    paymentMethod: '微信',
    paymentParams,  // wx.requestPayment 5 字段：timeStamp/nonceStr/package/signType/paySign
  }
}

/**
 * 选择线下付款
 *
 * 业务语义：客户端"确认选择线下付款"，订单保持 '待支付'，仅写入 payment_method='线下'
 * 与 client_user_id；通过 (status='待支付' AND payment_method='线下') 复合判定识别
 * "用户已选线下、待店长 confirmOffline 入账"。真正的款项落账由 staff 端 confirmOffline 处理。
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

  // 10分钟超时检查（关闭并释放优惠券）；员工单 closeExpiredOrder 内部跳过，不抛超时（issue #27）
  const orderTimeOffline = new Date(order.sale_order_datetime)
  if (Date.now() - orderTimeOffline.getTime() > 10 * 60 * 1000) {
    const closed = await closeExpiredOrder(orderNo)
    if (closed) throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
  }

  // 全额储值卡抵扣：payable_amount = 0，直接短路返回已支付
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

  // 备注：不在本函数写 payments 行。staff 端 confirmOffline 会插入
  // change_type='首次支付' / payment_method='线下' / status='已支付' 的流水行并翻订单状态。

  ctx.result = {
    orderNo,
    status: '待支付',
    message: '已选择线下支付,请到店付款'
  }
}

/**
 * 订单列表
 */
async function list(ctx) {
  const { userId } = ctx.auth
  const { status, statuses, page: pageParam, pageSize: pageSizeParam } = ctx.event.payload || {}

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

  // 状态过滤：statuses 数组优先（多状态，如「待支付」Tab 同时纳入 待支付 + 部分支付），
  // 否则回退到单值 status（保持原语义）
  if (Array.isArray(statuses) && statuses.length > 0) {
    params.push(statuses)
    whereClause += ` AND o.status = ANY($${params.length})`
  } else if (status) {
    params.push(status)
    whereClause += ` AND o.status = $${params.length}`
  }

  // 多取 1 条用于判断是否有下一页
  const fetchLimit = pageSize + 1
  params.push(fetchLimit, offset)

  // 2026-04-26 sale-order-domain-refactor:
  //   - paid_amount 列已删除 → 新增 received / refunded_amount 字段返回，便于前端推导"已退款"标签
  //   - "已退款" 标签由 refunded_amount > 0 推导，不再依赖 sale_order_type='退款单'
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

  // 批量查询所有订单的明细项（使用快照字段）
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
  // 员工单 closeExpiredOrder 内部跳过，不置已关闭（issue #27）
  if (order.status === '待支付') {
    const orderTime = new Date(order.sale_order_datetime)
    if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
      const closed = await closeExpiredOrder(orderNo)
      if (closed) order.status = '已关闭'
    }
  }

  // 查询订单明细（使用快照字段 + 商品封面）
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

  // 待支付订单返回过期时间
  let expireAt = null
  if (order.status === '待支付') {
    expireAt = new Date(new Date(order.sale_order_datetime).getTime() + 10 * 60 * 1000).toISOString()
  }

  // 并行查询美容师姓名、券名称和款项流水
  // 退款流水通过同表 change_type='退款' 聚合（不再依赖独立 sale_order_type='退款单' 行）
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

  // 精简 payments 字段（只给前端需要的）
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
  // 2026-04-26 sale-order-domain-refactor:
  //   - paid_amount 已删除 → 全额抵扣判定改为 payable_amount=0（即 total = prepaid_card_amount）
  const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
  const totalAmountCnl = Number(order.total_amount || 0)
  const payableAmountCnl = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmountCnl - prepaidCardAmount) * 100) / 100
  const isPrepaidFull = prepaidCardAmount > 0 && payableAmountCnl === 0
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

    // audit-02 P0：cancel CAS 守卫——只在 status ∈ 允许列表 且 client_user_id 匹配时更新一行
    // 防并发：他端先 confirmOffline / payNotify 把单子置 '已支付' 时本端不可越权关闭
    const allowedStatusList = cancelableStatuses // 已根据 isPrepaidFull 计算
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
            `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
             VALUES ($1, '充值', $2, $3, $4)
             ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
            [cardId, prepaidCardAmount, orderNo, `card-cancel-rev-${orderNo}`]
          )
        }
      }
    }
  })

  // 聚合主扫订单按 timeout_express=10min 自动失效，无显式关单接口；
  // 不再调用旧收银台 closeCashierOrder。本地取消即可，迟到回调会被 payNotify 的状态机
  // CAS 守卫挡掉（订单已 '已关闭' 时回调 trade_state=SUCCESS 也不会再翻成 '已支付'）。

  ctx.result = {
    orderNo,
    status: '已关闭',
    message: '订单已取消'
  }
}

/**
 * 获取可预约项目列表
 * 查询已支付订单中有剩余次数的项目(疗程卡)
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

  // 10分钟超时检查（仅 '待支付' 且顾客自助单生效）；员工单 closeExpiredOrder 内部跳过，不抛超时（issue #27）
  if (order.status === '待支付') {
    const orderTimeAlipay = new Date(order.sale_order_datetime)
    if (Date.now() - orderTimeAlipay.getTime() > 10 * 60 * 1000) {
      const closed = await closeExpiredOrder(orderNo)
      if (closed) throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
    }
  }

  const totalAmount = Number(order.total_amount || 0)

  // 全额储值卡抵扣短路：payable_amount=0 → 不应进入拉卡拉，返回 isPrepaidFull 让前端跳详情页
  // （与 pay 行为对齐；防御性兜底——理论上前端已在 onSubmitOrder 提前走 confirmPrepaidFull）
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

  // 计算剩余应付 = payable_amount - 净到账（received - refunded_amount），逻辑同 pay
  const { remaining } = await calcPaymentRemaining(orderNo, order)
  const effectiveRemaining = remaining

  let thisPayAmount
  if (payAmountInput !== undefined && payAmountInput !== null) {
    const v = Number(payAmountInput)
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error('INVALID_PARAMS: 支付金额无效')
    }
    // 浮点容差：39.8 * 100 在 JS 里是 3979.9999999999995，严格 !== 会误判
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
  // CAS-EXEMPT: 仅设支付方式（支付宝）+ PII（client_user_id），不翻 status
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
  // 步骤 1: preorder(ALIPAY, NATIVE=41) 拿二维码 URL
  const preorderRespAli = await createLakalaPreorder({
    orderNo,
    merchantNo: merchantAli.merchantNo,
    termNo: merchantAli.termNo,
    payAmountYuan: thisPayAmount,
    accountType: 'ALIPAY',
    transType: '41',
    requestIp: requestIpAli,
  })
  // 步骤 2: share_code 用 alipayQrUrl 作为 biz_link 换取吱口令
  const shareCodeResp = await createLakalaAlipayShareCode({
    orderNo,
    merchantNo: merchantAli.merchantNo,
    termNo: merchantAli.termNo,
    outTradeNo: preorderRespAli.outTradeNo,
    payAmountYuan: thisPayAmount,
    requestIp: requestIpAli,
    bizLink: preorderRespAli.alipayQrUrl,
  })
  // 首付金额已发起拉卡拉支付：清空 first_payment_amount，让后续扫码（继续支付）按剩余应付走
  // CAS-EXEMPT: 仅清空 first_payment_amount 资金列，不翻 status（lint 正则误匹配后续 ctx.result.status）；
  //            WHERE first_payment_amount IS NOT NULL 已提供幂等防并发。
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

/**
 * 顾客在支付前调整抵扣方案（员工扫码 + 顾客自助下单两类入口共用）
 * payload: { saleOrderId, useCard, prepaidCardAmount?, paymentMethod? }
 * 订单状态必须='待支付'；balance 不动，本端点只重算订单的 prepaid_card_amount/payable_amount/payment_method
 *
 * 归属规则：
 *   - 员工开单（opened_by IS NOT NULL）：允许 client_user_id 为空（首次扫码绑定）或等于当前用户
 *   - 自助下单（opened_by IS NULL）：必须 client_user_id 已绑定且等于当前用户
 *
 * 2026-04-26 sale-order-domain-refactor：
 *   - paid_amount 列已 DROP；本端点改写 payable_amount（应付实金），而非 paid_amount
 *   - received 不动（实付到账由 payNotify / confirmPrepaidFull / confirmOffline 写）
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

  if (order.status !== '待支付') {
    throw new Error('INVALID_PARAMS: 订单状态不允许调整')
  }
  // 归属校验：自助下单必须已绑定 client_user_id；员工开单允许 client_user_id 为空（首次扫码绑定）
  if (!order.opened_by && !order.client_user_id) {
    throw new Error('INVALID_PARAMS: 订单归属未确定')
  }
  if (order.client_user_id && order.client_user_id !== userId) {
    throw new Error('PERMISSION_DENIED: 无权操作该订单')
  }

  const totalAmount = Number(order.total_amount || 0)

  // 读当前余额（本端点不扣款，不加 FOR UPDATE）
  // 2026-05-19 dirty-read 修复：返回 balanceSnapshot（含 updated_at 版本号），供 confirmPrepaidFull 校验
  let cardBalance = 0
  const cardRows = await pg.query(
    'SELECT card_id, balance, updated_at FROM prepaid_cards WHERE user_id = $1',
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
      // 浮点容差：39.8 * 100 在 JS 里是 3980.0000000000005，严格 !== 会误判
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
    // 2026-05-19 dirty-read 修复：返回余额快照（含版本号 updatedAt），前端在 confirmPrepaidFull 时回传校验
    balanceSnapshot: cardRows.length > 0 ? {
      cardId: cardRows[0].card_id,
      balance: Number(cardRows[0].balance),
      updatedAt: cardRows[0].updated_at,
    } : null,
  }
}

/**
 * 全额抵扣确认支付（扫码页顾客点"确认支付"且 payable_amount=0 时调用）
 * 同事务：SELECT FOR UPDATE balance → 扣减 → INSERT card_transactions → 订单置'已支付'
 *
 * 2026-04-26 sale-order-domain-refactor：
 *   - paid_amount 列已 DROP；判定改用 payable_amount（应付实金）
 *   - 同事务写 sale_order_payments[change_type='储值卡抵扣',status='已支付']，维护 received 不变量
 */
async function confirmPrepaidFull(ctx) {
  await requirePhone()(ctx, async () => {})

  const { userId } = ctx.auth
  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  // 2026-05-19 dirty-read 修复：可选版本号，scanAdjust 时记录的 prepaid_cards.updated_at 快照
  // 不传时保持向后兼容（老前端继续可用）
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
    // 2026-05-19 dirty-read 修复：FOR UPDATE 锁后版本号校验
    // 若前端传了 expectedBalanceUpdatedAt 且与锁定行的 updated_at 不一致 → CONFLICT
    // 不传时保持向后兼容（不校验）
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

    // 幂等：若已扣过则跳过写入
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
      // 维护 received 不变量：写 sale_order_payments[储值卡抵扣,已支付]
      // 注意此处用 INSERT ... ON CONFLICT 兜底（万一 create 已写过，避免双写违 chk_sop_amount_sign）
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

    // 同事务把 received 双写到位（若 create 已写则会再加一次——故仅在本次新增 payment 时累加）
    // 简化：直接重算 received 为聚合值，避免双写竞态
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

    // 按回款逐笔分配：捕获本次全额储值卡抵扣逐项可分配额 + 置回款待分配 + 汇总刷新
    // （client 路径一律「待分配」手动分配，无子项定向，不做自动分配——自动分配仅在 payNotify）
    if (cardPaymentId && prepaidCardAmount > 0) {
      await capturePaymentAllocatables(client, {
        salePaymentId: cardPaymentId,
        saleOrderId,
        eventAmount: prepaidCardAmount,
        directedItems: null,
      })
      await refreshOrderAllocationRollup(client, saleOrderId)
    }

    // paid_sessions 重算（ticket 2026-05-19）：全额储值卡抵扣后 settled = total_amount
    // → 公式 floor(min(1, settled/total) × session_count) 退化为 session_count
    // 必须在 capture 之后：新 STEP1 从 spai 聚合 received
    await recalcPaidSessionsForOrder(client, saleOrderId)

    // 积分结算（订单链净额差值法，幂等）
    // confirmPrepaidFull 仅对 payable_amount=0 的纯卡抵扣订单：链净额=0 → delta=0 → 无写入（AC-05）
    // 保留调用以保证"所有状态转已支付的触发点"都走同一入口
    await settlePointsSafe(client, saleOrderId, 'clientApi.confirmPrepaidFull')

    // 会员等级即时重算（只升不降；仅会员客生效，礼包留给 cron）
    await recalcMemberLevel(client, userId, await getMemberThreshold(), 'clientApi')
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
 * 2026-04-26 sale-order-domain-refactor 简化（saleOrderType 5→3，回款单已消除）：
 *   - 不再生成 FY-HKD 凭证 sale_orders 行（"回款单"概念已废）
 *   - 纯储值卡通道：直接写 sale_order_payments[change_type='储值卡抵扣',payment_method='储值卡',status='已支付']
 *     到原单 + 增量 bump prepaid_card_amount（退款回冲卡而非退现金；与 admin/staff 同口径）
 *   - 线上通道：不写 payments 行（由 payNotify 回调写），仅返回 mock 支付参数
 *   - 线上+储值卡混合：写 status='待支付' 储值卡抵扣意向，扣卡推迟到 payNotify 线上到账同事务（见 STEP 3c）
 *
 * 顾客对未付清订单（status='部分支付' 或 '待支付' 且已有 payments 行）发起追加付款。
 *
 * 入参：
 *   saleOrderId         原销售单号（FY-XSD-...）
 *   paymentMethod       '微信' | '支付宝' | '储值卡'
 *   repayAmount         线上实付金额（微信/支付宝时 > 0，纯储值卡时 = 0）
 *   prepaidCardAmount?  储值卡抵扣金额（可选，默认 0）
 *
 * 事务内：
 *   a. SELECT 原单 FOR UPDATE，校验归属 + status ∈ {'部分支付','待支付'}
 *   b. 校验 repayAmount + prepaidCardAmount > 0 且不超过 (payable_amount - 净到账)
 *   c. 储值卡：扣卡 + INSERT payments(回款/储值卡) + 重算 received/refunded_amount + 若付清置 '已支付'
 *   d. 线上：仅返回支付参数；payments 行由 payNotify 回调写
 *
 * 返回：
 *   { saleOrderId, status, paymentParams?, repayAmount, prepaidCardAmount, paymentMethod }
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
  if (!['微信', '支付宝', '储值卡', '线下'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 支付方式仅支持 微信/支付宝/储值卡/线下')
  }
  if (!Number.isFinite(repayAmountInput) || repayAmountInput < 0) {
    throw new Error('INVALID_PARAMS: 还款金额无效')
  }
  if (!Number.isFinite(prepaidCardAmountInput) || prepaidCardAmountInput < 0) {
    throw new Error('INVALID_PARAMS: 储值卡抵扣金额无效')
  }
  // 浮点容差：39.8 * 100 在 JS 里不是精确的 3980，严格 !== 会误判
  if (Math.abs(Math.round(repayAmountInput * 100) - repayAmountInput * 100) > 1e-6
      || Math.abs(Math.round(prepaidCardAmountInput * 100) - prepaidCardAmountInput * 100) > 1e-6) {
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
    // 微信/支付宝/线下通道：repayAmount 必须 > 0（线上可叠加 prepaidCardAmount；线下不可）
    if (repayAmountInput <= 0) {
      throw new Error('INVALID_PARAMS: 线上/线下通道 repayAmount 必须大于 0')
    }
  }
  // 线下通道：仅标记顾客「到店付款」意向，不写流水、不推进状态（由 staff 确认收款落账），且不支持储值卡抵扣混合
  if (paymentMethod === '线下' && prepaidCardAmountInput > 0) {
    throw new Error('INVALID_PARAMS: 线下通道不支持储值卡抵扣')
  }

  const isPureCard = paymentMethod === '储值卡'
  const isOffline = paymentMethod === '线下'
  const now = new Date()
  let finalStatus // 原单最新 status（pure-card 路径会推到 '已支付'/'部分支付'；线上/线下路径不动）
  let currentStatus // 原单当前 status（线下路径返回用，状态不变）
  let storeId    // 原单门店 id，回到事务外用于解析拉卡拉商户配置

  await pg.transaction(async (client) => {
    // 1. 锁原单 + 校验归属 + 状态
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

    // 2. 计算欠款 = payable_amount - 净到账（received - refunded_amount）
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
    // 顾客端继续支付强制全额：只能一次性付清全部未付金额，不允许部分回款
    // （按子项部分回款仅 admin/staff 可做；client 一律全额）
    if (totalNew + 0.001 < remaining) {
      throw new Error('INVALID_PARAMS: 继续支付必须支付全部未付金额')
    }

    // 3. 储值卡扣款（按通道分流）。先无条件作废本单此前遗留的「待支付储值卡抵扣」意向：
    //    同一订单可被重复扫码（取消线上支付后重选抵扣额、或从混合改纯线上/线下/纯卡），旧意向若残留
    //    会被 payNotify 误消费、扣走顾客并不想用的储值卡。在订单 FOR UPDATE 锁下清理，避免并发竞态。
    let cardPaymentId = null
    await client.query(
      `UPDATE sale_order_payments SET status = '已作废'
       WHERE sale_order_id = $1 AND change_type = '储值卡抵扣' AND status = '待支付'`,
      [saleOrderId]
    )
    //    - 纯储值卡通道（isPureCard）：当场扣卡 + INSERT payments(回款/储值卡/已支付)，无线上款本就原子。
    //    - 线上+储值卡混合：不当场扣卡，仅写一行待支付储值卡抵扣意向；扣减 + 入账 + 状态推进推迟到
    //      payNotify 线上到账同事务执行（支付取消/失败 → 意向行保持待支付、储值卡分文不动，一起回滚）。
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
      // repay 可合法多次调用同 saleOrderId（分批回款），用 timestamp 区分，partial unique 仅防 sub-ms 双发
      await client.query(
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
         VALUES ($1, '扣款', $2, $3, $4, NOW())
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
        [cardIdUsed, -prepaidCardAmountInput, saleOrderId, `card-repay-${saleOrderId}-${now.getTime()}`]
      )
      // payments 行：change_type='储值卡抵扣'（与 admin recordPayment / staff createRepayment / 混合通道一致）。
      // 关键（修退款现金泄漏）：储值卡抵扣 计入 prepaid_card_amount（下方 STEP 5 同步 bump），退款按通道拆分
      // splitRefundByOriginalPayment 据 prepaid_card_amount 把该部分回冲储值卡而非退现金；若记 '回款' 则 prepaid 不增 →
      // 卡支付额被当现金退出（卡内充值赠送额=真实资损）。received 口径含 储值卡抵扣（I1），故 received 数值不变。
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
      // 线上+储值卡混合：仅校验余额（FOR UPDATE 锁防 dirty read）后写一行「待支付」储值卡抵扣意向，
      // **不扣减余额、不写 card_transactions、不推进状态**。实际扣卡 + 翻已支付由 payNotify 在线上
      // 到账同事务执行；线上支付被取消/失败 → 意向行保持待支付、储值卡不动（与线上款一起回滚）。
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

    // 4. 线上回款：不写 payments 行（payNotify 回调写）；仅更新原单 payment_method 反映最近通道
    if (!isPureCard) {
      // CAS-EXEMPT: 仅设支付方式，不翻 status（status 由后续 STEP 5 重算或 payNotify 推进）
      await client.query(
        `UPDATE sale_orders SET payment_method = $1, updated_at = $2
         WHERE sale_order_id = $3`,
        [paymentMethod, now, saleOrderId]
      )
    }

    // 5. 重算原单 received/refunded_amount + 推进 status：仅纯储值卡通道（当场扣卡 + 写了已支付储值卡回款行）。
    //    线上+储值卡混合通道此处 **不推进** —— received/状态推进随储值卡扣减一并推迟到 payNotify STEP 3c。
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
      // 纯卡回款：把本次卡抵扣额并入 prepaid_card_amount（增量，保留原 create-time 卡额；client create-card 延迟消费、
      // 不在 储值卡抵扣 行里，故用 += 而非 Σ重算），同步降 payable_amount 维护 I5（payable=total-prepaid）。
      // status 仍按事务起始的 payableAmount 判定（received 含本次卡抵扣，付清即 已支付），不受本次 prepaid bump 影响。
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
      // 按回款逐笔分配：捕获本次储值卡回款逐项可分配额 + 置回款待分配 + 汇总刷新
      // （client 一律全额、无子项定向、待分配；线上回款由 payNotify 捕获）
      if (cardPaymentId && prepaidCardAmountInput > 0) {
        await capturePaymentAllocatables(client, {
          salePaymentId: cardPaymentId,
          saleOrderId,
          eventAmount: prepaidCardAmountInput,
          directedItems: null,
        })
        await refreshOrderAllocationRollup(client, saleOrderId)
      }
      // paid_sessions 重算（ticket 2026-05-19）：纯卡回款 received 增长 → settled 上升
      // → 按 floor(settled/total × session_count) 自动解锁更多可消费次数
      // 必须在 capture 之后：新 STEP1 从 spai 聚合 received
      await recalcPaidSessionsForOrder(client, saleOrderId)
      // 积分结算（纯卡回款时 received 已增加，需 settle；线上通道等 payNotify 触发）
      await settlePointsSafe(client, saleOrderId, 'clientApi.repay')
      // 会员等级即时重算（只升不降；付清后累计消费可能跨档，礼包留给 cron）
      await recalcMemberLevel(client, userId, await getMemberThreshold(), 'clientApi')
    }
  })

  // 返回支付参数（微信/支付宝）或成功状态（储值卡）
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

  // 线下通道：事务内 STEP 4 已把 payment_method 标记为 '线下'；不写流水、不推进状态，
  // 实际到账由 staff 端「确认收款 / 回款」落账。直接返回（不进拉卡拉聚合主扫预下单）。
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

  // 线上通道：调聚合主扫 preorder（微信） / preorder+share_code（支付宝）
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
    // 支付宝：preorder + share_code
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

/**
 * 查询拉卡拉聚合主扫交易状态（只读轮询兜底）
 *
 * 前端轮询 order.detail 仍 '待支付' 时可调本接口，主动问拉卡拉该单是否已支付，
 * 避免 payNotify 延迟/丢失时死等。**不改 DB**——订单结算（置已支付/积分/储值卡等）仍由
 * payNotify 单源负责；本接口仅把拉卡拉视角的 trade_state 透出给前端做 UX 决策。
 *
 * trade_state ∈ INIT/CREATE/SUCCESS/FAIL/DEAL/UNKNOWN/CLOSE/PART_REFUND/REFUND
 * 'SUCCESS' 才表示真实到账（'BBS00000' 成功码仅说明查到了交易记录）
 */
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

  // 未经拉卡拉发起支付，或门店未启用：无可查的拉卡拉订单，仅回本地状态
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
    lakalaTradeState: resp.tradeState || null,  // 'SUCCESS' 才算到账
    lakalaCode: resp.code,
  }
}

/**
 * 支付对账决策（纯函数，便于单测 + verify 脚本复用）。
 *
 * issue #37：payNotify 异步回调偶发丢失会导致"钱已扣但订单仍待支付"。
 * confirmPayment 据本函数决策是否主动查拉卡拉并补偿入账。
 *
 * @param {string} localStatus - sale_orders.status
 * @param {boolean} hasLakalaOrder - lakala_out_order_no IS NOT NULL（经拉卡拉发起）
 * @param {string|null} tradeState - 拉卡拉 queryTrade 返回 trade_state；'SUCCESS' 才到账
 * @returns {'skip'|'wait'|'reconcile'}
 *   skip      终态 / 非待支付·部分支付 / 无拉卡拉单 → 无需对账，直接返回本地 status
 *   wait      拉卡拉侧尚未 SUCCESS → 前端继续轮询
 *   reconcile 本地待支付·部分支付 + 拉卡拉 SUCCESS → 触发补偿入账
 */
function decideReconcile(localStatus, hasLakalaOrder, tradeState) {
  const terminal = new Set(['已支付', '已完成', '已关闭', '支付失败'])
  if (terminal.has(localStatus)) return 'skip'
  if (localStatus !== '待支付' && localStatus !== '部分支付') return 'skip'
  if (!hasLakalaOrder) return 'skip'
  if (tradeState !== 'SUCCESS') return 'wait'
  return 'reconcile'
}

/**
 * order.confirmPayment — 支付结果主动对账 + 补偿入账（issue #37）。
 *
 * 背景：payNotify 异步回调天生非 100% 可靠（冷启动 / PG 瞬断 / 验签瞬态失败 / 网络抖动），
 * 偶发丢失会让"钱已扣、订单仍待支付"。本接口不替代回调，而是在前端支付后轮询 /
 * 后端定时补偿触发时，主动查拉卡拉真实状态，SUCCESS 则触发与回调同款的幂等入账。
 *
 * 流程：
 *   1. 权限校验（client_user_id === userId）
 *   2. decideReconcile 早期决策：终态 / 无拉卡拉单 → 直接返回本地 status（不动）
 *   3. resolveLakalaMerchant + lakalaClient.queryTrade 查真实 trade_state
 *   4. decideReconcile(localStatus, true, tradeState)：
 *        wait      → 返回本地 status + lakalaTradeState（前端继续轮询）
 *        reconcile → cloud.callFunction 调 payNotify（event 入口）触发幂等入账 → 重查 status
 *   全程 try/catch：queryTrade / callFunction 失败降级返回本地 status，不 throw（前端继续轮询）
 *
 * 安全：不凭前端入参入账，必先 queryTrade 验证 SUCCESS；payNotify 幂等键
 *       (uq_sop_txn / uq_sop_first_payment / CAS 守卫) 兜底重复入账。
 *
 * 返回 ctx.result：{ saleOrderId, status, reconciled, reason?, lakalaTradeState?, payNotifyResult? }
 */
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

  // 早期决策：终态 / 无拉卡拉单 → 无需对账，直接返回本地 status
  if (decideReconcile(localStatus, hasLakalaOrder, null) === 'skip') {
    ctx.result = {
      saleOrderId: orderNo,
      status: localStatus,
      reconciled: false,
      reason: hasLakalaOrder ? 'terminal' : 'no_lakala_order',
    }
    return
  }

  // 查拉卡拉真实状态（resolveLakalaMerchant 在 term_no 缺失时抛 INVALID_STATE，包 try/catch 降级）
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
  // 拉卡拉侧尚未 SUCCESS：返回本地 status，前端继续轮询
  if (decideReconcile(localStatus, hasLakalaOrder, tradeState) !== 'reconcile') {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, lakalaTradeState: tradeState, reason: 'not_success' }
    return
  }

  // 拉卡拉 SUCCESS + 本地待支付/部分支付 → 触发与回调同款的幂等入账
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

  // 重查本地 status（payNotify 已更新），返回最新态
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
