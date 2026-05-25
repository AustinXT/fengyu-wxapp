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
const { assertOrderInScope, isStoreInScope } = require('../utils/scope')
const { generateWxacode, uploadToCloudStorage } = require('../utils/wxacode')
const { getMemberThreshold } = require('../utils/config')
// 充值卡剥离 SKU 化（2026-05-20）：充值识别改为 sale_orders.sale_order_type='充值单'，
// 不再依赖虚拟 SKU ID 或 product_name 正则解析面值。
const { settlePointsSafe } = require('../utils/points')
const { recalcMemberLevel } = require('../utils/member-level')
const { recalcPaidSessionsForOrder } = require('../utils/paid-sessions')
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
 * spending_tier 档位边界为固定值（含 '1990-1W' 档下界 1990），不随
 * system_configs.new_member_threshold 变化；门槛只影响 customer_type / member_level。
 *
 * @param {object} client - pg 事务客户端
 * @param {string} clientUserId - client_wechat_users.user_id
 */
async function refreshSpendingTier(client, clientUserId) {
  if (!clientUserId) return
  // 与 admin refreshSpendingTierTx (refunds.ts) / payNotify 同名 SQL 跨端字面对齐：
  // 仅纳入"销售单 + 转换单"做消费档位累计；
  // 充值单（预收，2026-05-20 充值卡剥离 SKU 化新增）/ 内部单 / 寄存单不算消费。
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
       SELECT COALESCE(SUM(total_amount), 0) AS total
       FROM sale_orders
       WHERE client_user_id = $1
         AND status IN ('已支付', '已完成')
         AND sale_order_type IN ('销售单','转换单')
     ) t
     WHERE user_id = $1`,
    [clientUserId]
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

  // 三端 SQL 独立副本（admin actions/orders.ts + staffApi routes/order.js + payNotify index.js）
  // 修改时必须同步另外两端；一致性由 staffApi __tests__/routes/recalc-customer-type-sql.test.js
  // 守护，任一端漂移立即触发测试失败。
  //
  // 充值卡剥离 SKU 化（2026-05-20）后 sale_order_type 新增 '充值单'；本 CASE 全部三个分支
  // 保持 `o.sale_order_type = '销售单'` 字面量过滤——充值单是预收（顾客把钱预先存到储值卡），
  // 不算实际销售也不影响顾客类型跃迁；且 0 行 sale_items 也无法满足小美客/体验客的 JOIN
  // 条件，保留过滤不会引入误判。
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

  // 若本次 UPDATE 实际将顾客升级为"会员客"，同步写入 became_member_at
  if (updateResult.rowCount > 0 && updateResult.rows[0].customer_type === '会员客') {
    await client.query(
      `UPDATE client_wechat_users SET became_member_at = NOW() WHERE user_id = $1`,
      [clientUserId]
    )
  }
}

/**
 * 开单时即时扣储值卡（全额抵扣场景：payable==0、无现金可收）。
 *
 * 与 confirmOffline 的扣卡块字面对齐：锁余额 → 校验 → UPDATE prepaid_cards.balance
 * → card_transactions(type='扣款') → sale_order_payments(change_type='储值卡抵扣')。
 * 幂等键 external_ref='card-deduct-{saleOrderId}'；余额不足抛 INSUFFICIENT_BALANCE。
 *
 * 仅在订单全额由储值卡抵扣（payable==0 且 prepaid>0）时于创建事务内调用——无现金可收，
 * 挂"待支付"会卡死（payment_method='无' 走不了 confirmOffline），故创建时直接扣卡 + 结清
 * （用户 2026-05-21 拍板；销售单/转换单同规则）。跨端与 admin orders.ts 同名 helper 对齐。
 */
async function deductPrepaidCardAtCreation(client, { saleOrderId, clientUserId, amount, staffWfId, note, now }) {
  if (!(amount > 0) || !clientUserId) return
  // 幂等：已扣过则跳过
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
  await client.query(
    `INSERT INTO sale_order_payments (
      sale_order_id, change_type, amount, payment_method, external_txn_id,
      status, source_end, operator_employee_id, note, created_at, paid_at
    ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'staff', $3, $4, $5, $5)`,
    [saleOrderId, amount, staffWfId, note, now]
  )
}

/**
 * 全额储值卡抵扣订单"创建即结清"后的统一结算副作用，对齐 confirmOffline 的已支付分支：
 * 消费档位 + 客户分类 + 积分 + 分享礼。
 * （paid_sessions 由各调用点已有的 recalcPaidSessionsForOrder 负责，此处不重复。）
 * 2026-05-21 单品合并：单品 1 年有效期自动赋值已移除。
 */
async function settlePaidByCardAtCreation(client, { saleOrderId, clientUserId, receivedAmount, now }) {
  if (clientUserId) {
    await refreshSpendingTier(client, clientUserId)
    await recalcCustomerType(client, clientUserId)
    // 会员等级即时重算（只升不降；与 recalcCustomerType 同口径，礼包留给 cron）
    await recalcMemberLevel(client, clientUserId, await getMemberThreshold(), 'staffApi')
  }
  await settlePointsSafe(client, saleOrderId, 'staffApi.createPaidByCard')
  // 分享礼（首单结清；savepoint 隔离，非致命）
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

/**
 * 员工开单（店长专用）
 * payload: {
 *   clientPhone: string,
 *   clientName: string,
 *   saleOrderType: '销售单' | '内部单',   // 直接使用 DB 枚举文本，无历史兼容
 *   items: [{ skuId, quantity, received?: number }],   // received = 行实付金额；默认=行应付（priceLine - 摊到的券）
 *   paymentMethod: '微信'|'支付宝'|'线下',
 *   preferredStaffWfId: string,
 *   couponId: string
 * }
 *
 * 行为：
 *   - 销售单：正常计价；行应付金额 = 价格 - 订单级券按 priceLine 比例摊到的份额（不可手工编辑）
 *   - 内部单：所有 SKU 半价（basePrice × 0.5）；拒绝 couponId
 *   - 行实付金额：店长可向下调（0 ≤ received ≤ 行应付）；不传则默认 = 行应付
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
  } = payload

  const storeId = ctx.auth.effectiveStoreId
  const marketName = ctx.auth.marketName || ''

  // J3 (B9 ticket follow-up): 拒绝数组形式 couponId — 一张订单仅支持 1 张优惠券
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
  // 支付方式白名单（销售单 / 内部单）：微信 / 支付宝 / 线下
  // '无' 值由后端在 paid_amount=0 时强制覆盖，前端不应主动传 '无'
  if (!['微信', '支付宝', '线下'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式')
  }
  if (!storeId) {
    throw new Error('INVALID_PARAMS: 缺少门店信息')
  }

  // sale_order_type 直接使用 DB 枚举文本（无历史兼容映射）
  // 2026-04-26 sale-order-domain-refactor：枚举 5→3，回款/退款下沉到 sale_order_payments，order.create 仅接受销售单/内部单
  const saleOrderType = saleOrderTypeParam || '销售单'
  if (['回款单', '退款单'].includes(saleOrderType)) {
    throw new Error('INVALID_PARAMS: 回款/退款已下沉至 sale_order_payments，order.create 不再支持此类型')
  }
  if (!['销售单', '内部单'].includes(saleOrderType)) {
    throw new Error('INVALID_PARAMS: 订单类型不合法（仅支持 销售单/内部单）')
  }

  // 内部单守卫：不允许叠加优惠券
  if (saleOrderType === '内部单' && inputCouponId) {
    throw new Error('INVALID_PARAMS: 内部单不允许叠加优惠券')
  }

  // 历史 customPrice/discount 入参已废弃（前端按行不再传），后端不再处理
  // 行级"应付金额"由订单级券摊算得出，不再可手工编辑

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
  const rawItemDataList = await Promise.all(
    items.map(async (item) => {
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

      let unitPrice
      let sessionCount = null
      let salesCategory = sku.sales_category || null
      // 「价格」= 会员价优先（specialPrice），否则 price（两端统一）
      const basePrice = Number(sku.special_price || sku.price)

      if (saleOrderType === '内部单') {
        // 内部单（员工消费）统一半价
        unitPrice = Math.round(basePrice * 50) / 100
      } else {
        unitPrice = basePrice
      }
      sessionCount = sku.session_count != null ? Number(sku.session_count) : null

      const quantity = item.quantity || 1
      // sale_items.session_count / remaining_sessions 是"次"维度（service.complete 按次扣减），
      // 应 = sku.session_count × quantity；之前漏乘 quantity 导致剩余次数显示 1/1 而非 N/N
      if (sessionCount != null) sessionCount = sessionCount * quantity
      // priceLine = 价格 × 数量（订单级券摊算的基准），暂存为 saleAmount；摊券后再覆盖
      const priceLine = Math.round(unitPrice * quantity * 100) / 100

      // 前端传入行实付（默认 = 应付金额，店长可向下调；这里先记录原始值，摊券后再做最终裁剪）
      const inputReceived = item.received !== undefined && item.received !== null
        ? Number(item.received)
        : null
      if (inputReceived !== null && (!Number.isFinite(inputReceived) || inputReceived < 0)) {
        throw new Error('INVALID_PARAMS: 行实付金额必须为非负数')
      }

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
        // unitRealPrice / saleAmount / received 由后续摊券步骤一并计算（saleAmount 初值=priceLine）
        unitRealPrice: unitPrice,
        saleAmount: priceLine,
        priceLine,
        inputReceived,
        // received 兜底先填 priceLine（摊券后会被覆盖；inputReceived 在裁剪步处理）
        received: priceLine,
        salesCategory,
        serviceFee,
        isShengmei: sku.is_shengmei ?? null,
        isExperience: sku.is_experience === true,
      }
    })
  )

  // ========== B2 拆行：疗程卡 quantity>1 → N 行 quantity=1 ==========
  // ticket: notes/tickets/archives/2026-05-18-single-session-card-quantity-not-split.md
  // 业务语义：每张卡（无论 sku.session_count 是 1 还是 N）都是独立可转换/核销的实体，
  // 应在 sale_items 写成 N 行（每行 quantity=1, session_count=sku.session_count）。
  // 家居产品（productType='家居产品'）继续合行（quantity 累加）。
  // 折扣/服务费/sale_amount/received 按 N 等分，最后一行吸收尾差，确保 sum 守恒。
  const itemDataList = []
  for (const d of rawItemDataList) {
    if (d.productType === '疗程卡' && d.quantity > 1) {
      const n = d.quantity
      const perSession = d.sessionCount != null ? Math.round(d.sessionCount / n) : null
      const perSaleAmount = Math.round((d.saleAmount * 100) / n) / 100
      const perPriceLine = Math.round((d.priceLine * 100) / n) / 100
      const perServiceFee = Math.round((d.serviceFee * 100) / n) / 100
      // 入参 received（行实付）按 N 等分，最后一行吸收尾差；缺省时各行也 null
      const perInputReceived = d.inputReceived !== null && d.inputReceived !== undefined
        ? Math.round((d.inputReceived * 100) / n) / 100
        : null
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
        const inputReceivedRow = perInputReceived !== null
          ? (isLast ? Math.round((d.inputReceived - perInputReceived * (n - 1)) * 100) / 100 : perInputReceived)
          : null
        itemDataList.push({
          ...d,
          quantity: 1,
          sessionCount: perSession,
          remainingSessions: perSession,
          priceLine: priceLineRow,
          saleAmount: saleAmountRow,
          // received / unitRealPrice 由后续摊券+inputReceived 裁剪步骤计算
          received: saleAmountRow,
          unitRealPrice: saleAmountRow,
          inputReceived: inputReceivedRow,
          serviceFee: serviceFeeRow,
        })
      }
    } else {
      itemDataList.push(d)
    }
  }

  // ========== 优惠券处理 ==========
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

    // 门店匹配
    if (couponInfo.applicable_store_ids && couponInfo.applicable_store_ids.length > 0) {
      if (!storeId || !couponInfo.applicable_store_ids.includes(storeId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此门店')
      }
    }

    // 市场匹配（通过门店 → org_nodes → parent 找市场）
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

    // 品项分类 + 商品匹配
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

    // 分摊到各行：先按 saleAmount(初值=priceLine) 比例摊，最后一行吸收尾差
    // 新模型：行 saleAmount = priceLine - couponShare（应付小计含摊券）；行 received 在下一步按入参裁剪
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
      // unitRealPrice 与 saleAmount 同口径（应付单价）
      item.unitRealPrice = item.quantity > 0 ? Math.round((item.saleAmount / item.quantity) * 100) / 100 : 0
    }
  }

  // 行 received 最终裁剪：默认 = saleAmount（应付小计），inputReceived 非空时取 min(inputReceived, saleAmount)
  for (const d of itemDataList) {
    if (d.inputReceived !== null && d.inputReceived !== undefined) {
      d.received = Math.min(d.inputReceived, d.saleAmount)
      d.received = Math.round(d.received * 100) / 100
    } else {
      d.received = d.saleAmount
    }
  }

  // per-session 派生（sale_amount 为权威行总额）：
  //   unit_real_price = 卡? round(sale_amount/session_count) : round(sale_amount/quantity)（非卡 per-unit 退化）
  //   unit_price      = 卡? round(标价行总额/session_count) : per-unit 标价；标价行总额 = (原 per-card unit_price) × quantity
  for (const d of itemDataList) {
    const denom = (d.sessionCount != null && d.sessionCount > 0) ? d.sessionCount : (d.quantity || 1)
    const listTotalRow = Math.round(Number(d.unitPrice || 0) * (d.quantity || 1) * 100) / 100
    d.unitRealPrice = denom > 0 ? Math.round((Number(d.saleAmount || 0) / denom) * 100) / 100 : Number(d.saleAmount || 0)
    d.unitPrice = denom > 0 ? Math.round((listTotalRow / denom) * 100) / 100 : listTotalRow
  }

  const now = new Date()
  // saleOrderId 在事务内由 generateOrderNo(undefined, client) 生成，保证 advisory lock
  // 持有窗口覆盖 SELECT MAX → INSERT 全程，闭合 TOCTOU
  let saleOrderId
  // 订单应付合计 = Σ 行应付小计（saleAmount 已含订单级优惠券摊算）
  const totalAmount = Math.round(itemDataList.reduce((sum, d) => sum + d.saleAmount, 0) * 100) / 100

  // ========== 充值卡预选（店长开单 = 预选，不扣卡；DB 字段 prepaid_card_amount 命名保持不变）==========
  // 查询顾客当前余额（不加 FOR UPDATE，因为不写 balance）；仅店长预选为参考
  let prepaidCardAmount = 0
  if (useCard) {
    const balanceRows = await pg.query(
      'SELECT balance FROM prepaid_cards WHERE user_id = $1',
      [clientUserId]
    )
    const currentBalance = balanceRows.length > 0 ? Number(balanceRows[0].balance) : 0

    // 计算预选额上限 = totalAmount（券已在 saleAmount 中扣除）
    const maxPrepayable = totalAmount

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
      // 未显式传值：默认"能抵多少抵多少"
      prepaidCardAmount = Math.min(currentBalance, maxPrepayable)
      prepaidCardAmount = Math.round(prepaidCardAmount * 100) / 100
    }
  }

  // ========== 款项流水（sale_order_payments）语义 ==========
  // payable_amount = total - prepaid_card_amount（扣卡后的"应付现金金额"冗余列）
  const payableAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100

  // receivedAmount（本次现场实收）= Σ 行实付（前端传入，默认 = 行应付）
  //   - 充值卡抵扣 + 行实付汇总 不应超过 totalAmount；若超出（默认场景下勾上充值卡）自动 cap 至 payableAmount
  //   - 线上（微信/支付宝）：禁止 staffApi 端写入 payments 流水；强制 0，由 payNotify 回调写
  const isOnlineMethod = paymentMethod === '微信' || paymentMethod === '支付宝'
  const sumItemReceived = Math.round(itemDataList.reduce((sum, d) => sum + d.received, 0) * 100) / 100
  let receivedAmount
  if (isOnlineMethod) {
    receivedAmount = 0
  } else {
    receivedAmount = Math.min(sumItemReceived, payableAmount)
    receivedAmount = Math.round(receivedAmount * 100) / 100
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
    // 生成 saleOrderId（内部独占 advisory_xact_lock(hashtext('sale_order_id_gen'))，
    // 锁持有到外层 COMMIT，闭合 TOCTOU）。同一事务内再次请求同 key 是 no-op（reentrant）
    saleOrderId = await generateOrderNo(undefined, client)

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

    // ========== PR-2 状态机落地 ==========
    // 线上支付（微信/支付宝）保留原 '待支付'（不写 payments，等 pay/alipayPay 回调）
    // 线下/储值卡/无：按 paid + prepaid 与 total 的比较落地
    //   paid + prepaid == 0                    → '待支付'（纯挂账，无 payments 行）
    //   0 < paid + prepaid < total_amount      → '部分支付'
    //   paid + prepaid == total_amount         → '待支付'（线下全额仍待店长 confirmOffline 入账；
    //                                              通过 payment_method='线下' 识别"已选线下、待确认"）
    // 全额储值卡抵扣（payable==0 且 prepaid>0）：无现金可收，事务内即时扣卡 + 结清。
    // 优先于线上判定——线上全额抵扣同样无需等 payNotify。
    const isFullCardCoverage = payableAmount === 0 && prepaidCardAmount > 0
    const settledAmount = Math.round((paidAmount + prepaidCardAmount) * 100) / 100
    let initialStatus
    if (isFullCardCoverage) {
      initialStatus = '已支付'
    } else if (isOnlineMethod) {
      initialStatus = '待支付'
    } else if (settledAmount === 0) {
      initialStatus = '待支付'
    } else if (settledAmount + 0.001 < totalAmount) {
      initialStatus = '部分支付'
    } else {
      initialStatus = '待支付'
    }
    // received 列：全额抵扣 = prepaid（已结清，与 '储值卡抵扣' 流水一致）；其余 = 本次现金 paidAmount。
    const receivedColumn = isFullCardCoverage ? prepaidCardAmount : paidAmount
    // paid_at 语义：payments 行已支付即"有钱到账"时间，冗余到 sale_orders.paid_at；
    // 挂账订单无入账 → NULL。线下全额 / 全额储值卡抵扣订单已结清，paid_at 落 now。
    const paidAtValue = (paidAmount > 0 || isFullCardCoverage) ? now : null
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id,
        sale_order_datetime, total_amount, client_user_id, client_phone, customer_name,
        payment_method, opened_by,
        preferred_employee_id, coupon_id, coupon_discount, remark,
        prepaid_card_amount, received, payable_amount, paid_at,
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
        prepaidCardAmount, receivedColumn, payableAmount,
        paidAtValue,
      ]
    )

    // 原子 claim 优惠券
    // 必须在 INSERT sale_orders 之后：user_coupons.used_sale_order_id → sale_orders.sale_order_id
    // 的 FK 非 deferrable（立即校验），早于 INSERT 会因引用的订单尚不存在而 FK 违约。
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
      const insRes = await client.query(
        `INSERT INTO sale_order_payments (
          sale_order_id, change_type, amount, payment_method, external_txn_id,
          status, source_end, operator_employee_id, note, created_at, paid_at
        ) VALUES ($1, '首次支付', $2, $3, NULL, '已支付', 'staff', $4, $5, $6, $6)
        ON CONFLICT (sale_order_id)
          WHERE change_type = '首次支付' AND status = '已支付'
        DO NOTHING
        RETURNING id`,
        [saleOrderId, paidAmount, paymentMethod, ctx.auth.staffWfId, '店长开单现场收款', now]
      )
      if (insRes.rows.length === 0) {
        throw new Error('CONFLICT: 订单已收款，请勿重复提交')
      }
    }

    // 创建订单明细
    for (let i = 0; i < itemDataList.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemDataList[i]

      // 家居产品无 session_count
      const sc = d.productType === '家居产品' ? null : d.sessionCount
      const rs = d.productType === '家居产品' ? null : d.remainingSessions

      await client.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction, sku_id,
          product_name, sku_spec_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee, is_shengmei, is_experience
        ) VALUES ($1, $2, $3, '购买', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          saleItemId, saleOrderId, storeId, d.skuId,
          d.productName, d.skuSpecName, d.productType,
          sc, rs,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount, d.received,
          d.salesCategory || null,
          d.serviceFee || 0,
          d.isShengmei ?? null,
          // is_experience 行级快照（capability 列，2026-04-26 ticket）：从 product_skus.is_experience
          // 拷贝；用于客户分类跃迁（per-order SUM FILTER WHERE si.is_experience）。
          d.isExperience === true,
        ]
      )
    }

    // 充值卡剥离 SKU 化（2026-05-20）后，order.create 不再处理充值卡明细——
    // 充值订单专用入口在 card.recharge（写 sale_orders type='充值单'，0 行 sale_items）。
    // 故 D4 混单守卫废除（migration 0043 同步拆触发器）。

    // 全额储值卡抵扣：事务内即时扣卡 + 写 '储值卡抵扣' 流水（与 confirmOffline 已支付分支对齐）。
    if (isFullCardCoverage) {
      await deductPrepaidCardAtCreation(client, {
        saleOrderId,
        clientUserId,
        amount: prepaidCardAmount,
        staffWfId: ctx.auth.staffWfId,
        note: '店长开单-储值卡全额抵扣',
        now,
      })
    }

    // paid_sessions 初始写入（ticket 2026-05-19）：基于 sale_orders.received + prepaid_card_amount
    // 按行级 floor 计算；部分支付订单 paid_sessions < session_count，限定后续 service.create 上限。
    await recalcPaidSessionsForOrder(client, saleOrderId)

    // 全额抵扣即结清：触发与 confirmOffline 已支付分支一致的结算副作用。
    if (isFullCardCoverage) {
      await settlePaidByCardAtCreation(client, {
        saleOrderId,
        clientUserId,
        receivedAmount: prepaidCardAmount,
        now,
      })
    }
  })

  // PR-2: status 与事务内 initialStatus 决策树保持一致
  //   全额储值卡抵扣 → '已支付'（创建即扣卡结清）；线上 → '待支付'；paid+prepaid=0 → '待支付'；
  //   部分 → '部分支付'；线下全额（现金）→ '待支付'（待店长 confirmOffline）
  const resolvedFullCardCoverage = payableAmount === 0 && prepaidCardAmount > 0
  const resolvedSettled = Math.round((paidAmount + prepaidCardAmount) * 100) / 100
  let resolvedStatus
  if (resolvedFullCardCoverage) {
    resolvedStatus = '已支付'
  } else if (isOnlineMethod) {
    resolvedStatus = '待支付'
  } else if (resolvedSettled === 0) {
    resolvedStatus = '待支付'
  } else if (resolvedSettled + 0.001 < totalAmount) {
    resolvedStatus = '部分支付'
  } else {
    resolvedStatus = '待支付'
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
            o.payment_method, o.paid_at, o.store_id, o.opened_by,
            o.total_amount, o.prepaid_card_amount, o.payable_amount
     FROM sale_orders o
     WHERE o.sale_order_id = $1`,
    [saleOrderId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 仅本店员工可查看：先 scope 守卫拒绝跨店；店员模式额外按 effectiveStoreId 限本店
  if (!isStoreInScope(ctx.auth, order.store_id)) {
    throw new Error('PERMISSION_DENIED: 订单不在当前门店范围内')
  }
  if (!ctx.auth.roles.includes('manager') && order.store_id !== ctx.auth.effectiveStoreId) {
    throw new Error('PERMISSION_DENIED: 无权查看该订单')
  }

  const items = await pg.query(`
    SELECT
      si.sale_item_id, si.received, si.product_name, si.sku_spec_name
    FROM sale_items si
    WHERE si.sale_order_id = $1
  `, [saleOrderId])

  // 订单应付金额取 sale_orders.total_amount（权威）：待支付订单 received 全为 0，
  // 不能用 sum(received) 否则金额显示为空（前端 totalAmount || '' 会把 0 吞成空串）
  const totalAmount = Number(order.total_amount || 0)

  // 推导二维码显示状态（UI-only 标签，不写库）
  //   待支付 + payment_method='线下' → 顾客已选线下，待店长确认收款（UI 标签 '待确认收款'）
  //   待支付 + 其它 → 等顾客扫码（'待扫码'）
  let qrCodeStatus
  if (['已支付', '已完成'].includes(order.status)) {
    qrCodeStatus = '已支付'
  } else if (order.status === '待支付' && order.payment_method === '线下') {
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
  // PR-2: 允许对 '待支付' / '部分支付' 订单确认收款
  if (!['待支付', '部分支付'].includes(order.status)) {
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
  // confirmAmount 默认 = 剩余应付现金 = payable_amount - 当前 received
  // payable_amount 旧订单可能 NULL，这里用 total - prepaid 兜底
  // 2026-04-26 sale-order-domain-refactor：paid_amount 列已 DROP，统一用 received
  const orderTotal = Number(order.total_amount || 0)
  const orderPrepaid = Number(order.prepaid_card_amount || 0)
  const orderReceived = Number(order.received || 0)
  const orderPayable = order.payable_amount != null
    ? Number(order.payable_amount)
    : Math.round((orderTotal - orderPrepaid) * 100) / 100
  const remainingPayable = Math.round((orderPayable - orderReceived) * 100) / 100

  let confirmAmount
  if (inputConfirmAmount === undefined || inputConfirmAmount === null) {
    confirmAmount = remainingPayable
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

  const newReceived = Math.round((orderReceived + confirmAmount) * 100) / 100
  const newSettled = Math.round((newReceived + orderPrepaid) * 100) / 100
  // 结清判定基准 = payable_amount + prepaid（顾客应付现金 + 储值卡抵扣），不用 total_amount。
  // 普通单 payable = total - prepaid，故 payable + prepaid === total（行为不变）；
  // 充值单 payable(实付 980) ≠ total(面额 1000)，须用 payable 否则永远判为部分支付。
  const settleTarget = Math.round((orderPayable + orderPrepaid) * 100) / 100
  const targetStatus = newSettled + 0.001 >= settleTarget ? '已支付' : '部分支付'

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
          `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
           VALUES ($1, '扣款', $2, $3, $4, NOW())
           ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
          [cardId, -prepaidAmount, saleOrderId, `card-deduct-${saleOrderId}`]
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
       SET status = $1, received = $2, paid_at = $3, updated_at = $4,
           offline_confirmed_by = $5, offline_confirmed_at = $4,
           allocation_status = COALESCE(allocation_status, '待分配'::allocation_status)
       WHERE sale_order_id = $6 AND status = $7`,
      [targetStatus, newReceived, paidAtValue, now, ctx.auth.staffWfId, saleOrderId, order.status]
    )
    if (updateResult.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 订单状态已变更，请刷新后重试')
    }

    if (confirmAmount > 0) {
      // change_type='首次支付' 时由 uq_sop_first_payment 兜底 TOCTOU；'回款' 不受影响
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
    }

    // 2026-05-21 单品合并：单品 1 年有效期自动赋值已移除（原在此按 product_type='单品' 写 expire_date）

    // 充值卡入账（2026-05-20 重构）：识别 sale_orders.sale_order_type='充值单'
    // 面值直接读 order.total_amount（充值单专属语义，sale_items 0 行）
    // 幂等键 'card-topup-{saleOrderId}'（与 payNotify 同源）
    // PR-2: 仅在本次转为 '已支付' 时触发入账（部分支付不入账）
    if (targetStatus === '已支付' && order.client_user_id && order.sale_order_type === '充值单') {
      const faceValue = Number(order.total_amount)
      if (faceValue > 0) {
        const dupCheck = await client.query(
          `SELECT 1 FROM card_transactions WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
          [saleOrderId]
        )
        if (dupCheck.rows.length === 0) {
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
            `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
             VALUES ($1, '充值', $2, $3, $4, NOW())
             ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
            [cardId, faceValue, saleOrderId, `card-topup-${saleOrderId}`]
          )
        }
      }
    }

    // paid_sessions 重算（ticket 2026-05-19）：received 增长 → paid_sessions 单调上升
    await recalcPaidSessionsForOrder(client, saleOrderId)

    // 重算顾客历史消费档位
    await refreshSpendingTier(client, order.client_user_id)
    // 重算顾客类型（只升不降）
    await recalcCustomerType(client, order.client_user_id)
    // 会员等级即时重算（只升不降；礼包留给 cron）
    await recalcMemberLevel(client, order.client_user_id, await getMemberThreshold(), 'staffApi')

    // 积分结算（订单链净额差值法，幂等）
    // confirmOffline 是店长确认线下收款的"状态转已支付/部分支付"入口（AC-04）；
    // 部分支付时 paid_amount 已累加，也要调用 settle 保持链上积分与实到账同步
    await settlePointsSafe(client, saleOrderId, 'staffApi.confirmOffline')

    // 分享礼：首单结清（'已支付' / '已完成'）时向邀请人 + 新客各发一张动态面值代金券 + 一条站内消息
    // 幂等由 grantShareGift 内部 INSERT ... ON CONFLICT 保证；失败不阻塞主事务（ticket §9.4），
    // 用 SAVEPOINT 隔离：分享礼异常回滚到 savepoint，不影响已完成的收款状态更新。
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
  })

  ctx.result = {
    saleOrderId,
    status: targetStatus,
    paidAt: targetStatus === '已支付' ? now : (order.paid_at || null),
    paidAmount: newReceived, // 向后兼容字段名（前端老代码读 paidAmount）
    received: newReceived,
    confirmAmount,
    remainingPayable: Math.round((orderPayable - newReceived) * 100) / 100,
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

  // scope 守卫
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

  // 2026-04-26 sale-order-domain-refactor：has_refund / has_pending_refund 从 sale_order_payments 推断
  const orders = await pg.query(`
    SELECT
      o.sale_order_id, o.status, o.sale_order_type, o.client_phone, o.customer_name,
      o.payment_method, o.preferred_employee_id,
      o.paid_at, o.created_at, o.opened_by, o.total_amount,
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
      si.paid_sessions,
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
  const paymentRows = await pg.query(
    `SELECT change_type, amount, payment_method, status,
            paid_at, created_at, note
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

// ========== P2: 退款 ==========
//
// 模型：
//   - 不创建 sale_orders[type='退款单'] 行；退款全部承载在 sale_order_payments
//   - 发起：INSERT sale_order_payments(change_type='退款', amount<0, status='待审批',
//           source_end='staff', operator_employee_id, refund_reason, ref_sale_item_id, session_count)
//   - 审批：CAS UPDATE sale_order_payments SET status='已支付' AND status='待审批'
//           同一条 UPDATE 写 audit_employee_id / audit_at / audit_remark
//           + UPDATE sale_orders.refunded_amount += ABS(amount)
//           + 5 通道 cascade（sa/sc/coupons/points/pickup）
//   - 驳回：CAS UPDATE sale_order_payments SET status='已作废' AND status='待审批'
//           + UPDATE details(audit_employee_id/audit_at/audit_remark)
//   - DB partial unique uq_sop_status_audit 兜底同原单 in-flight 退款唯一性
const { cascadeRefund } = require('../helpers/refund-cascade')

/**
 * 创建退款（店长专用）
 *
 * payload: {
 *   refSaleOrderId: string,                   // 原销售单号（必填）
 *   items: [{ saleItemId, refundQuantity, refundReason? }],   // 退款明细（按行）
 *   refundReason: string,                     // 退款原因
 *   handlingFee?: number                      // 手续费（可选）
 * }
 *
 * 返回：{ paymentIds: number[], status: '待审批', totalRefund, refundByCard, refundByOrigin, message }
 */
async function createRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { refSaleOrderId, items, refundReason, handlingFee } = ctx.event.payload || {}

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  if (!items || !Array.isArray(items) || items.length === 0) throw new Error('INVALID_PARAMS: 退款明细不能为空')
  if (!refundReason) throw new Error('INVALID_PARAMS: 退款原因不能为空')

  // scope 守卫
  await assertOrderInScope(pg, ctx.auth, refSaleOrderId)

  // 查原单 + 校验状态
  const origOrders = await pg.query(
    "SELECT * FROM sale_orders WHERE sale_order_id = $1 AND status IN ('已支付', '已完成', '部分支付')",
    [refSaleOrderId]
  )
  if (origOrders.length === 0) throw new Error('INVALID_PARAMS: 原订单状态不允许退款')
  const origOrder = origOrders[0]

  // in-flight 唯一性：同一原单仅允许一笔 '待审批' 退款（DB 上有 partial unique uq_sop_status_audit 兜底）
  const inflightRefunds = await pg.query(
    `SELECT id FROM sale_order_payments
      WHERE sale_order_id = $1 AND change_type = '退款' AND status = '待审批' LIMIT 1`,
    [refSaleOrderId]
  )
  if (inflightRefunds.length > 0) {
    throw new Error('CONFLICT: 存在未完结退款')
  }

  // 查原单明细（构建 + 校验未使用数量）
  const origItems = await pg.query(
    "SELECT * FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'",
    [refSaleOrderId]
  )

  const { refundDetails, totalRefund } = buildRefundDetails(origItems, items)

  const fee = Number(handlingFee) || 0
  const finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
  if (finalRefundAmount <= 0) {
    throw new Error('INVALID_STATE: 无可退项')
  }

  // 储值卡 vs 原路径拆分（按原单储值卡占比）
  const origPrepaidCardAmount = Number(origOrder.prepaid_card_amount || 0)
  const origTotalAmount = Number(origOrder.total_amount || 0)
  const { refundByCard, refundByOrigin } = splitRefundByOriginalPayment(
    finalRefundAmount,
    origPrepaidCardAmount,
    origTotalAmount,
  )

  // 退款原通道（微信/支付宝过渡期映射为 '线下'）
  const refundPaymentMethod = resolveRefundPaymentMethod(origOrder.payment_method)

  const now = new Date()
  let paymentId
  // 单行模型：partial unique uq_sop_status_audit 限制每订单仅允许 1 行 (change_type='退款',
  // status='待审批')。退款总额 = refundByCard + refundByOrigin 合计写入 amount=-finalRefundAmount，
  // payment_method 取原路径（refundPaymentMethod）；储值卡部分 vs 原路径部分的拆分以及 handling_fee
  // 等明细全部存入 note 字段（JSON）。审批通过时根据 payment_method 决定储值卡是否回冲。
  const detailNote = JSON.stringify({
    _v: 1,
    refundByCard,
    refundByOrigin,
    handlingFee: fee,
    refundPaymentMethod,
    items: refundDetails.map(d => ({
      refSaleItemId: d.refSaleItemId,
      quantity: d.quantity,
      refundAmount: d.refundAmount,
      productType: d.productType,
    })),
  })

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
        refundDetails[0]?.refSaleItemId || null,
        refundDetails[0]?.quantity || null,
        detailNote,
        now,
      ]
    )
    paymentId = sopRes.rows[0].id

    // 审计日志
    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('order.createRefund', 'sale_order_payment', $1, $2::jsonb, $3, NOW())`,
      [
        String(paymentId),
        JSON.stringify({
          _v: 1,
          saleOrderId: refSaleOrderId,
          finalRefundAmount,
          refundByCard,
          refundByOrigin,
          handlingFee: fee,
          operatorEmployeeId: ctx.auth.staffWfId,
        }),
        'staffApi',
      ]
    )
  })

  ctx.result = {
    paymentId,
    paymentIds: [paymentId],   // 兼容老前端字段名
    status: '待审批',
    totalAmount: -finalRefundAmount,    // 兼容老字段（旧代码读 totalAmount）
    totalRefund: finalRefundAmount,
    refundByCard,
    refundByOrigin,
    finalRefundAmount,
    refundPaymentMethod,
    message: '退款已发起，等待审批',
  }
}

/**
 * 审批退款（店长专用）
 *
 * payload: { paymentId: number, auditRemark?: string }
 *
 * 5 通道 cascade（详见 helpers/refund-cascade.js）：
 *   1. CAS UPDATE sale_order_payments status '待审批' → '已支付' + paid_at=NOW
 *      + 同一条 UPDATE 写审批人/时间/备注（已并入主表）
 *   2. UPDATE sale_orders.refunded_amount += ABS(amount) + updated_at
 *   3. 5 通道：sa 软删 / sc 软删 / coupons 回滚 / points 反向 / pickup 反推
 */
async function approveRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { paymentId, auditRemark } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  // 预查 + scope 校验（ctx.auth.effectiveStoreId 必须等于原单 store_id）
  const sopRows = await pg.query(
    `SELECT sop.id, sop.sale_order_id, sop.amount, sop.status, sop.payment_method,
            sop.refund_reason, sop.ref_sale_item_id, sop.session_count,
            so.store_id, so.client_user_id
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

  const refSaleOrderId = sopRow.sale_order_id
  const refundAbs = Math.abs(Number(sopRow.amount || 0))
  const now = new Date()

  await pg.transaction(async (client) => {
    // 1. CAS 翻转流水状态 + 同一条 UPDATE 写审批人/时间/备注（幂等哨兵）
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

    // 2. 累加 sale_orders.refunded_amount
    // CAS-EXEMPT: 仅累加资金列 refunded_amount，不翻 status
    await client.query(
      `UPDATE sale_orders
          SET refunded_amount = COALESCE(refunded_amount, 0) + $1, updated_at = $2
        WHERE sale_order_id = $3`,
      [refundAbs, now, refSaleOrderId]
    )

    // 3. 储值卡通道：仅当 payment_method='储值卡' 时回冲 prepaid_cards
    if (sopRow.payment_method === '储值卡' && sopRow.client_user_id && refundAbs > 0) {
      const dupCheck = await client.query(
        `SELECT 1 FROM card_transactions
           WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
        [`SOP-${paymentId}`]
      )
      if (dupCheck.rows.length === 0) {
        const newCardId = `FY-CARD-${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`
        const upsertRes = await client.query(
          `INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (user_id) DO UPDATE
             SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
           RETURNING card_id`,
          [newCardId, sopRow.client_user_id, refundAbs]
        )
        const cardId = upsertRes.rows[0].card_id
        await client.query(
          `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
           VALUES ($1, '充值', $2, $3, $4, NOW())
           ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
          [cardId, refundAbs, `SOP-${paymentId}`, `card-refund-${paymentId}`]
        )
      }
    }

    // 4. 5 通道 cascade
    const cascadeResult = await cascadeRefund(client, {
      saleOrderId: refSaleOrderId,
      saleItemId: sopRow.ref_sale_item_id,
      sessionCount: sopRow.session_count,
      refundReason: sopRow.refund_reason || '退款审批通过',
    })

    // 4.1 paid_sessions 重算（ticket 2026-05-19，D3=A）：refunded_amount 增长 → settled 下降
    // 若新 paid_sessions < 已消费次数(session_count - remaining_sessions)，抛 CONFLICT 阻止退款
    await recalcPaidSessionsForOrder(client, refSaleOrderId)

    // 5. 重算顾客消费档位 + 顾客类型
    if (sopRow.client_user_id) {
      await refreshSpendingTier(client, sopRow.client_user_id)
      await recalcCustomerType(client, sopRow.client_user_id)
      // 会员等级即时重算（只升不降；退款路径下消费降低 → rank 不增即跳过）
      await recalcMemberLevel(client, sopRow.client_user_id, await getMemberThreshold(), 'staffApi')
    }

    // 6. 写 operation_logs（审计）
    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('order.approveRefund', 'sale_order_payment', $1, $2::jsonb, $3, NOW())`,
      [
        String(paymentId),
        JSON.stringify({
          _v: 1,
          saleOrderId: refSaleOrderId,
          refundAbs,
          paymentMethod: sopRow.payment_method,
          auditEmployeeId: ctx.auth.staffWfId,
          cascade: cascadeResult,
        }),
        'staffApi',
      ]
    )

    // 注意：放弃旧的 settlePointsSafe 链式重算路径——cascadeRefund 内已写
    // point_transactions 反向流水 + 重算 customer_points.balance；二者职责重叠
    // 时优先 cascade（颗粒度更细：可关联具体 saleItemId）
  })

  ctx.result = {
    paymentId,
    status: '已支付',
    refundAbs,
    saleOrderId: refSaleOrderId,
    message: '退款已审批通过，5 通道已级联回滚',
  }
}

/**
 * 驳回退款（店长专用）
 *
 * payload: { paymentId: number, auditRemark?: string }  // auditRemark 即驳回原因
 */
async function rejectRefund(ctx) {
  await requireManager()(ctx, async () => {})

  const { paymentId, auditRemark, rejectedReason } = ctx.event.payload || {}
  if (!paymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')
  // rejectedReason 是历史前端字段名，兼容
  const remark = auditRemark || rejectedReason || ''

  const sopRows = await pg.query(
    `SELECT sop.id, sop.sale_order_id, sop.status, so.store_id
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

    // operation_logs 审计
    await client.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('order.rejectRefund', 'sale_order_payment', $1, $2::jsonb, $3, NOW())`,
      [
        String(paymentId),
        JSON.stringify({
          _v: 1,
          saleOrderId: sopRow.sale_order_id,
          auditEmployeeId: ctx.auth.staffWfId,
          rejectedReason: remark,
        }),
        'staffApi',
      ]
    )
  })

  ctx.result = { paymentId, status: '已作废', message: '退款已驳回' }
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

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  if (!paymentMethod) throw new Error('INVALID_PARAMS: 缺少 paymentMethod')
  if (!['微信', '线下', '储值卡'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式（仅支持 微信/线下/储值卡）')
  }

  // 微信扫码回款暂未实现（待业务接入微信扫码付款码链路）
  if (paymentMethod === '微信') {
    throw new Error('INVALID_PARAMS: 微信扫码回款暂未开放')
  }

  // 按子项回款明细（items[]）：每行可含现金 repayAmount + 储值卡 prepaidCardAmount，
  // 写带 ref_sale_item_id 的 payment 行（定向回款）。未传 items[] 退回订单级单行（ref=null，比例分摊），向后兼容。
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

  // 推导订单级 repayAmount / prepaidCardAmount：items[] 优先合计，否则取显式入参
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

  // 储值卡付款方式下不应再传 repayAmount>0（语义是纯储值卡回款）
  if (paymentMethod === '储值卡' && repayAmount > 0) {
    throw new Error('INVALID_PARAMS: 储值卡付款方式下不应传还款金额（应通过储值卡抵扣金额传递）')
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

  // 2026-04-26 sale-order-domain-refactor：不再创建 sale_orders[type='回款单'] 行；
  // 回款下沉至 sale_order_payments[change_type='回款']，原单 received 由聚合维护。
  // 因不再创建 FY-HKD 单据，card_transactions.ref_order_id 用 'REPAY-{refSaleOrderId}-{ts}' 编码
  const repayRefId = `REPAY-${refSaleOrderId}-${Date.now()}`

  const result = await pg.transaction(async (client) => {
    // 1) 锁原单 + 校验状态
    const lockRes = await client.query(
      'SELECT * FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE',
      [refSaleOrderId]
    )
    if (lockRes.rows.length === 0) throw new Error('INVALID_PARAMS: 原订单不存在')
    const locked = lockRes.rows[0]

    if (!['部分支付', '待支付'].includes(locked.status)) {
      throw new Error(`INVALID_STATE: 订单当前状态"${locked.status}"不允许回款`)
    }

    // 2) 计算欠款：payable_amount - received（储值卡已抵扣部分不占欠款）
    const origTotal = Number(locked.total_amount || 0)
    const origPrepaidSnapshot = Number(locked.prepaid_card_amount || 0)
    const origReceived = Number(locked.received || 0)
    const origPayable = locked.payable_amount != null
      ? Number(locked.payable_amount)
      : Math.round((origTotal - origPrepaidSnapshot) * 100) / 100
    const remainingPayable = Math.round((origPayable - origReceived) * 100) / 100

    // 3) 超额校验
    if (totalThisTime > remainingPayable + 0.001) {
      throw new Error('INVALID_PARAMS: 本次回款金额超过订单欠款')
    }

    // 3b) 按子项校验：逐项 (现金+储值卡) ≤ 该行可回款额(sale_amount - received)
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

    // 4) 储值卡抵扣：锁余额 → 扣减 → 写流水
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
        [cardId, -prepaidCardAmount, repayRefId, `card-repay-${repayRefId}`]
      )
    }

    // 5) 向原销售单写 payments 流水：'回款'(现金) + 可选 '储值卡抵扣'(储值卡)
    //    items[] → 逐子项写带 ref_sale_item_id 的行（定向回款，paid-sessions STEP 1 据此独立解锁该行）；
    //    否则订单级单行（ref=null，按比例分摊）。储值卡余额已在上方一次性扣减。
    const repayStatusRow = isOnlinePaymentMethod(paymentMethod) ? '待支付' : '已支付'
    const repayPaidAt = isOnlinePaymentMethod(paymentMethod) ? null : now
    if (repayItems) {
      for (const it of repayItems) {
        if (it.repayAmount > 0) {
          await client.query(
            `INSERT INTO sale_order_payments (
              sale_order_id, change_type, amount, payment_method, external_txn_id,
              status, source_end, operator_employee_id, ref_sale_item_id, note, created_at, paid_at
            ) VALUES ($1, '回款', $2, $3, NULL, $4, 'staff', $5, $6, $7, $8, $9)`,
            [refSaleOrderId, it.repayAmount, paymentMethod, repayStatusRow, ctx.auth.staffWfId, it.saleItemId, note || '店长发起回款', now, repayPaidAt]
          )
        }
        if (it.prepaidCardAmount > 0) {
          await client.query(
            `INSERT INTO sale_order_payments (
              sale_order_id, change_type, amount, payment_method, external_txn_id,
              status, source_end, operator_employee_id, ref_sale_item_id, note, created_at, paid_at
            ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'staff', $3, $4, $5, $6, $6)`,
            [refSaleOrderId, it.prepaidCardAmount, ctx.auth.staffWfId, it.saleItemId, '店长发起回款-储值卡抵扣', now]
          )
        }
      }
    } else {
      if (repayAmount > 0) {
        await client.query(
          `INSERT INTO sale_order_payments (
            sale_order_id, change_type, amount, payment_method, external_txn_id,
            status, source_end, operator_employee_id, note, created_at, paid_at
          ) VALUES ($1, '回款', $2, $3, NULL, $4, 'staff', $5, $6, $7, $8)`,
          [refSaleOrderId, repayAmount, paymentMethod, repayStatusRow, ctx.auth.staffWfId, note || '店长发起回款', now, repayPaidAt]
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
    }

    // 6) 重算原单 received / prepaid_card_amount（SUM payments 已支付行）+ status
    //    不变量：
    //      received           = Σ(amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
    //                            ※ 退款用 sale_orders.refunded_amount 单独记账，不并入 received
    //      prepaid_card_amount = Σ(amount WHERE status='已支付' AND change_type='储值卡抵扣')
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
    // 结清判定基准 = payable_amount + 原始 prepaid 快照（origPrepaidSnapshot）。
    // 用快照而非 newPrepaid：回款可新增储值卡抵扣，settled(含新抵扣) 增长应推进结清，
    // 故 RHS 须锚定原始 prepaid 才恒 == total。
    // 普通单 payable + 快照 === total（行为不变）；充值单 payable(实付) ≠ total(面额)，修正。
    const settleTarget = Math.round((origPayable + origPrepaidSnapshot) * 100) / 100
    const targetStatus = settled + 0.001 >= settleTarget ? '已支付' : '部分支付'

    // paid_at 语义：目标 '已支付' 时设为本次时间；部分支付保留原值
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

    // paid_sessions 重算（ticket 2026-05-19）：回款增长 → 解锁更多可消费次数
    await recalcPaidSessionsForOrder(client, refSaleOrderId)

    // 重算顾客消费档位 + 顾客类型（付清后累计消费可能跨阈值）
    await refreshSpendingTier(client, locked.client_user_id)
    await recalcCustomerType(client, locked.client_user_id)
    // 会员等级即时重算（只升不降；付清后累计消费可能跨档，礼包留给 cron）
    await recalcMemberLevel(client, locked.client_user_id, await getMemberThreshold(), 'staffApi')

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
    // 线下/储值卡直落，无需支付参数；微信分支已 reject
    paymentParams: null,
    status: '已支付', // 回款流水状态（线下直落）
    totalAmount: totalThisTime,
    // 兼容历史字段
    repaymentOrderId: null,    // 不再创建凭证单
    saleOrderId: refSaleOrderId,
    message: result.refStatus === '已支付' ? '回款成功，订单已付清' : '回款成功，订单仍部分支付',
  }
}

// ========== P2: 转换单 ==========

/**
 * 创建转换单（店长专用）
 *
 * 与 admin 侧 createConversionOrder 语义对齐：
 *   - 按 client_user_id + store_id 跨订单聚合候选卡（不再绑定单一原订单）
 *   - 整张卡折抵（疗程卡全部 remaining_sessions；单品已合并入疗程卡）
 *   - 差额>0：total_amount=差额，status='待支付'（线下走 confirmOffline 入账，线上走 payNotify）
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
    prepaidCardAmount: inputPrepaidCardAmount,
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
    throw new Error('INVALID_PARAMS: 支付方式仅支持 微信/线下')
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
  // convOrderId 在事务内由 generateOrderNo('FY-XSD-WX-', tx) 生成，保证 advisory lock
  // 持有窗口覆盖 SELECT MAX → INSERT 全程，闭合 TOCTOU
  let convOrderId

  const result = await pg.transaction(async (tx) => {
    // 生成 convOrderId（内部独占 advisory_xact_lock(hashtext('sale_order_id_gen'))）
    convOrderId = await generateOrderNo('FY-XSD-WX-', tx)

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
      // 2026-05-21 单品合并：折抵统一按 remaining_sessions（含原"体验卡单品"=1 次卡）；家居产品不可折抵
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
        isShengmei: row.is_shengmei ?? null,
        isExperience: row.is_experience === true,
      })
    }

    // 2. 转入项目 — 按 SKU 查询计价
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
      // 同 create：session_count 是"次"维度，需 × qty
      const inSessionCount = sku.session_count != null ? Number(sku.session_count) * qty : null
      const inDenom = (inSessionCount != null && inSessionCount > 0) ? inSessionCount : qty
      // per-session 单价（转入无折扣：unit_price = unit_real_price = amount / 总次数；非卡 = amount/qty）
      const inPerSessionUnit = inDenom > 0 ? Math.round((amount / inDenom) * 100) / 100 : amount
      inItems.push({
        skuId: sku.sku_id,
        productName: sku.spec_name,
        skuSpecName: sku.spec_name,
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

    // 储值卡抵扣（仅补差额 priceDiff > 0 时有效）：clamp 到 [0, priceDiff]。
    // payable = priceDiff - card；全额抵扣（payable==0 且 card>0）则事务内即时扣卡 + 结清。
    let card = 0
    if (priceDiff > 0 && inputPrepaidCardAmount != null) {
      const v = Number(inputPrepaidCardAmount)
      if (!Number.isFinite(v) || v < 0) throw new Error('INVALID_PARAMS: 储值卡抵扣金额必须为非负数')
      card = Math.min(Math.round(v * 100) / 100, priceDiff)
    }
    const payable = Math.max(0, Math.round((orderTotal - card) * 100) / 100)
    const isFullCardCoverage = card > 0 && payable === 0
    // 差额>0 且仍需付现金：'待支付'（线下走 confirmOffline，线上走 payNotify）；
    // 差额>0 全额抵扣 或 差额<=0：'已支付'
    const orderStatus = priceDiff > 0 ? (payable > 0 ? '待支付' : '已支付') : '已支付'
    const orderPaid = priceDiff <= 0 || isFullCardCoverage
    // 全额抵扣 payment_method 落 '无'（现金通道无需使用，与 order.create 对齐）
    const effectivePaymentMethod = isFullCardCoverage ? '无' : paymentMethod

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
        total_amount, payable_amount, prepaid_card_amount, received,
        payment_method, opened_by,
        preferred_employee_id, allocation_status, remark,
        paid_at, created_at, updated_at
      ) VALUES ($1, $2, '转换单', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, '待分配', $17, $18, $6, $6)`,
      [
        convOrderId, orderStatus, documentType, marketName, storeId, now,
        clientUserId, client.phone || null, client.name || null,
        orderTotal.toFixed(2), payable.toFixed(2), card.toFixed(2),
        (isFullCardCoverage ? card : 0).toFixed(2),
        effectivePaymentMethod, ctx.auth.staffWfId,
        preferredStaffWfId || null,
        remark || null,
        orderPaid ? now : null,
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

    // 6. 转出行 × N + 原子标记耗尽（疗程卡 remaining_sessions=0；单品已合并入疗程卡）
    for (const d of outItems) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq).padStart(4, '0')}`
      seq++
      await tx.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction, ref_sale_item_id,
          sku_id, product_name, sku_spec_name, product_type,
          session_count, unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee, is_shengmei, is_experience
        ) VALUES ($1, $2, $3, '转出', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          saleItemId, convOrderId, storeId, d.refSaleItemId,
          d.skuId, d.productName, d.skuSpecName, d.productType,
          d.sessionCount, d.unitPrice, d.quantity, d.unitRealPrice,
          -d.amount, -d.amount,
          d.salesCategory, d.serviceFee,
          d.isShengmei ?? null,
          // 转出行镜像原 sale_items.is_experience：负 received × is_experience=true 与原订单
          // trial_amount 累计自洽，避免跃迁 SQL 被误判（2026-04-26 ticket）。
          d.isExperience === true,
        ]
      )
      // 原子扣减原卡余量（幂等守卫：余量不足则 rowCount=0）
      // 单品合并后转出行恒为疗程卡，统一置 remaining_sessions=0
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

    // 7. 转入行 × M（新卡；unit_real_price = unit_price = per-session 单价 = amount/总次数；无折扣两者相等）
    for (const d of inItems) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq).padStart(4, '0')}`
      seq++
      await tx.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction,
          sku_id, product_name, sku_spec_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee, is_shengmei, is_experience
        ) VALUES ($1, $2, $3, '转入', $4, $5, $6, $7, $8, $8, $9, $10, $9, $11, $11, $12, $13, $14, $15)`,
        [
          saleItemId, convOrderId, storeId,
          d.skuId, d.productName, d.skuSpecName, d.productType,
          d.sessionCount,
          d.unitPrice, d.quantity, d.amount,
          d.salesCategory, d.serviceFee,
          d.isShengmei ?? null,
          // 转入行从 product_skus.is_experience 快照写入（2026-04-26 ticket）
          d.isExperience === true,
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
        `INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
         VALUES ($1, '充值', $2, $3, $4)
         ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
        [cardId, creditAmount.toFixed(2), convOrderId, `card-conv-${convOrderId}`]
      )
    }

    // 8b. 补差额全额抵扣（priceDiff > 0 且 payable==0）：事务内即时扣卡 + 写 '储值卡抵扣' 流水。
    //     与 8（负差额充值）互斥（全额抵扣要求 priceDiff > 0）。
    if (isFullCardCoverage) {
      await deductPrepaidCardAtCreation(tx, {
        saleOrderId: convOrderId,
        clientUserId,
        amount: card,
        staffWfId: ctx.auth.staffWfId,
        note: '店长转换单-储值卡全额抵扣',
        now,
      })
    }

    // paid_sessions 初始写入（ticket 2026-05-19）：转换单 total_amount=差额（可能=0），
    // 公式走 op.total_amount <= 0 → 兜底 = session_count（转入新卡视为全付获得）
    await recalcPaidSessionsForOrder(tx, convOrderId)

    // 全额抵扣即结清：触发与 confirmOffline 已支付分支一致的结算副作用。
    if (isFullCardCoverage) {
      await settlePaidByCardAtCreation(tx, {
        saleOrderId: convOrderId,
        clientUserId,
        receivedAmount: card,
        now,
      })
    }

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

/**
 * 查询顾客在当前门店可折抵的卡（转换单备选）
 *
 * payload: { clientUserId: string }
 * 返回: { cards: [{ saleItemId, sourceSaleOrderId, productName, skuSpecName, productType,
 *                    remainingSessions, remainingQuantity, unitRealPrice, deductibleAmount }] }
 *
 * 口径与 admin getCustomerHeldCards 保持一致（2026-05-21 单品合并后放开）：
 *   - 疗程卡（含原"体验卡单品"=1 次卡）：product_type='疗程卡' AND remaining_sessions > 0
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
 * 创建取货记录（家居产品提货）
 * payload: { saleItemId, pickupQuantity, remark? }
 */
async function createPickup(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { saleItemId, pickupQuantity, remark, idempotencyKey } = ctx.event.payload || {}
  if (!saleItemId) throw new Error('INVALID_PARAMS: 缺少 saleItemId')
  if (!pickupQuantity || pickupQuantity <= 0) throw new Error('INVALID_PARAMS: 取货数量必须大于0')

  // 幂等前置：若前端传 idempotencyKey 且已存在对应行，直接返回当前状态（不再 UPDATE/INSERT）
  // 配合 DB 层 uq_pickup_idempotency 兜底 sub-ms 并发
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

  let updated
  await pg.transaction(async (client) => {
    // 1) 原子累加 picked_up_quantity（强制本店）
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
      // 区分跨店 / 已提满 / 类型错误三种失败
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

    // 2) 查顾客信息
    const itemRows = await client.query(
      `SELECT si.sale_order_id, o.client_user_id
       FROM sale_items si JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
       WHERE si.sale_item_id = $1`,
      [saleItemId]
    )
    const clientUserId = itemRows.rows.length > 0 ? itemRows.rows[0].client_user_id : null

    // 3) 插入提货记录（DB 层 uq_pickup_idempotency 兜底 race；命中则整事务 rollback 防 UPDATE 重复累加）
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
  })

  ctx.result = {
    saleItemId,
    pickedUp: updated.picked_up_quantity,
    total: updated.quantity,
    remaining: updated.quantity - updated.picked_up_quantity,
    message: '取货成功',
  }
}

/**
 * 列出顾客可提货的家居产品销售明细
 *
 * 仅店长可调用（与 createPickup 鉴权一致）。
 */
async function availablePickupItems(ctx) {
  await requireManager()(ctx, async () => {})

  const { clientUserId } = ctx.event.payload || {}
  if (!clientUserId) throw new Error('INVALID_PARAMS: 缺少 clientUserId')

  const rows = await pg.query(
    `SELECT si.sale_item_id,
            si.sale_order_id,
            si.product_name,
            si.sku_spec_name AS spec_name,
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

/**
 * 提货记录分页列表
 *
 * 默认按 ctx.auth.effectiveStoreId 过滤本门店；admin 端的全量视图由 admin/pickup-records 提供。
 */
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
           si.sku_spec_name AS spec_name,
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

// ========== 辅助函数 ==========

/**
 * 生成订单号
 *
 * advisory lock 必须与最终 INSERT 在同一事务内才能闭合 TOCTOU 窗口。
 * 调用方必须传入外层事务的 client，函数内不再自开 pg.transaction。
 *
 * @param prefix 前缀，如 'FY-XSD-WX-', 'FY-TKD-WX-' 等
 * @param client 外层事务的 pg client（必传）
 */
async function generateOrderNo(prefix, client) {
  if (!client) {
    throw new Error('generateOrderNo: client is required (must be called inside an outer transaction)')
  }
  if (!prefix) prefix = 'FY-XSD-WX-'
  // dateStr 在事务内计算，避免跨午夜窗口（事务外算的 dateStr 可能落到上一日）
  const today = new Date()
  const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '')
  const likePattern = `${prefix}${dateStr}%`

  // 与 admin orders.ts 对齐：hashtext('sale_order_id_gen')
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

/**
 * 退款列表
 *
 * payload: { status?: '待审批'|'已支付'|'已作废', page?, pageSize? }
 * 数据源 = sale_order_payments[change_type='退款'] JOIN sale_orders（按 store_id scope）
 * 店长：看本店全部退款流水；非店长：看自己发起的（sop.operator_employee_id）
 */
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
      so.client_phone, so.customer_name,
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

/**
 * 退款详情
 *
 * payload: { paymentId: number }
 * 返回退款流水 + 原单概要 + 退款明细（来自 sop.note JSON）
 */
async function refundDetail(ctx) {
  await requireStaffBound()(ctx, async () => {})

  const { paymentId, saleOrderId } = ctx.event.payload || {}
  // 兼容老前端：saleOrderId 可能传成 paymentId 字符串（FY-TKD-XXX 时代）
  const queryPaymentId = paymentId || (typeof saleOrderId === 'number' ? saleOrderId : null)
  if (!queryPaymentId) throw new Error('INVALID_PARAMS: 缺少 paymentId')

  const sopRows = await pg.query(
    `SELECT
       sop.id AS payment_id, sop.sale_order_id, sop.amount, sop.status,
       sop.payment_method, sop.change_type, sop.created_at, sop.paid_at,
       so.store_id, so.client_user_id, so.client_phone, so.customer_name,
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

  // scope 校验
  if (r.store_id !== ctx.auth.effectiveStoreId) {
    throw new Error('PERMISSION_DENIED: 无权查看该退款')
  }
  // 非店长：仅允许查自己发起的退款
  if (!ctx.auth.roles.includes('manager') && r.operator_employee_id !== ctx.auth.staffWfId) {
    throw new Error('PERMISSION_DENIED: 无权查看该退款')
  }

  // 解析 detail_note JSON（含 refundByCard/refundByOrigin/items 拆分明细）
  let detail = null
  if (r.detail_note) {
    try {
      detail = typeof r.detail_note === 'string' ? JSON.parse(r.detail_note) : r.detail_note
    } catch (_) { detail = null }
  }

  // 退款明细补商品名：note JSON items 仅存 refSaleItemId/quantity/refundAmount/productType，
  // 这里按 refSaleItemId JOIN sale_items 取商品名/规格名
  const noteItems = detail && Array.isArray(detail.items) ? detail.items : []
  const itemIds = noteItems.map(it => it.refSaleItemId).filter(Boolean)
  const nameMap = {}
  if (itemIds.length > 0) {
    const siRows = await pg.query(
      `SELECT sale_item_id, product_name, sku_spec_name AS spec_name, product_type
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

// ========== B5: 寄存单（剩余次数初始化）==========

/**
 * 创建寄存单（店长专用）
 *
 * 寄存单是把"顾客在 WorkFine 上的剩余次数"初始化到小程序的特殊订单：
 *   - 复用 sale_orders + sale_items，可生成 service_orders 核销
 *   - 不收钱：received=0 / payable_amount=0 / total_amount=0 / payment_method='无' / status='已支付'
 *   - 拒绝任何抵扣（优惠券 / 储值卡 / 行级 customPrice）
 *   - 所有金额维度统计排除（dashboard / 提成 / 客单价）
 *   - 次数维度统计纳入（mgmt-product.cardHolders 持卡人数）
 *
 * payload: {
 *   clientUserId: string,
 *   items: [{ skuId: string, quantity?: number }],
 *   remark?: string,
 * }
 *
 * 拒绝字段（任一存在即报 INVALID_STATE: DEPOSIT_NO_DISCOUNT）:
 *   couponId, prepaidCardAmount, useCard, items[*].customPrice, items[*].discount
 */
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

  // 拒绝任何抵扣（统一二级前缀 DEPOSIT_NO_DISCOUNT）
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

  // 查顾客（client_identity_rule：仅看 bound_store_id，不要求 openid，
  // 因 WorkFine 老顾客可能没绑微信）
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

  // 拉 SKU 信息（参考 createConversion 的 SKU JOIN 模式）
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
    // 寄存单仅承载次数初始化语义，充值卡剥离 SKU 化（2026-05-20）后不再有充值 SKU 可入参
    const quantity = Number(item.quantity) || 1
    if (quantity <= 0) {
      throw new Error('INVALID_PARAMS: quantity 必须为正')
    }
    // 原价快照（供审计），不入 received
    const basePrice = Number(sku.special_price || sku.price)
    // session_count × quantity（与 order.create 一致）
    const sessionCount = sku.session_count != null
      ? Number(sku.session_count) * quantity
      : null
    const saleAmount = Math.round(basePrice * quantity * 100) / 100
    // per-session 单价：卡 = sale_amount/总次数；非卡 = sale_amount/quantity（per-unit 退化）
    const denom = (sessionCount != null && sessionCount > 0) ? sessionCount : quantity
    const perSessionUnit = denom > 0 ? Math.round((saleAmount / denom) * 100) / 100 : saleAmount
    return {
      skuId: item.skuId,
      productName: sku.spec_name,
      skuSpecName: sku.spec_name,
      productType: sku.product_type,
      productKind: sku.product_kind,
      sessionCount,
      remainingSessions: sessionCount,
      unitPrice: perSessionUnit,
      unitRealPrice: perSessionUnit,
      quantity,
      saleAmount,
      received: 0,
      salesCategory: sku.sales_category || null,
      serviceFee: 0,
      isShengmei: sku.is_shengmei ?? null,
      isExperience: sku.is_experience === true,
    }
  }))

  const now = new Date()
  let saleOrderId

  await pg.transaction(async (tx) => {
    // 订单号（advisory lock 防并发）
    saleOrderId = await generateOrderNo('FY-XSD-WX-', tx)

    // document_type：寄存单是把老顾客剩余次数初始化进来，固定 '售后'
    const documentType = '售后'

    // INSERT sale_orders —— 寄存单核心：金额全 0、status 直接已支付、payment_method='无'
    await tx.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id,
        sale_order_datetime, total_amount, client_user_id, client_phone, customer_name,
        payment_method, opened_by,
        preferred_employee_id, coupon_id, coupon_discount, remark,
        prepaid_card_amount, received, payable_amount, paid_at,
        allocation_status, created_at, updated_at
      ) VALUES ($1, '已支付', '寄存单', $2, $3, $4, $5, 0, $6, $7, $8, '无', $9,
                NULL, NULL, 0, $10, 0, 0, 0, $5,
                '待分配', $5, $5)`,
      [
        saleOrderId, documentType, marketName, storeId, now,
        clientUserId, client.phone || null, client.name || null,
        ctx.auth.staffWfId,
        remark || null,
      ]
    )

    // sale_item 流水号序列
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')
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

    // INSERT sale_items —— received=0；session_count/remaining_sessions 正常写
    for (let i = 0; i < itemDataList.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemDataList[i]
      const sc = d.productType === '家居产品' ? null : d.sessionCount
      const rs = d.productType === '家居产品' ? null : d.remainingSessions

      await tx.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction, sku_id,
          product_name, sku_spec_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee, is_shengmei, is_experience
        ) VALUES ($1, $2, $3, '购买', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $14, 0, $15, $16)`,
        [
          saleItemId, saleOrderId, storeId, d.skuId,
          d.productName, d.skuSpecName, d.productType,
          sc, rs,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount,
          d.salesCategory,
          d.isShengmei ?? null,
          d.isExperience,
        ]
      )
    }

    // paid_sessions 写入（ticket 2026-05-19）：寄存单 total_amount=0，公式走 op.total_amount <= 0
    // → paid_sessions = session_count（全付兜底），与"WorkFine 剩余次数初始化"语义一致
    await recalcPaidSessionsForOrder(tx, saleOrderId)

    // 审计日志
    await tx.query(
      `INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
       VALUES ('order.createDeposit', 'sale_order', $1, $2::jsonb, $3, NOW())`,
      [
        saleOrderId,
        JSON.stringify({
          _v: 1,
          clientUserId,
          itemCount: itemDataList.length,
          totalSessionCount: itemDataList.reduce(
            (acc, it) => acc + (it.sessionCount != null ? it.sessionCount : 0),
            0
          ),
          operatorEmployeeId: ctx.auth.staffWfId,
        }),
        'staffApi',
      ]
    )
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
