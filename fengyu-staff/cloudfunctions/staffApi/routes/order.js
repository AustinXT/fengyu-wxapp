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
const { assertOrderInScope, isStoreInScope, restrictToBoundEmployee, buildBundleMarketScopeFilter, buildNormalSkuMarketScopeFilter } = require('../utils/scope')
const { generateWxacode, uploadToCloudStorage } = require('../utils/wxacode')
const { getMemberThreshold } = require('../utils/config')
// 充值卡剥离 SKU 化（2026-05-20）：充值识别改为 sale_orders.sale_order_type='充值单'，
// 不再依赖虚拟 SKU ID 或 product_name 正则解析面值。
const { settlePointsSafe } = require('../utils/points')
const { recalcMemberLevel } = require('../utils/member-level')
const { isMember, resolveUnitPrice } = require('../utils/member-pricing')
const { recalcPaidSessionsForOrder, computePaidSessionsForItem } = require('../utils/paid-sessions')
const {
  capturePaymentAllocatables,
  refreshOrderAllocationRollup,
  reconcileAllocationStatusAfterRefund,
} = require('../utils/payment-allocatable')
const { getPerItemRefundedMap } = require('../utils/per-item-refund')
const {
  buildRefundDetails,
  capRefundAmounts,
  computeItemOverpayRemainders,
  computeOverpayRemainder,
  isHandlingFeeInvalidForRefund,
  isZeroCashPaidSessionRefund,
  splitRefundByOriginalPayment,
  resolveRefundPaymentMethod,
  assertNoPendingRefund,
  notifyRefundCreated,
  notifyRefundResult,
} = require('../utils/refund')
const { logOperation, logTransition } = require('../utils/operation-log')
const { shanghaiDateStr, shanghaiYMD, shanghaiYYMMDD } = require('../utils/datetime')

// 模块级缓存：saleOrderId → qrcodeUrl，避免轮询时重复生成
const qrcodeCache = new Map()

// 寄存单历史实收流水的 note 标记（change_type='回款' 行）。
// 编辑寄存单实收时按此标记删重建；与 admin 端 actions/orders.ts 字面量保持一致。
const DEPOSIT_RECEIPT_NOTE = '寄存单初始化实收'

// 寄存单疗程卡「实际单价按实付重算」SQL —— unit_real_price = 实付received / 总次数session_count。
// 实付=0 的行置 0（如实反映未收款，不再回落标价）；仅 product_type='疗程卡'，家居产品行(session_count NULL)被 WHERE 排除不受影响。
// ⚠️ 仅作为跨端 SQL 副本守护；staff 创建寄存单只提交审批，不在本端调用。
// admin 审批通过后必须 deposit-only + 严格在 recalcPaidSessionsForOrder 之后跑：
//   - 通用 recalc 对所有订单类型生效，普通欠款单 received<sale_amount 是常态，
//     若把此式并进 recalc 会腰斩所有欠款单的 per-session 价（腐蚀提成/退款/转换）。务必只在寄存单审批函数内调用，勿 DRY 进 helper。
//   - INSERT 时 received 写死 0，真实 per-row received 由 recalc STEP1 定向落定后才存在；提前跑会让每行误命中 ELSE。
// 与 admin actions/orders.ts recomputeDepositRealPrice 字节同义，cross-end-sql-snapshot.test.js 守护。marker: DEPOSIT_REAL_PRICE
const DEPOSIT_REAL_PRICE_RECALC_SQL = `UPDATE sale_items
      SET unit_real_price = CASE
            WHEN session_count > 0 AND received > 0
              THEN ROUND(received::numeric / session_count, 2)
            ELSE 0
          END,
          updated_at = NOW()
      WHERE sale_order_id = $1 AND item_direction = '购买' AND product_type = '疗程卡'
      -- DEPOSIT_REAL_PRICE`

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function calcTierLineAmount(tierAmount, tierSessions, lineSessions) {
  const amount = Math.max(0, Number(tierAmount) || 0)
  const sessions = Math.max(0, Number(tierSessions) || 0)
  const line = Math.max(0, Number(lineSessions) || 0)
  if (amount <= 0 || sessions <= 0 || line <= 0) return 0
  return Math.round((amount * line * 100) / sessions) / 100
}

function findPurchaseLimitViolation(items, skuRows) {
  const rowMap = new Map((skuRows || []).map(row => [row.skuId || row.sku_id, row]))
  const totals = new Map()
  for (const item of items || []) {
    if (!item || !item.skuId) continue
    totals.set(item.skuId, (totals.get(item.skuId) || 0) + Number(item.quantity || 0))
  }
  for (const [skuId, quantity] of totals.entries()) {
    const row = rowMap.get(skuId)
    const limit = row && row.purchaseLimit != null ? row.purchaseLimit : row?.purchase_limit
    if (limit != null && quantity > Number(limit)) return row
  }
  return null
}

function purchaseLimitExceededMessage(row) {
  const name = row.specName || row.spec_name || row.productName || row.skuId || row.sku_id
  const limit = row.purchaseLimit != null ? row.purchaseLimit : row.purchase_limit
  return `商品「${name}」每单最多可购买 ${limit} 件`
}

function treatmentTierGroupKey(row) {
  if (!row || !row.categoryId || !row.productName) return null
  return `${row.categoryId}::${row.productName}`
}

function applyTreatmentTierPricing(rawItems, tierSkuRows, buyerIsMember, saleOrderType) {
  // 销售单 + 转换单均需计算疗程卡梯度累加价（寄存单/内部单不计算）
  if (saleOrderType !== '销售单' && saleOrderType !== '转换单') return

  const groups = new Map()
  for (const item of rawItems || []) {
    const key = treatmentTierGroupKey(item)
    if (
      !key ||
      item.productType !== '疗程卡' ||
      item.isExperience ||
      item.manualSaleAmountOverride ||
      item.isManagerSpecial ||
      item.isBundleLine ||
      !item.sessionCount ||
      item.sessionCount <= 0
    ) {
      continue
    }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  for (const [key, groupedItems] of groups.entries()) {
    const [categoryId, productName] = key.split('::')
    const totalSessions = groupedItems.reduce((sum, item) => sum + (Number(item.sessionCount) || 0), 0)
    if (totalSessions <= 1) continue

    const candidates = (tierSkuRows || [])
      .filter(s =>
        s.category_id === categoryId &&
        s.spec_name === productName &&
        s.product_type === '疗程卡' &&
        s.is_manager_special !== true &&
        s.session_count != null &&
        Number(s.session_count) > 1 &&
        Number(s.session_count) <= totalSessions
      )
      .sort((a, b) => {
        const sessionDelta = Number(b.session_count) - Number(a.session_count)
        if (sessionDelta !== 0) return sessionDelta
        const aUnit = resolveUnitPrice(a, buyerIsMember).realUnit / (Number(a.session_count) || 1)
        const bUnit = resolveUnitPrice(b, buyerIsMember).realUnit / (Number(b.session_count) || 1)
        return aUnit - bUnit
      })

    const tier = candidates[0]
    if (!tier || !tier.session_count || Number(tier.session_count) <= 1) continue

    const tierAmount = resolveUnitPrice(tier, buyerIsMember).realUnit
    const tierSessions = Number(tier.session_count)
    for (const item of groupedItems) {
      const lineSessions = Number(item.sessionCount) || 0
      // 封顶语义：单行金额不得超过所匹配阶梯套餐总价（tierAmount）。
      // 当 lineSessions > tierSessions（如买 10 次、最优阶梯仅 8 次 ¥4000）时，
      // 线性外推 4000×10/8=5000 会超出套餐总价，须截断为 tierAmount。
      const lineAmount = Math.min(calcTierLineAmount(tierAmount, tierSessions, lineSessions), tierAmount)
      item.unitRealPrice = lineSessions > 0 ? roundMoney(lineAmount / lineSessions) : lineAmount
      item.saleAmount = lineAmount
      item.priceLine = lineAmount
      item.received = lineAmount
    }
  }
}

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
  // 修复（Bug N）：消费档位改用净额 SUM(GREATEST(received - refunded_amount, 0))，原毛额 total_amount 不减退款/欠款。
  // 与 admin refreshSpendingTierTx (refunds.ts) / cron refresh-spending-tier / payNotify 净额口径字面对齐。
  // 仅纳入"销售单 + 转换单"；充值单（预收）/ 内部单 / 寄存单不算消费。
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

/**
 * 根据已支付/已完成订单历史，重算顾客类型（只升不降）
 * 阈值从 system_configs.new_member_threshold 读取
 * 跃迁为"会员客"时同步写入 became_member_at = COALESCE(首笔达标单 paid_at, created_at)（非检测时刻 NOW()）。
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

  // 若本次 UPDATE 实际将顾客升级为“会员客”，became_member_at 记为确立会员资格的首笔达标单时间
  // （COALESCE(paid_at, created_at)；选单子查询与下方 is_membership_upgrade 归因同源、选同一单）。
  if (updateResult.rowCount > 0 && updateResult.rows[0].customer_type === '会员客') {
    await client.query(
      `UPDATE client_wechat_users SET became_member_at = (
         SELECT COALESCE(o.paid_at, o.created_at) FROM sale_orders o
         WHERE o.client_user_id = $1
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND o.total_amount >= $2
         ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC
         LIMIT 1
       ) WHERE user_id = $1`,
      [clientUserId, threshold]
    )
    // 给触发本次首次跃迁的达标销售单打会员升级标记（WHERE 与会员客判定 CASE 同源）。
    // 函数开头“已是会员客即 return”保证只在首次跃迁时执行一次；paid_at 最早 = 确立会员资格的首笔达标单。
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
  const ins = await client.query(
    `INSERT INTO sale_order_payments (
      sale_order_id, change_type, amount, payment_method, external_txn_id,
      status, source_end, operator_employee_id, note, created_at, paid_at
    ) VALUES ($1, '储值卡抵扣', $2, '储值卡', NULL, '已支付', 'staff', $3, $4, $5, $5) RETURNING id`,
    [saleOrderId, amount, staffWfId, note, now]
  )
  return ins.rows[0].id
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
 * 组合套餐校验（staff 独立副本）：
 * - 校验商品是套餐、子项归属、分组配额（全选=种类数 / 选N=数量合计）
 * - 返回 Map<skuId, {listPrice, salePrice}>（mall_product_skus 下沉副本：标价单价/成交价）；
 *   bundleProductId 为空返回 null（普通商品路径）
 *
 * 注：开单端（staff/admin）刻意不过滤 is_visible——"客户端展示"开关只应影响 client 商城是否上架，
 * 开单时所有套餐（含未上架商城的）都应可见可售。client `_loadAndValidateBundle` 仍保留 is_visible 过滤，
 * 此处是有意分叉，勿强行对齐。
 */
/**
 * 建单提交前复核受限的普通 SKU。体验卡与套餐子 SKU 保持既有路径：前者不受这里影响，
 * 后者由套餐主商品范围和归属校验负责。
 */
async function assertNormalSkuMarketScopeForCurrentStore(skuRows, auth, query = (text, params) => pg.query(text, params)) {
  const restrictedSkuById = new Map()
  for (const sku of skuRows) {
    if (sku.isExperience === true || sku.marketScope == null) continue
    restrictedSkuById.set(sku.skuId, sku)
  }
  if (restrictedSkuById.size === 0) return

  const skuIds = [...restrictedSkuById.keys()]
  const params = [skuIds]
  const marketScopeFilter = buildNormalSkuMarketScopeFilter(auth, params, 's')
  const result = await query(
    `SELECT s.sku_id
       FROM product_skus s
      WHERE s.sku_id = ANY($1)
        AND s.deleted_at IS NULL
        AND COALESCE(s.is_experience, false) = false
        ${marketScopeFilter}`,
    params,
  )
  const visibleRows = Array.isArray(result) ? result : (result.rows || [])
  const visibleSkuIds = new Set(visibleRows.map((row) => row.sku_id))
  const unavailable = skuIds.find((skuId) => !visibleSkuIds.has(skuId))
  if (!unavailable) return

  const sku = restrictedSkuById.get(unavailable)
  throw new Error(`INVALID_PARAMS: 商品 ${sku.specName || sku.productName || sku.skuId} 不适用于当前门店`)
}

async function _loadAndValidateBundle(bundleProductId, items, auth) {
  if (!bundleProductId) return null

  const productParams = [bundleProductId]
  // 独立实现，避免 staffApi 跨模块共享运行时代码；与 product.shopInit 同一 SQL 语义。
  const marketScopeFilter = buildBundleMarketScopeFilter(auth, productParams)
  const productRows = await pg.query(
    `SELECT p.product_id, p.is_bundle FROM products p
     WHERE p.product_id = $1 AND p.deleted_at IS NULL
       ${marketScopeFilter}`,
    productParams,
  )
  if (productRows.length === 0 || !productRows[0].is_bundle) {
    throw new Error('INVALID_PARAMS: BUNDLE_NOT_AVAILABLE: 套餐不存在、已删除或不适用于当前门店')
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

  // 2026-07-08 修复 T1：clientPhone / clientName 改为 let，下方会用客户档案权威覆写。
  // 前端 order-create.ts:1572 有 `name || phone` fallback 污染入参；后端以客户档案为权威。
  let clientPhone = payload.clientPhone
  let clientName = payload.clientName

  const storeId = ctx.auth.effectiveStoreId
  // market_name 在 INSERT 时以门店反查 org 树市场名为权威（子查询），此处仅备开单人快照作 COALESCE 兜底。
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
  // 2026-07-08 修复 T1：补 select phone, name —— 下方 let 覆写（line 466-467 客户档案权威覆盖）需要这俩字段
  const clientUsers = await pg.query(
    'SELECT user_id, bound_store_id, is_cross_store_temp, customer_type, member_level, phone, name FROM client_wechat_users WHERE phone = $1 LIMIT 1',
    [clientPhone]
  )
  if (clientUsers.length === 0 || !clientUsers[0].bound_store_id) {
    throw new Error('CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店')
  }
  // 非本店顾客禁止开单：账户级资产（余额/积分）可跨店查看，但出单按门店结算。
  // 例外（需求21，2026-06-24）：标记临时跨门店（is_cross_store_temp）的顾客允许被外店开单；
  // 订单仍按开单门店（effectiveStoreId）结算，标记每日 03:00 cron 重置。
  if (!isStoreInScope(ctx.auth, clientUsers[0].bound_store_id) && !clientUsers[0].is_cross_store_temp) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法开单')
  }
  const clientUserId = clientUsers[0].user_id
  // 会员价分流：会员客 或 有钻石等级即会员，决定普通单品成交价用会员价还是标价
  const buyerIsMember = isMember(clientUsers[0].customer_type, clientUsers[0].member_level)

  // 2026-07-08 修复 T1：顾客档案权威（client_wechat_users.phone/name）覆盖入参。
  // 前端 order-create.ts:1572 有 `name || phone` fallback（client_wechat_users.name 为空时
  // 把 phone 写入 clientName），后端在这里权威反查并覆写为客户档案的 phone/name。
  // sale_orders.customer_name/client_phone 是 denormalized 快照，此处保持单一权威源 = 客户档案。
  if (clientUsers[0].phone) clientPhone = clientUsers[0].phone
  if (clientUsers[0].name) clientName = clientUsers[0].name

  // 组合套餐：校验子项归属 + 分组配额，并取下沉单价（标价/成交）；非套餐返回 null
  const bundleSkuPrices = await _loadAndValidateBundle(bundleProductId, items, ctx.auth)

  // 获取 SKU 信息 + 价格（product_skus → product_categories 两表 JOIN）
  const rawItemDataList = await Promise.all(
    items.map(async (item) => {
      const skuRows = await pg.query(
        `SELECT s.sku_id, s.product_type, s.spec_name, s.price, s.special_price, s.session_count,
                s.category_id,
                s.service_fee, s.is_shengmei, s.is_experience, s.is_manager_special,
                s.purchase_limit, s.market_scope, pc.sales_category, pc.product_kind
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
      // sku 原始挂牌价（标价/划线价）：sale_items.unit_price 快照基线，恒为原价
      const skuPriceCeil = Number(sku.price)
      // 该顾客对本 SKU 的适用成交单价（会员价分流：会员→会员价、非会员→标价；体验卡同口径，#6=B 不再豁免）
      const applicableUnit = resolveUnitPrice(sku, buyerIsMember).realUnit
      const bundlePricing = bundleSkuPrices ? bundleSkuPrices.get(item.skuId) : null

      // 入参价格三件套
      let inputListUnit, inputRealUnit, useFrontendPrice
      if (saleOrderType === '内部单') {
        // ⚠️ 内部单 ½ 必须服务端权威：基于标价 price × 50%（不受会员价影响），忽略前端透传
        inputListUnit = skuPriceCeil
        inputRealUnit = Math.round(skuPriceCeil * 50) / 100
        useFrontendPrice = false
      } else {
        if (bundlePricing) {
          // 套餐子项：套餐价独立机制（本次不做会员分流）；上界/缺省用套餐下沉单价（标价/成交）
          const bundleListUnit = bundlePricing.listPrice != null ? Number(bundlePricing.listPrice) : skuPriceCeil
          const bundleSaleUnit = bundlePricing.salePrice != null ? Number(bundlePricing.salePrice) : bundleListUnit
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
          // 店长特别优惠（仅普通商品）：标价快照=原价；店长可在「适用价（会员价/标价）」之下手动改成交价。
          // 兼容前端传 unitRealPrice（单价）或 saleAmount（行总额），统一归一为成交单价后钳制 ≤ 适用价。
          const qtyForUnit = item.quantity || 1
          inputListUnit = skuPriceCeil
          inputRealUnit = item.unitRealPrice != null
            ? Number(item.unitRealPrice)
            : (item.saleAmount != null ? Number(item.saleAmount) / qtyForUnit : applicableUnit)
          if (!Number.isFinite(inputRealUnit) || inputRealUnit < 0
              || inputRealUnit > applicableUnit + 0.005) {
            throw new Error('INVALID_PARAMS: 应付单价不能高于该顾客适用价或为非法值')
          }
          useFrontendPrice = false  // priceLine 由后端按成交单价×数量算（含店长改价），不另信前端 saleAmount
        } else {
          // 普通商品：会员价分流后端权威定价，忽略前端透传单价（堵非会员套用会员价）
          inputListUnit = skuPriceCeil
          inputRealUnit = applicableUnit
          useFrontendPrice = false
        }
      }
      const unitPrice = inputRealUnit  // 进入后续 priceLine / 摊券逻辑（成交单价）

      sessionCount = sku.session_count != null ? Number(sku.session_count) : null

      const quantity = item.quantity || 1
      // sale_items.session_count / remaining_sessions 是"次"维度（service.complete 按次扣减），
      // 应 = sku.session_count × quantity；之前漏乘 quantity 导致剩余次数显示 1/1 而非 N/N
      if (sessionCount != null) sessionCount = sessionCount * quantity
      // priceLine = 行 pre-coupon 小计（订单级券摊算的基准），暂存为 saleAmount；摊券后再覆盖
      // 销售单：优先采纳前端 saleAmount（已是 pre-coupon = price × quantity）；缺省 fallback 后端算
      // 内部单：忽略前端，按后端 ½ 单价 × quantity
      const priceLine = (useFrontendPrice && item.saleAmount != null)
        ? Math.round(Number(item.saleAmount) * 100) / 100
        : Math.round(unitPrice * quantity * 100) / 100
      if (!Number.isFinite(priceLine) || priceLine < 0) {
        throw new Error('INVALID_PARAMS: 行小计金额非法')
      }
      // 防御：priceLine 不应超过 inputListUnit × quantity（防前端 saleAmount 反向超额）
      const listLineMax = Math.round(inputListUnit * quantity * 100) / 100
      if (priceLine > listLineMax + 0.005) {
        throw new Error('INVALID_PARAMS: 行小计金额不能高于标价小计')
      }

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
        categoryId: sku.category_id,
        productType: sku.product_type,
        productKind: sku.product_kind,
        sessionCount,
        remainingSessions: sessionCount,
        unitPrice,
        // listUnitPrice：sku 标价（per-card），用于 sale_items.unit_price 标价快照派生
        listUnitPrice: inputListUnit,
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
        marketScope: sku.market_scope,
        purchaseLimit: sku.purchase_limit != null ? Number(sku.purchase_limit) : null,
        manualSaleAmountOverride: item.manualSaleAmountOverride === true,
        isBundleLine: !!bundlePricing,
        // 店长特别优惠行级快照（权威 = DB，不信前端）
        isManagerSpecial: sku.is_manager_special === true,
      }
    })
  )

  if (!bundleSkuPrices) {
    await assertNormalSkuMarketScopeForCurrentStore(rawItemDataList, ctx.auth)
  }

  const purchaseLimitViolation = findPurchaseLimitViolation(items, rawItemDataList)
  if (purchaseLimitViolation) {
    throw new Error(`INVALID_PARAMS: PURCHASE_LIMIT_EXCEEDED: ${purchaseLimitExceededMessage(purchaseLimitViolation)}`)
  }

  const tierBaseItems = rawItemDataList.filter(d =>
    saleOrderType === '销售单' &&
    d.productType === '疗程卡' &&
    !d.isExperience &&
    !d.manualSaleAmountOverride &&
    !d.isManagerSpecial &&
    !d.isBundleLine &&
    d.categoryId &&
    d.productName
  )
  if (tierBaseItems.length > 0) {
    const categoryIds = [...new Set(tierBaseItems.map(d => d.categoryId))]
    const productNames = [...new Set(tierBaseItems.map(d => d.productName))]
    const tierSkuRows = await pg.query(
      `SELECT sku_id, category_id, product_type, spec_name, price, special_price, session_count,
              is_manager_special
       FROM product_skus
       WHERE deleted_at IS NULL
         AND is_enabled = true
         AND product_type = '疗程卡'
         AND COALESCE(is_experience, false) = false
         AND COALESCE(is_manager_special, false) = false
         AND category_id = ANY($1)
         AND spec_name = ANY($2)
         AND session_count IS NOT NULL`,
      [categoryIds, productNames]
    )
    applyTreatmentTierPricing(rawItemDataList, tierSkuRows, buyerIsMember, saleOrderType)
  }

  // ========== B2 拆行：疗程卡 quantity>1 → N 行 quantity=1 ==========
  // ticket: notes/tickets/archives/2026-05-18-single-session-card-quantity-not-split.md
  // 业务语义：每张卡（无论 sku.session_count 是 1 还是 N）都是独立可转换/核销的实体，
  // 应在 sale_items 写成 N 行（每行 quantity=1, session_count=sku.session_count）。
  // 家居产品（productType='家居产品'）继续合行（quantity 累加）。
  // 折扣/服务费/sale_amount 按 N 等分，最后一行吸收尾差，确保 sum 守恒。
  // inputReceived **不均分**：保留原 SKU group 总额，由后续裁剪步骤按 sku 内贪心填满分配，
  // 避免均分稀释导致 paid_sessions 误算为 0（净化美人付 800 应该解锁 1 次而非 0 次）。
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
          // received / unitRealPrice 由后续摊券+裁剪步骤计算
          received: saleAmountRow,
          unitRealPrice: saleAmountRow,
          // inputReceived 保留原 group 总额（所有拆出来的行都填同值；裁剪时 group-wise 贪心）
          inputReceived: d.inputReceived,
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
         WHERE s.store_id = $1 AND o.type = '门店'`,
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

  // 行 received 最终裁剪：按 sku_id 分组贪心填满（B2 拆行后同 SKU 多行共享同一 inputReceived 总额）
  // - 单行（家居/B2 未拆）：直接 min(inputReceived, saleAmount)
  // - 多行（B2 拆行的同 SKU group）：前几行先吃满 cap=saleAmount，最后行收剩余
  //   这样净化美人付 800、sale_amount=650/行 → 行 received = 650/150/0
  //   → paid_sessions = 1/0/0（净化美人 SKU 解锁 1 次）
  //   而非均分 266.67/行 → paid_sessions = 0 全部
  const skuGroups = new Map()  // sku_id → [d, d, d]（保持插入顺序）
  for (const d of itemDataList) {
    if (!skuGroups.has(d.skuId)) skuGroups.set(d.skuId, [])
    skuGroups.get(d.skuId).push(d)
  }
  for (const group of skuGroups.values()) {
    // group 内所有行的 inputReceived 都是同一原 SKU 总额（B2 拆行时复制；非拆行场景只有 1 行）
    const groupInputReceived = group[0].inputReceived
    if (groupInputReceived === null || groupInputReceived === undefined) {
      // 未传 received：每行 = saleAmount（满付）
      for (const d of group) d.received = d.saleAmount
    } else {
      let remainingCents = Math.round(Number(groupInputReceived) * 100)
      for (const d of group) {
        const capCents = Math.round(Number(d.saleAmount || 0) * 100)
        const takenCents = Math.max(0, Math.min(remainingCents, capCents))
        d.received = Math.round(takenCents) / 100
        remainingCents -= takenCents
      }
      // 若仍有剩余（inputReceived > Σ saleAmount，理论上已被 L597 priceLine 上界校验阻止），加到末行
      if (remainingCents > 0 && group.length > 0) {
        const last = group[group.length - 1]
        last.received = Math.round((last.received * 100 + remainingCents)) / 100
      }
    }
  }

  // per-session 派生（sale_amount 为权威行总额）：
  //   unit_real_price = 卡? round(sale_amount/session_count) : round(sale_amount/quantity)（非卡 per-unit 退化）
  //   unit_price      = 卡? round(标价行总额/session_count) : per-unit 标价；
  //                      标价行总额 = (sku 标价 listUnitPrice) × quantity（不受成交价/套餐价影响，保留"标价快照"语义）
  for (const d of itemDataList) {
    const denom = (d.sessionCount != null && d.sessionCount > 0) ? d.sessionCount : (d.quantity || 1)
    const listBase = Number(d.listUnitPrice != null ? d.listUnitPrice : d.unitPrice || 0)
    const listTotalRow = Math.round(listBase * (d.quantity || 1) * 100) / 100
    d.unitRealPrice = denom > 0 ? Math.round((Number(d.saleAmount || 0) / denom) * 100) / 100 : Number(d.saleAmount || 0)
    d.unitPrice = denom > 0 ? Math.round((listTotalRow / denom) * 100) / 100 : listTotalRow
  }

  const now = new Date()
  // saleOrderId 在事务内由 generateOrderNo(undefined, client) 生成，保证 advisory lock
  // 持有窗口覆盖 SELECT MAX → INSERT 全程，闭合 TOCTOU
  let saleOrderId
  // 订单应付合计 = Σ 行应付小计（saleAmount 已含订单级优惠券摊算）
  const totalAmount = Math.round(itemDataList.reduce((sum, d) => sum + d.saleAmount, 0) * 100) / 100
  // 当下实付合计 = Σ 行实付（欠款场景下店长逐行下调；默认 = 应付）。充值卡从「当下实付」里抵，
  // 故预选上界 + 现金口径都以此为基线（见下方 maxPrepayable / confirmOffline）。
  const sumItemReceived = Math.round(itemDataList.reduce((sum, d) => sum + d.received, 0) * 100) / 100

  // ========== 充值卡预选（店长开单 = 预选，不扣卡；DB 字段 prepaid_card_amount 命名保持不变）==========
  // 仅显式输入抵扣金额时查询余额（不加 FOR UPDATE，因为开单预选不写 balance）。
  // useCard=true 但未传金额按 0 处理，避免沿用旧版的自动抵满行为。
  let prepaidCardAmount = 0
  if (useCard && inputPrepaidCardAmount !== undefined && inputPrepaidCardAmount !== null) {
    // 预选额上限 = min(应付合计, 当下实付)：充值卡从「当下实付」里抵，欠款单不得抵超过当下实付
    // （无欠款时 sumItemReceived === totalAmount，等价旧口径）。与前端 recompute 基准 receivedTotal 对齐。
    const maxPrepayable = Math.min(totalAmount, sumItemReceived)
    const inputAmount = Number(inputPrepaidCardAmount)
    if (!Number.isFinite(inputAmount) || inputAmount < 0) {
      throw new Error('INVALID_PARAMS: 充值卡抵扣金额必须为非负数')
    }
    prepaidCardAmount = Math.round(inputAmount * 100) / 100
    if (prepaidCardAmount > maxPrepayable + 0.001) {
      throw new Error('INVALID_PARAMS: 充值卡抵扣金额超过应抵上限')
    }
    if (prepaidCardAmount > 0) {
      const balanceRows = await pg.query(
        'SELECT balance FROM prepaid_cards WHERE user_id = $1',
        [clientUserId]
      )
      const currentBalance = balanceRows.length > 0 ? Number(balanceRows[0].balance) : 0
      if (currentBalance + 0.001 < prepaidCardAmount) {
        throw new Error('INSUFFICIENT_BALANCE: 充值卡余额不足')
      }
    }
  }

  // ========== 款项流水（sale_order_payments）语义 ==========
  // payable_amount = total - prepaid_card_amount（整单生命周期"应收现金"冗余列，含未来回款的欠款部分）。
  //   本单当下应收现金 = 当下实付 − 卡 = sumItemReceived − prepaid（由 confirmOffline 默认收取）；
  //   欠款 = total − 当下实付，经 createRepayment 回款累加进 received 直到 received = payable 结清。
  //   故此处保持 total − prepaid 不变（勿改成 当下实付 − prepaid，否则欠款单会被误判为已结清）。
  const payableAmount = Math.round((totalAmount - prepaidCardAmount) * 100) / 100
  // zeroPayable：应付实金 = 0（券全额抵扣 / 储值卡全额抵扣 / 二者叠加把应付抵到 0）。
  // 无款可付，创建即结清为'已支付'，否则卡在'待支付'死循环（0 元发不起线上支付、
  // payment_method='无' 也走不了 confirmOffline）。isFullCardCoverage（含储值卡）是其子集。
  const zeroPayable = payableAmount === 0

  // receivedAmount（本次现场实收）= Σ 行实付（前端传入，默认 = 行应付）
  //   - 充值卡抵扣 + 行实付汇总 不应超过 totalAmount；若超出（默认场景下勾上充值卡）自动 cap 至 payableAmount
  //   - 线上（微信/支付宝）：禁止 staffApi 端写入 payments 流水；强制 0，由 payNotify 回调写
  const isOnlineMethod = paymentMethod === '微信' || paymentMethod === '支付宝'
  let receivedAmount
  if (isOnlineMethod) {
    receivedAmount = 0
  } else {
    receivedAmount = Math.min(sumItemReceived, payableAmount)
    receivedAmount = Math.round(receivedAmount * 100) / 100
  }

  // 两步式（2026-06-07 修 P0「待支付可消费疗程卡」）：开单一律不收现金、不写"已支付"流水。
  //   线下/储值卡：实收改由店长 confirmOffline「确认收款」入账；线上：payNotify 回调入账。
  //   receivedAmount（逐行实付汇总）仅作 pending_received 草稿存档，不进 sale_orders.received。
  //   例外：zeroPayable（券/卡全额抵扣，payable=0）无现金可收，仍创建即结清（下方扣卡 + recalc）。
  const paidAmount = 0

  // effectivePaymentMethod 仅影响 sale_orders.payment_method 展示（与原逻辑对齐）：
  //   - 应付实金=0（券/卡全额抵扣，payable_amount=0）→ '无'（现金通道无需使用）
  //   - 其他：保留前端传入的 paymentMethod
  let effectivePaymentMethod
  if (zeroPayable) {
    effectivePaymentMethod = '无'
  } else {
    effectivePaymentMethod = paymentMethod
  }

  // ========== 计算 document_type（售前/售后快照） ==========
  // 仅按下单时会员身份判：售前=非会员客，售后=会员客。「成为会员那一单」下单时仍非会员客 → 售前。
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

  await pg.transaction(async (client) => {
    // 按顾客串行化开单（advisory lock 持有到 COMMIT）：uq 拆除员工单 DB 兜底后，业务守卫
    // SELECT-then-INSERT 非原子，并发开单可产生重复员工单。pg_advisory_xact_lock(hashtext($1))
    // 让同顾客开单串行，existing 守卫在此锁下原子生效。业务守卫查顾客维度全量待支付单（含自助单），
    // advisory lock 串行化并发；DB uq 仅兜底 opened_by IS NULL 自助单。
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [clientUserId])
    const existing = await client.query(
      "SELECT sale_order_id FROM sale_orders WHERE client_user_id = $1 AND status = '待支付' LIMIT 1",
      [clientUserId]
    )
    if (existing.rows.length > 0) {
      throw new Error('INVALID_PARAMS: 该顾客已有待支付订单，请先完成或关闭原订单')
    }

    // 生成 saleOrderId（内部独占 advisory_xact_lock(hashtext('sale_order_id_gen'))，
    // 锁持有到外层 COMMIT，闭合 TOCTOU）。同一事务内再次请求同 key 是 no-op（reentrant）
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

    // ========== PR-2 状态机落地 ==========
    // 线上支付（微信/支付宝）保留原 '待支付'（不写 payments，等 pay/alipayPay 回调）
    // 线下/储值卡/无：按 paid + prepaid 与 total 的比较落地
    //   paid + prepaid == 0                    → '待支付'（纯挂账，无 payments 行）
    //   0 < paid + prepaid < total_amount      → '部分支付'
    //   paid + prepaid == total_amount         → '待支付'（线下全额仍待店长 confirmOffline 入账；
    //                                              通过 payment_method='线下' 识别"已选线下、待确认"）
    // 零应付（payable==0：券全额 / 储值卡全额 / 二者叠加）：无现金可收，创建即结清。
    // 优先于线上判定——线上零应付同样无需等 payNotify。isFullCardCoverage 是其"含储值卡"子集，
    // 仅用于"是否需要事务内扣卡 + recalc"分支（券全额 card=0 无卡可扣、走 per-item 摊次）。
    const isFullCardCoverage = payableAmount === 0 && prepaidCardAmount > 0
    // 两步式（2026-06-07 修 P0）：开单不收款（paidAmount=0），非 zeroPayable 一律 '待支付'，
    // 由 confirmOffline（线下/储值卡）/ payNotify（线上）入账翻态（'部分支付'/'已支付'）。
    // zeroPayable（券/卡全额抵扣）无现金可收、create 内即扣卡结清，落 '已支付'。
    const initialStatus = zeroPayable ? '已支付' : '待支付'
    // received 列：零应付 = prepaid（券全额时 prepaid=0 → received=0；卡全额时 = 卡额，与 '储值卡抵扣' 流水一致）；
    // 其余 = 本次现金 paidAmount。
    const receivedColumn = zeroPayable ? prepaidCardAmount : paidAmount
    // paid_at 语义：payments 行已支付即"有钱到账"时间，冗余到 sale_orders.paid_at；
    // 挂账订单无入账 → NULL。线下全额 / 零应付（券/卡全额抵扣）订单已结清，paid_at 落 now。
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

    // ========== 两步式（2026-06-07 修 P0「待支付可消费疗程卡」）：开单不写收款流水 ==========
    // 线下/储值卡的现金实收由店长 confirmOffline「确认收款」入账（写 '首次支付'/已支付流水 + 翻态 + recalc）；
    // 线上（微信/支付宝）由 payNotify 回调入账。开单时一律不写 '已支付' payments 行（received=0、paid_sessions=0，
    // 杜绝未付款消费）。储值卡抵扣的 prepaid_card_amount 仅作"预选"，真正扣卡 + 写 '储值卡抵扣' 流水：
    //   - zeroPayable（券/卡全额抵扣）：下方 deductPrepaidCardAtCreation 在 create 事务内即扣即结清；
    //   - 非 zeroPayable（部分储值卡 + 待付现金）：由 confirmOffline 扣卡（staffApi 唯一扣卡点，见 CLAUDE.md）。

    // 创建订单明细
    for (let i = 0; i < itemDataList.length; i++) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq + i).padStart(4, '0')}`
      const d = itemDataList[i]
      // 暂存 saleItemId 到行数据，供后续按行直写 paid_sessions 引用
      d.saleItemId = saleItemId

      // 家居产品无 session_count
      const sc = d.productType === '家居产品' ? null : d.sessionCount
      const rs = d.productType === '家居产品' ? null : d.remainingSessions

      // 行级 received 开单一律写 0（资金铁律：received/paid_sessions 只认 status='已支付' 流水）；
      // 由下方 recalcPaidSessionsForOrder STEP1 从 sale_orders.received 派生（待支付=0；zeroPayable=prepaid 分摊）。
      // 逐行实付草稿（d.received）落 pending_received，仅作确认收款入账参考，不进 received/paid_sessions。
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
          // is_experience 行级快照（capability 列，2026-04-26 ticket）：从 product_skus.is_experience
          // 拷贝；用于客户分类跃迁（per-order SUM FILTER WHERE si.is_experience）。
          d.isExperience === true,
          // is_manager_special 行级快照：从 product_skus.is_manager_special 拷贝（权威 = DB）
          d.isManagerSpecial === true,
        ]
      )
    }

    // 充值卡剥离 SKU 化（2026-05-20）后，order.create 不再处理充值卡明细——
    // 充值订单专用入口在 card.recharge（写 sale_orders type='充值单'，0 行 sale_items）。
    // 故 D4 混单守卫废除（migration 0043 同步拆触发器）。

    // 全额储值卡抵扣：事务内即时扣卡 + 写 '储值卡抵扣' 流水（与 confirmOffline 已支付分支对齐）。
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

    // 按回款逐笔分配：全额储值卡抵扣即结清 → 捕获本次抵扣逐项可分配额 + 置待分配 + 汇总刷新（非定向）
    // 必须在 recalcPaidSessionsForOrder 之前：新 STEP1 从 receipt 聚合 received。
    if (fullCardPaymentId && prepaidCardAmount > 0) {
      await capturePaymentAllocatables(client, {
        salePaymentId: fullCardPaymentId,
        saleOrderId,
        eventAmount: prepaidCardAmount,
        directedItems: null,
      })
      await refreshOrderAllocationRollup(client, saleOrderId)
    }

    // paid_sessions 统一由 recalcPaidSessionsForOrder 派生（STEP1 从 receipt 聚合 received → STEP2 floor）：
    // - zeroPayable（券/卡全额抵扣）：received=prepaid 或 sale_amount<=0 兜底 → paid_sessions=session_count（创建即结清）
    // - 非 zeroPayable（待支付，received=0）：行级 received=0 → paid_sessions=0（杜绝未付款消费）
    // 不再按行级实付草稿 computePaidSessionsForItem 直算（与 admin createOrder 对齐修 P0；
    // 行级实付草稿现落 sale_items.pending_received，由 confirmOffline/payNotify 入账后才驱动 received→paid_sessions）。
    await recalcPaidSessionsForOrder(client, saleOrderId)

    // 零应付即结清：触发与 confirmOffline 已支付分支一致的结算副作用（档位/客户分类/会员/积分/分享礼）。
    // 券全额单 receivedAmount=prepaidCardAmount=0 → 积分链净额=0 无写入、grantShareGift 自带 paid>0 门控跳过。
    if (zeroPayable) {
      await settlePaidByCardAtCreation(client, {
        saleOrderId,
        clientUserId,
        receivedAmount: prepaidCardAmount,
        now,
      })
    }
    // 审计日志
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

  // status 与事务内 initialStatus 一致（两步式）：zeroPayable（券/卡全额抵扣）→ '已支付'（创建即结清）；
  // 其余开单 → '待支付'（线下/储值卡待 confirmOffline、线上待 payNotify 入账翻态）。
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

  // 仅本店员工可查看：先 scope 守卫拒绝跨店；店员模式额外按 effectiveStoreId 限本店
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

  // 订单应付金额取 sale_orders.total_amount（权威）：待支付订单 received 全为 0，
  // 不能用 sum(received) 否则金额显示为空（前端 totalAmount || '' 会把 0 吞成空串）
  const totalAmount = Number(order.total_amount || 0)

  // 实际需支付金额（付款码顶部展示给顾客扫码）
  const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
  let actualPayable
  if (order.status === '部分支付') {
    // 回款场景：剩余欠款 = 应付实金 − 净到账（received − refunded）
    const payable = Number(order.payable_amount || 0) > 0
      ? Number(order.payable_amount)
      : Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)
    const netReceived = Math.round((Number(order.received || 0) - Number(order.refunded_amount || 0)) * 100) / 100
    actualPayable = Math.max(0, Math.round((payable - netReceived) * 100) / 100)
  } else if (order.sale_order_type === '充值单' || order.sale_order_type === '转换单') {
    // 充值卡单（card.recharge，0 行 sale_items）/ 转换单（sale_items 未写 pending_received，默认 0）：
    // 不能走逐行 pending_received（恒为 0 会让二维码显示 ¥0），待支付额直接取订单应付金额。
    // payable_amount 已扣储值卡（充值卡单=实付/prepaid=0；转换单=max(0,priceDiff−储值卡)），不再减 prepaidCardAmount；
    // payable_amount 缺失（历史/迁移数据）时回退 total−储值卡，与部分支付分支对称，避免静默 ¥0。
    const payable = Number(order.payable_amount || 0) > 0
      ? Number(order.payable_amount)
      : Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)
    actualPayable = Math.max(0, Math.round(payable * 100) / 100)
  } else {
    // 待支付（首付）= Σ各商品明细实付 − 储值卡抵扣
    // 两步式开单 sale_items.received=0（开单不记账），故用 pending_received（逐行实付草稿）作为「商品实付」口径
    const sumItemReal = items.reduce(
      (s, i) => s + Number(i.pending_received != null ? i.pending_received : (i.sale_amount || 0)),
      0
    )
    actualPayable = Math.max(0, Math.round((sumItemReal - prepaidCardAmount) * 100) / 100)
  }

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
  } else if (order.status === '部分支付') {
    // 回款：等顾客扫码付剩余应付（仍走扫码态，便于轮询到账；不显示线下确认按钮）
    qrCodeStatus = '待扫码'
  } else {
    qrCodeStatus = order.status
  }

  // 待支付（首付）/ 部分支付（回款）订单生成小程序码（带缓存；scene=saleOrderId 与状态无关，可复用）
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
    `SELECT si.sale_item_id, si.sku_id, si.received, si.pending_received, si.product_type
     FROM sale_items si
     WHERE si.sale_order_id = $1`,
    [saleOrderId]
  )

  const totalReceived = items.reduce((s, i) => s + Number(i.received || 0), 0)
  // 两步式（2026-06-07）：开单约定实付草稿合计（pending_received），作 confirmAmount 缺省依据，
  // 使店长「一键确认」收的是开单约定的实付（含折扣/首付），而非全额应付。
  const pendingTotal = Math.round(items.reduce((s, i) => s + Number(i.pending_received || 0), 0) * 100) / 100

  // ========== 本次确认收款金额 + 目标订单状态 ==========
  // confirmAmount 默认（两步式 2026-06-07）= 当下应收现金 = 当下实付 − 储值卡 − 已收，cap 到剩余应付现金：
  //   - 无折扣（pending_received=应付）：缺省 = remainingPayable（全额，行为不变）；
  //   - 有折扣/首付（pending_received<应付）：缺省 = 约定实付 − 卡 − 已收（避免一键确认多收）；
  //   - 无草稿（旧订单 pending_received=0）：回退全额 remainingPayable。
  // ⚠️ 充值卡从「当下实付」里抵：现金 = pending − prepaid（而非 pending 全当现金再叠加扣卡，
  //    否则欠款+卡订单会多收一笔卡额）。外层 max(0,…) 兜底 pending < prepaid 边缘（卡只抵到 pending）。
  // 店长可显式传 confirmAmount 覆盖。payable_amount 旧订单 NULL 时用 total - prepaid 兜底。
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

  // 结清判定基准 = payable_amount + prepaid（顾客应付现金 + 储值卡抵扣），不用 total_amount。
  // 普通单 payable = total - prepaid，故 payable + prepaid === total（行为不变）；
  // 充值单 payable(实付 980) ≠ total(面额 1000)，须用 payable 否则永远判为部分支付。
  const settleTarget = Math.round((orderPayable + orderPrepaid) * 100) / 100
  // received / targetStatus 的权威值由事务内「从流水重聚合」产出（维护 I1：received = Σ[首次支付/回款/储值卡抵扣]，
  // 跨端字面对齐 admin confirmOfflinePayment）。原 orderReceived+confirmAmount 漏算储值卡抵扣，会让
  // recalcPaidSessionsForOrder 把缺卡的 received 按 pending_received 比例摊到各行 → sale_items.received 被现金比例稀释。
  let newReceived = 0
  let targetStatus = '部分支付'

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
    // 回款事件主流水行 id（现金行优先；纯储值卡则取储值卡抵扣行）—— 按回款逐笔分配的归属键
    let cashPaymentId = null
    let cardPaymentId = null
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

    // ========== PR-2: 现金流水（首次支付/回款）：先落流水，再由流水聚合 received（维护 I1）==========
    // change_type='首次支付' 时由 uq_sop_first_payment 兜底 TOCTOU；'回款' 不受影响。
    // 必须在「从流水重聚合 received」之前 INSERT，否则本次现金不进聚合。
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

    // ========== 从流水重聚合 received / prepaid_card_amount（跨端字面对齐 admin confirmOfflinePayment + staff createRepayment）==========
    // 不变量：
    //   received            = Σ(amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))  → I1
    //   prepaid_card_amount = Σ(amount WHERE status='已支付' AND change_type='储值卡抵扣')                        → I5 配套
    // 含储值卡抵扣流水 → 维护 I1（原 orderReceived+confirmAmount 漏卡，致后续 STEP1 把缺卡的 received 按
    // pending_received 比例摊到各行 → sale_items.received 被现金比例稀释）。幂等：储值卡/现金流水各自去重，重复确认聚合一致。
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
    // 结清判定：含卡 received 直接比 settleTarget(=payable+prepaid 锁单快照)，与 admin orders.ts / createRepayment 一致
    targetStatus = newReceived + 0.005 >= settleTarget ? '已支付' : '部分支付'

    // ========== 更新 sale_orders（C4 合规：WHERE 锁定当前状态防并发竞态）==========
    // paid_at 语义：'已支付' → 本次确认时间（"最后一次到账时间"快照）；'部分支付' → 保留原值（NULL 续 NULL）
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
          // 确定性 card_id（Bug U）：一户一卡，避免 Date.now()+random 并发撞 PK
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

    // 按回款逐笔分配：捕获本次线下收款逐项可分配额 + 置回款待分配 + 汇总刷新（confirmOffline 无定向）
    // 必须在 recalcPaidSessionsForOrder 之前：新 STEP1 从 receipt 聚合 received。
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

    // paid_sessions 重算（ticket 2026-05-19）：received 增长 → paid_sessions 单调上升
    // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
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

    // 审计日志
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
    paidAmount: newReceived, // 向后兼容字段名（前端老代码读 paidAmount）
    received: newReceived,
    confirmAmount,
    remainingPayable: Math.round((orderPayable - newReceived) * 100) / 100,
    totalReceived,
    message: targetStatus === '已支付' ? '线下收款已确认' : '已确认本次收款（订单仍部分支付）'
  }
}

/**
 * 待支付/支付失败转换单被关闭时，撤销创建时的即时资产变更：
 * - 恢复被转出的原卡 remaining_sessions；
 * - 作废本转换单的转入/转出权益计数，避免详情和后续查询继续表现为已转。
 */
async function rollbackPendingConversionOnClose(client, saleOrderId, storeId, now) {
  await client.query(
    `WITH restore AS (
        SELECT ref_sale_item_id, SUM(quantity)::integer AS restore_sessions
          FROM sale_items
         WHERE sale_order_id = $1
           AND item_direction = '转出'
           AND product_type = '疗程卡'
           AND ref_sale_item_id IS NOT NULL
         GROUP BY ref_sale_item_id
      ),
      locked_source AS (
        SELECT src.sale_item_id,
               src.session_count,
               src.remaining_sessions,
               restore.restore_sessions
          FROM sale_items src
          JOIN restore ON restore.ref_sale_item_id = src.sale_item_id
         WHERE src.store_id = $2
         FOR UPDATE OF src
      )
      UPDATE sale_items src
         SET remaining_sessions = LEAST(
               COALESCE(src.session_count, src.remaining_sessions, 0),
               COALESCE(src.remaining_sessions, 0) + locked_source.restore_sessions
             ),
             updated_at = $3
        FROM locked_source
       WHERE src.sale_item_id = locked_source.sale_item_id`,
    [saleOrderId, storeId, now],
  )

  await client.query(
    `UPDATE sale_items
        SET received = 0,
            remaining_sessions = CASE
              WHEN session_count IS NULL THEN remaining_sessions
              ELSE session_count
            END,
            paid_sessions = CASE
              WHEN session_count IS NULL THEN NULL
              ELSE 0
            END,
            updated_at = $2
      WHERE sale_order_id = $1
        AND item_direction IN ('转出', '转入')`,
    [saleOrderId, now],
  )
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
      "UPDATE sale_orders SET status = '已关闭', allocation_status = NULL, updated_at = $1 WHERE sale_order_id = $2 AND status = $3",
      [now, saleOrderId, order.status]
    )
    if (updateResult.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 订单状态已变更，请刷新后重试')
    }
    if (order.sale_order_type === '转换单') {
      await rollbackPendingConversionOnClose(client, saleOrderId, order.store_id, now)
    }
    // 作废营业额子分配
    await client.query(
      `UPDATE sale_payment_item_allocations
          SET is_void = true, voided_at = $1, updated_at = $1
        WHERE sale_payment_item_receipt_id IN (
          SELECT id FROM sale_payment_item_receipts WHERE sale_order_id = $2
        )
          AND is_void = false`,
      [now, saleOrderId],
    )
    await client.query(
      `UPDATE sale_order_payments
         SET allocation_status = NULL
       WHERE sale_order_id = $1
          AND allocation_status IN ('待分配', '已分配')`,
      [saleOrderId],
    )
    // 释放关联的优惠券
    await client.query(
      `UPDATE user_coupons
       SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
       WHERE used_sale_order_id = $1`,
      [saleOrderId]
    )
    // 审计日志
    await logTransition(client, ctx, 'order.close', 'sale_order', saleOrderId, order.status, '已关闭')
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
  await pg.transaction(async (client) => {
    const result = await client.query(
      "UPDATE sale_orders SET status = '待支付', updated_at = $1 WHERE sale_order_id = $2 AND status = '支付失败'",
      [now, saleOrderId]
    )
    if (result.rowCount === 0) {
      throw new Error('INVALID_PARAMS: 订单状态已变更，请刷新后重试')
    }
    // 审计日志
    await logTransition(client, ctx, 'order.resetFailed', 'sale_order', saleOrderId, '支付失败', '待支付')
  })

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
    // 「待支付」语义合并「部分支付」（与 staff.todoList 同步：未结清都算待店长收款）
    if (status === '待支付') {
      params.push(['待支付', '部分支付'])
      whereExtra += ` AND o.status = ANY($${params.length}::order_status[])`
    } else {
      params.push(status)
      whereExtra += ` AND o.status = $${params.length}`
    }
  }

  // 美容师只能看到指定自己的订单
  if (!ctx.auth.roles.includes('manager')) {
    params.push(ctx.auth.staffWfId)
    whereExtra += ` AND o.preferred_employee_id = $${params.length}`
  }

  // 2026-07-08 修复 T1：与 admin orders.ts 对齐，LEFT JOIN client_wechat_users
  // 把 cust_name / cust_phone 作为权威；sale_orders.customer_name / client_phone 仅作 fallback。
  // 防前端开单时 `name || phone` fallback 污染写入的 sale_orders 字段在列表原样展示。
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

  // 顾客档案权威 > sale_orders 兜底
  const mapped = orders.map((o) => ({
    ...o,
    customer_name: o.cust_name || o.customer_name || null,
    client_phone: o.cust_phone || o.client_phone || null,
  }))
  ctx.result = { orders: mapped, page, pageSize }
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

  // 交易数据跟顾客走：先不限门店查订单，再分层判定可见性
  // （顾客档案的消费记录可跨门店查看任意订单详情；管理层模式 effectiveStoreId=null 时本就需放开）
  const orders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1',
    [saleOrderId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // 分层可见性：
  //  1) 订单在本 scope 内 + (店长 或 指定美容师是本人) → 门店操作权限放行（订单 Tab / 开单后查看，行为不变）
  //  2) 管理层模式 + 订单门店在本 scope 内 → 监管只读放行
  //  3) 订单顾客在本 scope 内（bound_store_id ∈ scope）→ 顾客档案场景只读放行（含跨门店订单）
  //  4) 都不满足 → 无权查看
  // 注：门店模式普通员工不靠 inStoreScope 放开（否则可看本店他人订单），仅经分支 1/3。
  const inStoreScope = isStoreInScope(ctx.auth, order.store_id)
  const isManager = ctx.auth.roles.includes('manager')
  const isMgmt = ctx.auth.loginLevel === 'management'
  let visible = inStoreScope && (isManager || order.preferred_employee_id === ctx.auth.staffWfId)
  if (!visible && isMgmt && inStoreScope) {
    visible = true // 管理层监管本 scope 内订单（只读）
  }
  if (!visible && order.client_user_id) {
    // 顾客在本 scope 内 → 可只读查看其任意订单（含跨门店）：顾客档案消费记录场景。
    // 普通员工(store_staff)额外要求该顾客分配给本人（与 assertCustomerProfileVisible 同口径），
    // 否则可凭可枚举的 saleOrderId 越权查看本店他人负责顾客的订单金额 / 款项流水。
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

  // 2026-07-08 修复 T1：与 list 对齐，正向兜底（客户档案权威 > sale_orders 兜底）。
  // 之前是 `if (!order.client_phone)` 反向兜底，sale_orders 已污染的脏数据会原样返回；
  // 改为正向兜底，与 admin orders.ts 行为一致。
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

  // 解析线下确认人姓名（offline_confirmed_by 存的是 employee_id，前端原先直接显示工号）
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
      si.sale_item_id, si.sale_order_id, si.sku_id, si.session_count, si.remaining_sessions,
      si.paid_sessions,
      si.unit_price, si.quantity, si.unit_real_price, si.sale_amount, si.received, si.pending_received,
      si.expire_date, si.remark, si.sales_category, si.ref_sale_item_id,
      si.product_name, si.product_type, si.picked_up_quantity,
      COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
      si.item_direction
    FROM sale_items si
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [saleOrderId])

  // 行级退款额（已退行不可回款；与 client/admin 一致）。退款只挂「购买」行。
  const staffDetailRefundMap = await getPerItemRefundedMap(pg, saleOrderId)
  for (const it of items) {
    if (it.item_direction === '购买') {
      it.refunded_amount = Number(staffDetailRefundMap.get(it.sale_item_id) || 0)
    }
  }

  // 营业额分配（receipt 子分配结构，每行一条员工/角色分配）
  const allocations = await pg.query(`
    SELECT
      spia.id, spir.sale_item_id, spia.employee_id, spia.department_name,
      spia.allocation_ratio, spia.allocated_amount AS total_amount, spia.is_void,
      spia.role_type, spia.commission_rate, spia.commission_amount,
      spir.sale_payment_id,
      si.product_name AS sale_item_name,
      sw.name AS employee_name
    FROM sale_payment_item_allocations spia
    JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
    JOIN sale_items si ON spir.sale_item_id = si.sale_item_id
    LEFT JOIN staff_wechat_users sw ON spia.employee_id = sw.employee_id
    WHERE spir.sale_order_id = $1
      AND spia.is_void = false
    ORDER BY spir.sale_payment_id DESC, spia.id
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

  // 顾客储值卡余额（供回款弹层「使用储值卡抵扣」自动抵满；无账户=0，无顾客=null）
  let cardBalance = null
  if (order.client_user_id) {
    const balRows = await pg.query(
      'SELECT balance FROM prepaid_cards WHERE user_id = $1 LIMIT 1',
      [order.client_user_id]
    )
    cardBalance = balRows.length > 0 ? Number(balRows[0].balance) : 0
  }

  // 多收余数（overpay）：按 sale_item 行级 received 归属，汇总字段只供老前端展示。
  // 仅销售单/转换单非历史单有意义（与可退口径一致）。
  const purchaseItems = items.filter((it) => it.item_direction === '购买')
  const itemOverpayById = computeItemOverpayRemainders(purchaseItems)
  for (const it of purchaseItems) {
    it.overpay_refundable = Math.max(0, Number(itemOverpayById.get(it.sale_item_id) || 0))
  }
  const overpayRefundable =
    ['销售单', '转换单'].includes(order.sale_order_type) && order.legacy_source !== 'workfine'
      ? computeOverpayRemainder(order, purchaseItems)
      : 0

  ctx.result = {
    order: {
      ...order,
      coupon_name: couponName,
      // 营业额分配口径：仅销售单/转换单且非历史订单参与（与 allocation.js ALLOCATABLE_ORDER_TYPES 一致），控制详情页分配入口显隐
      allocatable: ['销售单', '转换单'].includes(order.sale_order_type) && order.legacy_source !== 'workfine',
    },
    items,
    allocations,
    payments,
    cardBalance,
    overpayRefundable,
  }
}

// ========== P2: 退款 ==========
//
// 模型：
//   - 不创建 sale_orders[type='退款单'] 行；退款全部承载在 sale_order_payments
//   - 发起：INSERT sale_order_payments(change_type='退款', amount<=0, status='待审批',
//           source_end='staff', operator_employee_id, refund_reason, ref_sale_item_id, session_count)
//   - 审批：CAS UPDATE sale_order_payments SET status='已支付' AND status='待审批'
//           同一条 UPDATE 写 audit_employee_id / audit_at / audit_remark
//           + UPDATE sale_orders.refunded_amount += ABS(amount)
//           + 5 通道 cascade（sa/sc/coupons/points/pickup）
//   - 驳回：CAS UPDATE sale_order_payments SET status='已作废' AND status='待审批'
//           + UPDATE details(audit_employee_id/audit_at/audit_remark)
//   - DB partial unique uq_sop_status_audit 兜底同原单 in-flight 退款唯一性
const { cascadeRefund } = require('../helpers/refund-cascade')

async function reconcileOrderStatusAfterRefund(client, saleOrderId) {
  await client.query(
    `WITH receipt_refunds AS (
       SELECT spir.sale_item_id,
              COALESCE(ABS(SUM(spir.amount::numeric)), 0) AS refunded
         FROM sale_payment_item_receipts spir
         JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
        WHERE spir.sale_order_id = $1
          AND sop.sale_order_id = $1
          AND sop.change_type = '退款'
          AND sop.status = '已支付'
          AND spir.amount::numeric < 0
        GROUP BY spir.sale_item_id
     ),
     full_refunds AS (
       SELECT elem ->> 'refSaleItemId' AS sale_item_id,
              BOOL_OR(LOWER(COALESCE(elem ->> 'isFullItemRefund', 'false')) = 'true') AS full_refund
         FROM sale_order_payments sop
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN sop.note LIKE '{%'
                THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                          THEN (sop.note)::jsonb -> 'items'
                          ELSE '[]'::jsonb END
                ELSE '[]'::jsonb END
         ) AS elem
        WHERE sop.sale_order_id = $1
          AND sop.change_type = '退款'
          AND sop.status = '已支付'
          AND elem ->> 'refSaleItemId' IS NOT NULL
          AND elem ->> 'refSaleItemId' <> 'OVERPAY'
        GROUP BY elem ->> 'refSaleItemId'
     ),
     item_states AS (
       SELECT si.sale_item_id,
              si.received::numeric AS received,
              COALESCE(si.sale_amount::numeric, 0) AS sale_amount,
              COALESCE(rr.refunded, 0) AS refunded,
              COALESCE(fr.full_refund, false) AS full_refund,
              CASE WHEN si.product_type = '疗程卡'
                THEN GREATEST(0, COALESCE(si.session_count, 0) - COALESCE(si.remaining_sessions, 0)) * COALESCE(si.unit_real_price::numeric, 0)
                ELSE GREATEST(0, COALESCE(si.picked_up_quantity, 0)) * COALESCE(si.unit_real_price::numeric, 0)
              END AS consumed_value
         FROM sale_items si
         LEFT JOIN receipt_refunds rr ON rr.sale_item_id = si.sale_item_id
         LEFT JOIN full_refunds fr ON fr.sale_item_id = si.sale_item_id
        WHERE si.sale_order_id = $1
          AND si.item_direction = '购买'
     ),
     classified AS (
       SELECT *,
              GREATEST(consumed_value, sale_amount - refunded, 0) AS retained_value,
              (
                full_refund
                OR (sale_amount > 0 AND refunded >= sale_amount - 0.01)
                OR (refunded > 0 AND received <= 0.01 AND GREATEST(consumed_value, sale_amount - refunded, 0) <= 0.01)
              ) AS item_refunded
         FROM item_states
     ),
     agg AS (
       SELECT COUNT(*) AS item_count,
              COUNT(*) FILTER (WHERE item_refunded) AS refunded_count,
              COUNT(*) FILTER (WHERE NOT item_refunded AND received + 0.01 < retained_value) AS partial_count
         FROM classified
     ),
     target AS (
       SELECT CASE
                WHEN item_count = 0 THEN NULL
                WHEN refunded_count = item_count THEN '已退款'::order_status
                WHEN partial_count = 0 THEN '已支付'::order_status
                ELSE '部分支付'::order_status
              END AS status
         FROM agg
     )
     UPDATE sale_orders so
        SET status = target.status,
            paid_at = CASE WHEN target.status = '已支付'::order_status AND so.paid_at IS NULL THEN NOW() ELSE so.paid_at END,
            updated_at = NOW()
       FROM target
      WHERE so.sale_order_id = $1
        AND target.status IS NOT NULL
        AND so.status IN ('已支付', '已完成', '部分支付', '已退款')
        AND so.status IS DISTINCT FROM target.status`,
    [saleOrderId],
  )
}

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
  // 权限放开（Bug E）：普通员工可发起退款申请（店长审批）；scope 由 assertOrderInScope 守护，防越店发起。
  // 与 admin refund_create（全角色）对齐，呼应「员工发起 → 通知店长审批」流程。
  await requireStaffBound()(ctx, async () => {})

  const { refSaleOrderId, items, refundReason, handlingFee, includeOverpay } = ctx.event.payload || {}

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  // items 允许为空：仅当 includeOverpay=true（多收余数单独退，如部分支付单 7 项已退完只剩零头）。
  // overpayRefundable>0 的实质性校验在下方算出 origOrder/origItems 之后。
  if (!items || !Array.isArray(items) || (items.length === 0 && !includeOverpay)) {
    throw new Error('INVALID_PARAMS: 退款明细不能为空')
  }
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

  // 修复（Bug L）：改正向白名单——仅销售单支持退款。原黑名单只挡寄存单/legacy，漏了内部单/转换单/充值单。
  // 两端镜像 admin refunds.ts。充值卡退款走员工端「充值卡」入口（card.createRefund，扣 prepaid_cards.balance）。
  if (origOrder.legacy_source === 'workfine') {
    throw new Error('INVALID_STATE: 历史订单不支持退款')
  }
  if (origOrder.sale_order_type !== '销售单') {
    if (origOrder.sale_order_type === '充值单') {
      throw new Error('INVALID_STATE: 充值卡退款请在「充值卡」入口发起')
    }
    throw new Error('INVALID_STATE: 仅销售单支持退款')
  }

  // in-flight 唯一性：同一原单仅允许一笔 '待审批' 退款（DB 上有 partial unique uq_sop_status_audit 兜底）
  const inflightRefunds = await pg.query(
    `SELECT id FROM sale_order_payments
      WHERE sale_order_id = $1 AND change_type = '退款' AND status = '待审批' LIMIT 1`,
    [refSaleOrderId]
  )
  if (inflightRefunds.length > 0) {
    throw new Error('CONFLICT: 存在未完结退款')
  }

  // P 前置校验（Bug P）：有未终结服务单（待服务/服务中/待客户确认）时禁止退款。
  // 否则退款压低 paid_sessions 会让该服务单 confirm 被闸门拦截而永久卡死、员工提成丢失（孤儿服务单）。
  // 两端镜像 admin refunds.ts。
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

  // 查原单明细（构建 + 校验未使用数量）
  const origItems = await pg.query(
    "SELECT * FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'",
    [refSaleOrderId]
  )

  const itemOverpayById = computeItemOverpayRemainders(origItems)
  const requestItems = items.map((it) => ({
    saleItemId: String(it.saleItemId || ''),
    refundQuantity: it.refundQuantity,
    includeOverpay: it.includeOverpay === true,
  }))
  if (includeOverpay) {
    if (requestItems.length === 0) {
      const candidates = origItems
        .filter((it) => Math.max(0, Number(itemOverpayById.get(it.sale_item_id) || 0)) > 0)
      if (candidates.length === 1) {
        requestItems.push({
          saleItemId: candidates[0].sale_item_id,
          refundQuantity: 0,
          includeOverpay: true,
        })
      } else if (candidates.length > 1) {
        throw new Error('INVALID_PARAMS: 多收余数需选择所属商品子项后退款')
      }
    } else {
      for (const it of requestItems) {
        if (Math.max(0, Number(itemOverpayById.get(it.saleItemId) || 0)) > 0) {
          it.includeOverpay = true
        }
      }
    }
  }
  if (requestItems.length === 0) {
    throw new Error('INVALID_PARAMS: 退款明细不能为空')
  }

  // refundDetails 不重新赋值（capRefundAmounts 原地改其逐项 refundAmount）；totalRefund 截断时重算。
  let { refundDetails, totalRefund } = buildRefundDetails(origItems, requestItems)

  const fee = Math.max(0, Number(handlingFee) || 0)  // 钳制非负，对齐 admin refunds.ts（防负手续费放大退款额）
  // 修复（Bug R 手续费虚留次数）：fee ≥ 疗程卡单次价时 recalcPaidSessions 会多留 floor(fee/price) 次（账实背离，
  // 顾客退钱后仍能消费）。限制 fee < 最小疗程卡单次价，保证 paid_sessions 推导无偏；家居无 session_count 不受影响。
  // 0 元赠送项不参与最小价；完整任意 fee 支持需 paid_sessions 改用退款次数价值（follow-up）。两端镜像 admin refunds.ts。
  if (isHandlingFeeInvalidForRefund(refundDetails, fee)) {
    throw new Error('INVALID_PARAMS: 手续费不能超过单次服务价格')
  }
  const isZeroCashItemRefund = isZeroCashPaidSessionRefund(refundDetails, fee, totalRefund)
  let finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
  if (finalRefundAmount <= 0 && !isZeroCashItemRefund) {
    throw new Error('INVALID_STATE: 无可退项')
  }

  // 退款上限 = max(sale_order_payments 流水净额, sale_orders.received)：
  //   - 部分支付订单（如疗程卡只付定金、次数全在）按未使用次数×unit_real_price 算出的退款额可能远超实付，需封顶。
  //   - 流水净额（首次支付/回款/储值卡抵扣为正、已审批退款为负）是生产权威已收（含储值卡抵扣）；
  //     received 列兜底（流水缺失的历史/异常单），取 max 避免误拒。
  //   - 超限处理（2026-06-24 调整）：疗程卡强制整卡全退、数量不可调 → 截断退款额到 cap（仅退已付、整卡仍作废）；
  //     家居数量可调 → 仍拒绝让店长减少退款数量。详见下方 if 分支。
  const paymentsNetRows = await pg.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS net
       FROM sale_order_payments
      WHERE sale_order_id = $1 AND status = '已支付'`,
    [refSaleOrderId],
  )
  const paymentsNet = Number(paymentsNetRows[0]?.net || 0)
  // 修复（Bug A 重复退款）：received 是不减的毛实收，必须减去已退 refunded_amount 得净可退；
  // 否则全额退后 refundCap 仍 = received → 可无限重复全额退款。paymentsNet 已含退款负数（流水完整单的净可退）；
  // received - refunded_amount 为 legacy/流水缺失单兜底。两端镜像 admin refunds.ts。
  const refundCap = Math.max(paymentsNet, Number(origOrder.received || 0) - Number(origOrder.refunded_amount || 0))
  if (finalRefundAmount > refundCap + 0.001) {
    // 疗程卡强制整卡全退、退款数量不可调（buildRefundDetails）：部分支付订单整卡值 > 净已收时，
    // 直接拒绝会导致永远无法退款。改为截断到 cap（只退已付部分）、仍作废整卡（数量不变），
    // 逐项 refundAmount 等比缩到 targetGross，保 note/级联冲销/STEP1.5 净额扣减一致。两端镜像 admin refunds.ts。
    // 家居产品数量可调，无疗程卡项时仍拒绝，让店长减少退款数量（保持数量↔金额自洽）。
    const hasCourseCard = refundDetails.some((d) => d.productType === '疗程卡')
    if (!hasCourseCard) {
      throw new Error('INVALID_STATE: 退款金额超过订单可退余额，请减少退款数量')
    }
    const targetGross = Math.max(0, Math.round((refundCap + fee) * 100) / 100)
    totalRefund = capRefundAmounts(refundDetails, totalRefund, targetGross)
    finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
    if (finalRefundAmount <= 0 && !isZeroCashItemRefund) {
      throw new Error('INVALID_STATE: 无可退项')
    }
  }

  const overpayAmount = Math.round(
    Math.min(
      totalRefund,
      refundDetails.reduce((sum, d) => sum + Math.max(0, Number(d.overpayAmount || 0)), 0),
    ) * 100,
  ) / 100

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
  // status='待审批')。退款总额 = refundByCard + refundByOrigin 合计写入 amount=-finalRefundAmount（0 元退项为 0），
  // payment_method 取原路径（refundPaymentMethod）；储值卡部分 vs 原路径部分的拆分以及 handling_fee
  // 等明细全部存入 note 字段（JSON）。审批通过时根据 payment_method 决定储值卡是否回冲。
  // 整单全退判定（Bug Q/M）：所有购买项都在本次退款且全退 → cascade 通道3（券）才回滚
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
      saleAmount: d.saleAmount,
      isFullItemRefund: d.isFullItemRefund,
      overpayAmount: d.overpayAmount || 0,
      isOverpay: d.isOverpay === true,
    })),
    overpayAmount,
  })

  // 单项退款判定（方案 D）：排除 overpay 哨兵行后的真实明细仅 1 条 → 存其 refSaleItemId/quantity 供 cascade partial 分支
  const realDetails = refundDetails.filter((d) => !d.isOverpay)
  const singleRealItem = realDetails.length === 1 ? realDetails[0] : null

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
        // 镜像 admin refunds.ts 规则（方案 D）：单项退款 → 存首项 → cascade 走 partial 分支（按 saleItemId 精确回滚）；
        // 多项/整单退款 → 存 null → cascade 走 whole-order 分支（按 sale_order_id 全量回滚），避免欠回滚首项外的分成/提成/提货
        // overpay 哨兵行不计入「单项」判定（refSaleItemId='OVERPAY' 非真实品项，写入会违反 FK）。
        singleRealItem ? (singleRealItem.refSaleItemId || null) : null,
        singleRealItem ? (singleRealItem.quantity || null) : null,
        detailNote,
        now,
      ]
    )
    paymentId = sopRes.rows[0].id

    // 审计日志
    await logOperation(client, ctx, 'order.createRefund', 'sale_order_payment', paymentId, {
      _v: 3,
      saleOrderId: refSaleOrderId,
      finalRefundAmount,
      refundByCard,
      refundByOrigin,
      handlingFee: fee,
    })

    // 通知门店店长审批（Bug C）
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
    // 修复（Bug T）：in-flight SELECT 与 INSERT 间竞态由 DB uq_sop_status_audit 兜底；
    // 捕获 23505 转 CONFLICT，否则 raw pg 错误无白名单前缀会降级为「服务器内部错误」
    const code = e && (e.code || (e.cause && e.cause.code))
    if (code === '23505') throw new Error('CONFLICT: 存在未完结退款')
    throw e
  }

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
  // 修复（Bug J）：充值单退款必须走 card.approveRefund（扣 prepaid_cards.balance）。
  // order.approveRefund 储值卡通道只回冲销售单的卡内抵扣，对充值单余额完全不动 → 顾客留余额又拿现金。两端镜像 admin。
  if (sopRow.sale_order_type === '充值单') {
    throw new Error('INVALID_STATE: 充值卡退款请在「充值卡」入口审批')
  }

  const refSaleOrderId = sopRow.sale_order_id
  const refundAbs = Math.abs(Number(sopRow.amount || 0))
  const now = new Date()

  await pg.transaction(async (client) => {
    // G 复校：审批前重算可退余额（本笔仍待审批，SUM 已支付自动排除），防 create→approve 间余额变化导致超退。
    // create 时已校验，但其间回款/其它操作可能改变余额；in-flight 唯一约束保证本笔是唯一待审批。两端镜像 admin refunds.ts。
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

    // 2. 重算 sale_orders.refunded_amount = -SUM(已支付退款)（Bug F：累加→重算，幂等、自愈，对齐 admin/schema 不变量）
    // CAS-EXEMPT: 仅维护资金列 refunded_amount，不翻 status。本笔已在上方 CAS 翻为'已支付'，SUM 含本笔。
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

    // 3. 储值卡回冲通道（已退役 2026-06-28）：
    //    退款策略改为「全部走现金」（splitRefundByOriginalPayment 恒返回 refundByCard=0），
    //    createRefund 写入 note.refundByCard 恒为 0，故此处回冲分支永不触发。
    //    两端镜像 admin refunds.ts。若未来恢复按储值卡占比拆分退款，在此重建回冲逻辑。

    // 4. 级联回滚（Bug Q/M）：按本次退款明细逐 item 级联（从 note.items 读），仅全退 item 作废分配/提成
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
          isOverpay: it.isOverpay === true,
        }))
        cascadeWholeOrder = !!noteObj.isWholeOrderRefund
      }
    } catch (_) { cascadeItems = [] }
    // 兜底（老退款行无 note.items）：用 ref_sale_item_id 单 item；为空则 cascade 内部兜底整单
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

    // 4.1 paid_sessions 重算（ticket 2026-05-19，D3=A）：refunded_amount 增长 → settled 下降
    // 若新 paid_sessions < 已消费次数(session_count - remaining_sessions)，抛 CONFLICT 阻止退款
    await recalcPaidSessionsForOrder(client, refSaleOrderId)
    await reconcileAllocationStatusAfterRefund(client, refSaleOrderId)
    await reconcileOrderStatusAfterRefund(client, refSaleOrderId)

    // 5. 重算顾客消费档位 + 顾客类型
    if (sopRow.client_user_id) {
      await refreshSpendingTier(client, sopRow.client_user_id)
      await recalcCustomerType(client, sopRow.client_user_id)
      // 会员等级即时重算（只升不降；退款路径下消费降低 → rank 不增即跳过）
      await recalcMemberLevel(client, sopRow.client_user_id, await getMemberThreshold(), 'staffApi')
    }

    // 6. 写 operation_logs（审计）
    await logOperation(client, ctx, 'order.approveRefund', 'sale_order_payment', paymentId, {
      _v: 3,
      saleOrderId: refSaleOrderId,
      refundAbs,
      paymentMethod: sopRow.payment_method,
      cascade: cascadeResult,
    })

    // 通知发起人审批通过（Bug C；自审降噪：审批人=发起人则跳过）
    if (sopRow.operator_employee_id && sopRow.operator_employee_id !== ctx.auth.staffWfId) {
      await notifyRefundResult(client, {
        paymentId,
        saleOrderId: refSaleOrderId,
        recipientEmployeeId: sopRow.operator_employee_id,
        approved: true,
        amount: refundAbs,
      })
    }

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
  // 修复（Bug J）：充值单退款走 card.rejectRefund，order 端拒绝（与 approveRefund 对称）。两端镜像 admin。
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

    // operation_logs 审计
    await logOperation(client, ctx, 'order.rejectRefund', 'sale_order_payment', paymentId, {
      _v: 3,
      saleOrderId: sopRow.sale_order_id,
      rejectedReason: remark,
    })

    // 通知发起人驳回（Bug C；自审降噪）
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

// ========== P2: 回款单（Ticket 2：多次回款 PR-A） ==========

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
    idempotencyKey,
  } = payload
  const storeId = ctx.auth.effectiveStoreId

  if (!refSaleOrderId) throw new Error('INVALID_PARAMS: 缺少原销售单号')
  if (!paymentMethod) throw new Error('INVALID_PARAMS: 缺少 paymentMethod')
  // createRepayment 只处理「即时记账」回款（线下/储值卡）。
  // 微信/支付宝在线回款由 client 扫码链路走：order.qrcode → scan-pay → order.pay/alipayPay → payNotify 写 change_type='回款'，不经此函数。
  if (!['线下', '储值卡'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 非法的支付方式（仅支持 线下/储值卡）')
  }

  // 冻结闭环（Bug I）：退款审批中禁止回款（一笔订单不应同时退款审批中又补款）
  await assertNoPendingRefund(pg, refSaleOrderId)

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

  // 幂等键（2026-06-29 防重复扣卡）：前端为本次回款意向生成 idempotencyKey，重试/误点复用同一值。
  // 仅储值卡抵扣场景（prepaidCardAmount>0）用作扣卡 external_ref —— 纯现金回款由前端避免重复提交守护。
  // 缺失时退回 repayRefId-based external_ref（向后兼容老前端，仅放弃幂等保护）。
  const repayIdempRef = idempotencyKey && prepaidCardAmount > 0
    ? `card-repay-${refSaleOrderId}-${idempotencyKey}`
    : null

  const result = await pg.transaction(async (client) => {
    // 1) 锁原单 + 校验状态
    const lockRes = await client.query(
      'SELECT * FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE',
      [refSaleOrderId]
    )
    if (lockRes.rows.length === 0) throw new Error('INVALID_PARAMS: 原订单不存在')
    const locked = lockRes.rows[0]

    // 寄存单 / 历史订单(legacy)是「一次性初始化」单，禁止任何事后资金变更 —— 不支持回款
    if (locked.sale_order_type === '寄存单') {
      throw new Error('INVALID_STATE: 寄存单不支持回款')
    }
    if (locked.legacy_source === 'workfine') {
      throw new Error('INVALID_STATE: 历史订单不支持回款')
    }

    if (!['部分支付', '待支付'].includes(locked.status)) {
      throw new Error(`INVALID_STATE: 订单当前状态"${locked.status}"不允许回款`)
    }

    // 幂等预检（2026-06-29 防重复扣卡）：锁原单后查同 idempotencyKey 的 card-repay 扣款是否已落库。
    // 命中 → 整笔回款已处理（余额已扣、流水已记），直接返回当前状态、跳过本次扣卡/payments/received 全部逻辑。
    // 行锁（上面 SELECT ... FOR UPDATE）串行化同单请求，两次重试无竞态：第二次拿到锁时首次已 COMMIT 可见。
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

    // 2) 计算欠款：total − netReceived（netReceived = received − refunded_amount），与前端 order-detail 一致。
    // received 按 I1 含储值卡抵扣（Σ[首次支付/回款/储值卡抵扣]），须用总额减；旧口径
    // payable(=total−prepaid,扣卡) − received(含卡) 会让含卡部分支付单算成无欠款，导致回款被超额校验拒。
    // 须再减退款：含退款的部分支付单前端显示 total−netReceived > total−received，不减退款会被超额误拒。
    const origTotal = Number(locked.total_amount || 0)
    const origReceived = Number(locked.received || 0)
    const origRefunded = Number(locked.refunded_amount || 0)
    const remainingPayable = Math.round((origTotal - origReceived + origRefunded) * 100) / 100

    // 3) 超额校验
    if (totalThisTime > remainingPayable + 0.001) {
      throw new Error('INVALID_PARAMS: 本次回款金额超过订单欠款')
    }

    // 3b) 按子项校验 + 已退行不可回款（行级口径，与 client/admin 一致）
    //     sale_items 无 refunded_amount 列，行级退款权威源 = note.items[].refundAmount
    const staffRefundMap = await getPerItemRefundedMap(client, refSaleOrderId)
    const orderHasRefund = [...staffRefundMap.values()].some((v) => Number(v) > 0)
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
        // 已退行不可回款（已退款作废，不可再支付；四端口径一致）
        if (Number(staffRefundMap.get(it.saleItemId) || 0) > 0) {
          throw new Error(`INVALID_STATE: 子项 ${it.saleItemId} 已退款，不可再回款`)
        }
        const itemRemaining = Math.round((Number(row.sale_amount) - Number(row.received)) * 100) / 100
        const itemThis = Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100
        if (itemThis > itemRemaining + 0.001) {
          throw new Error(`INVALID_PARAMS: 子项 ${it.saleItemId} 回款额超过该行可回款额`)
        }
      }
    } else if (orderHasRefund) {
      // 整单回款（无 items[]）且订单有退款：非定向瀑布流会误充已退行（received 靠 STEP1.5 兜底，
      // 但 receipt/营业额分配会误归已退行）。要求店长按子项回款未退款项目，精确控制资金落点。
      throw new Error('INVALID_STATE: 本单存在已退款项目，请按子项回款未退款的项目')
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
        // 幂等 external_ref：优先用前端 idempotencyKey 派生的稳定键（重试命中 → 上方预检整笔跳过）；
        // 缺失时退回 repayRefId-based（向后兼容）。
        [cardId, -prepaidCardAmount, refSaleOrderId, repayIdempRef || `card-repay-${repayRefId}`]
      )
    }

    // 5) 向原销售单写 payments 流水 —— 款项记录合并为「一笔现金流动」，不按子项拆行：
    //    现金合并 1 行 '回款'(ref=null) + 储值卡合并 1 行 '储值卡抵扣'(ref=null)。
    //    子项定向（钱精确落选中卡）改由下方 5b 更新 sale_items.pending_received 承载（与 admin recordPayment 一致）。
    // 线下/储值卡回款均即时入账（已支付）
    const repayStatusRow = '已支付'
    const repayPaidAt = now
    // 回款事件主流水行 id（现金行优先；纯储值卡回款则取储值卡抵扣行）—— 按回款逐笔分配的归属键
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
    // 线下/储值卡回款均即时已支付：现金行为主流水行；纯储值卡取抵扣行
    const primaryPaymentId = cashPaymentId || cardPaymentId

    // 5b) 子项定向：把本次每张卡补款覆盖写入 sale_items.pending_received
    //     （2026-06-27 营业额分配重构：pending_received = 本次逐项实付，不再累加 received+refunded+delta）。
    //     非定向 capture 读 pending_received 作为权重；定向 capture 用 directedItems 不读此值。
    //     无 items[] 的订单级回款不动 pending（退回 untargeted 比例分摊，向后兼容）。
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
    // 结清判定基准 = total_amount（固定锚）。received 含现金 + 储值卡抵扣（I1），达 total 即结清。
    // 原用 payable + origPrepaidSnapshot 在「回款新增储值卡抵扣」时破裂（payable 不随 prepaid 减少，
    // rep2 锁定的 origPayable + origPrepaid > total 误判部分支付）。改锚 total 单调正确。
    // 充值单不进回款路径（一次性付清），total 锚无副作用。
    const settleTarget = Math.round(Number(locked.total_amount || 0) * 100) / 100
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

    // 按回款逐笔分配：捕获本次回款逐项可分配额 + 置回款待分配 + 汇总刷新订单分配状态
    // 必须在 recalcPaidSessionsForOrder 之前：新 STEP1 从 receipt 聚合 received。
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

    // paid_sessions 重算（ticket 2026-05-19）：回款增长 → 解锁更多可消费次数
    // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
    await recalcPaidSessionsForOrder(client, refSaleOrderId)

    // 重算顾客消费档位 + 顾客类型（付清后累计消费可能跨阈值）
    await refreshSpendingTier(client, locked.client_user_id)
    await recalcCustomerType(client, locked.client_user_id)
    // 会员等级即时重算（只升不降；付清后累计消费可能跨档，礼包留给 cron）
    await recalcMemberLevel(client, locked.client_user_id, await getMemberThreshold(), 'staffApi')

    // 审计日志
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
 *   convertInItems: [{ skuId, quantity, saleAmount?, unitRealPrice?, manualSaleAmountOverride? }],
 *   paymentMethod: '微信' | '支付宝' | '线下',
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
    isActivity,
    couponId: inputCouponId,
  } = ctx.event.payload || {}
  const storeId = ctx.auth.effectiveStoreId
  // market_name 在 INSERT 时以门店反查 org 树市场名为权威（子查询），此处仅备开单人快照作 COALESCE 兜底。
  const marketName = ctx.auth.marketName || ''

  if (!clientUserId) throw new Error('INVALID_PARAMS: 转换单必须指定顾客 clientUserId')
  if (!Array.isArray(convertOutSaleItemIds) || convertOutSaleItemIds.length === 0) {
    throw new Error('INVALID_PARAMS: 请选择至少一张折抵卡')
  }
  if (!Array.isArray(convertInItems) || convertInItems.length === 0) {
    throw new Error('INVALID_PARAMS: 请选择至少一个转入项目')
  }
  if (Array.isArray(inputCouponId)) {
    throw new Error('INVALID_PARAMS: MULTIPLE_COUPON_NOT_SUPPORTED: 一张订单仅支持一张优惠券')
  }
  if (!paymentMethod || !['微信', '支付宝', '线下'].includes(paymentMethod)) {
    throw new Error('INVALID_PARAMS: 支付方式仅支持 微信/支付宝/线下')
  }
  if (!storeId) throw new Error('INVALID_PARAMS: 缺少门店信息')

  // 查顾客快照信息（姓名 / phone）
  const clientRows = await pg.query(
    `SELECT user_id, phone, name, customer_type, member_level, bound_store_id
     FROM client_wechat_users WHERE user_id = $1 LIMIT 1`,
    [clientUserId]
  )
  if (clientRows.length === 0) throw new Error('INVALID_PARAMS: 顾客不存在')
  const client = clientRows[0]
  if (!client.bound_store_id) {
    throw new Error('CLIENT_NOT_REGISTERED: 顾客未注册小程序或未绑定门店')
  }
  // 非本店顾客禁止开转换单（同 order.create 口径）
  if (!isStoreInScope(ctx.auth, client.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法开单')
  }

  const now = new Date()
  // convOrderId 在事务内由 generateOrderNo('FY-XSD-WX-', tx) 生成，保证 advisory lock
  // 持有窗口覆盖 SELECT MAX → INSERT 全程，闭合 TOCTOU
  let convOrderId

  const result = await pg.transaction(async (tx) => {
    // 生成 convOrderId（内部独占 advisory_xact_lock(hashtext('sale_order_id_gen'))）
    convOrderId = await generateOrderNo('FY-XSD-WX-', tx)

    // 1. 锁候选卡。预扣汇总必须在独立查询中执行：PostgreSQL 不允许同层
    // GROUP BY/聚合查询使用 FOR UPDATE，也必须先取得此行锁才能与 service.start 串行。
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
       ORDER BY si.sale_item_id
       FOR UPDATE OF si`,
      [convertOutSaleItemIds]
    )
    const held = heldResult.rows
    if (held.length !== convertOutSaleItemIds.length) {
      throw new Error('INVALID_PARAMS: 部分卡不属于当前门店或已耗尽')
    }

    // 先完成与预扣无关的归属/状态校验，避免无效请求额外扫描 service_items。
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
      // 冻结闭环（Bug I）：源卡所属订单有待审批退款时禁止折抵转换（转换会置 remaining_sessions=0，与在途退款冲突）
      await assertNoPendingRefund(tx, row.sale_order_id)
    }

    // sale_items 行锁已持有后再汇总预扣。service.start 使用同一把行锁，因而不会在
    // 此快照之后插入新的预扣；转换扣减与预扣校验构成同一事务临界区。
    const reservedResult = await tx.query(
      `SELECT sit.sale_item_id,
              COALESCE(SUM(sit.session_used) FILTER (WHERE sit.reserved_at IS NOT NULL), 0) AS total_reserved
         FROM service_items sit
        WHERE sit.sale_item_id = ANY($1)
        GROUP BY sit.sale_item_id`,
      [convertOutSaleItemIds]
    )
    const reservedBySaleItemId = new Map(
      reservedResult.rows.map((row) => [row.sale_item_id, Number(row.total_reserved || 0)])
    )

    let totalOut = 0
    const outItems = []
    for (const row of held) {
      const unit = Number(row.unit_real_price)
      const productType = row.product_type
      // 2026-05-21 单品合并：折抵统一按 remaining_sessions（含原"体验卡单品"=1 次卡）；家居产品不可折抵
      // 2026-08-06 预扣机制：可折抵数量 = remaining_sessions - 服务预扣（total_reserved）
      let qty = 0
      if (productType === '疗程卡') {
        const rem = Number(row.remaining_sessions || 0)
        const reserved = reservedBySaleItemId.get(row.sale_item_id) || 0
        const available = rem - reserved
        if (available <= 0) {
          throw new Error('INVALID_PARAMS: 部分卡可用次数不足（存在服务中预留）')
        }
        qty = available  // 折抵数量改为可用次数（扣除预扣）
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

    // 2. 转入项目 — 按 SKU 查询计价；店长特价 SKU 可沿用销售单的手填应付金额
    const inItems = []
    const buyerIsMember = isMember(client.customer_type, client.member_level)
    for (const req of convertInItems) {
      if (!req || !req.skuId) throw new Error('INVALID_PARAMS: 转入项目缺少 skuId')
      const skuRes = await tx.query(
        `SELECT s.sku_id, s.product_type, s.spec_name, s.price, s.special_price, s.session_count, s.service_fee,
                s.is_shengmei, s.is_experience, s.is_manager_special, s.purchase_limit, s.market_scope, s.category_id, pc.sales_category
         FROM product_skus s
         JOIN product_categories pc ON s.category_id = pc.category_id
         WHERE s.sku_id = $1 AND s.deleted_at IS NULL`,
        [req.skuId]
      )
      if (skuRes.rows.length === 0) throw new Error(`INVALID_PARAMS: 商品 ${req.skuId} 不存在`)
      const sku = skuRes.rows[0]
      const qty = Number(req.quantity) || 1
      const { listUnit, realUnit: applicableUnit } = resolveUnitPrice(sku, buyerIsMember)
      let amount = Math.round(applicableUnit * qty * 100) / 100
      // 店长特价手填金额（manualSaleAmountOverride 标记，用于梯度累加过滤）
      const manualSaleAmountOverride = sku.is_manager_special === true && (req.saleAmount != null || req.unitRealPrice != null)
      if (manualSaleAmountOverride) {
        const inputAmount = req.saleAmount != null
          ? Number(req.saleAmount)
          : Number(req.unitRealPrice) * qty
        if (!Number.isFinite(inputAmount) || inputAmount < 0
            || inputAmount > amount + 0.005) {
          throw new Error('INVALID_PARAMS: 转入项目应付金额不能高于该顾客适用价或为非法值')
        }
        amount = Math.round(inputAmount * 100) / 100
      }
      const inServiceFee = Math.round(Number(sku.service_fee || 0) * qty * 100) / 100
      // 同 create：session_count 是"次"维度，需 × qty
      const inSessionCount = sku.session_count != null ? Number(sku.session_count) * qty : null
      const inDenom = (inSessionCount != null && inSessionCount > 0) ? inSessionCount : qty
      const inListAmount = Math.round(listUnit * qty * 100) / 100
      // unit_price 保留标价快照；unit_real_price 使用成交价，店长特价时二者会分离。
      const inListPerSessionUnit = inDenom > 0 ? Math.round((inListAmount / inDenom) * 100) / 100 : inListAmount
      const inRealPerSessionUnit = inDenom > 0 ? Math.round((amount / inDenom) * 100) / 100 : amount
      inItems.push({
        skuId: sku.sku_id,
        categoryId: sku.category_id,
        productName: sku.spec_name,
        productType: sku.product_type,
        sessionCount: inSessionCount,
        unitPrice: inListPerSessionUnit,
        unitRealPrice: inRealPerSessionUnit,
        quantity: qty,
        amount,
        saleAmount: amount,
        salesCategory: sku.sales_category,
        serviceFee: inServiceFee,
        isShengmei: sku.is_shengmei ?? null,
        isExperience: sku.is_experience === true,
        marketScope: sku.market_scope,
        isManagerSpecial: sku.is_manager_special === true,
        manualSaleAmountOverride,
        purchaseLimit: sku.purchase_limit != null ? Number(sku.purchase_limit) : null,
      })
    }

    await assertNormalSkuMarketScopeForCurrentStore(
      inItems.map((item) => ({
        skuId: item.skuId,
        specName: item.productName,
        isExperience: item.isExperience,
        marketScope: item.marketScope,
      })),
      ctx.auth,
      (text, params) => tx.query(text, params),
    )

    // 2.5. 转入项目应用疗程卡梯度累加价（与销售单对齐）
    // 查询所有可能用于梯度计算的 SKU（同分类+同名称的所有疗程卡规格）
    const tierSkuIds = new Set()
    for (const item of inItems) {
      if (item.productType === '疗程卡' && item.categoryId && !item.isExperience && !item.manualSaleAmountOverride) {
        tierSkuIds.add(item.categoryId + '::' + item.productName)
      }
    }
    let tierSkuRows = []
    if (tierSkuIds.size > 0) {
      const categoryIds = [...new Set(inItems.map(i => i.categoryId).filter(Boolean))]
      const tierSkuRes = await tx.query(
        `SELECT s.sku_id, s.category_id, s.spec_name, s.product_type, s.price, s.special_price,
                s.session_count, s.is_experience, s.is_manager_special
         FROM product_skus s
         WHERE s.category_id = ANY($1) AND s.product_type = '疗程卡' AND s.deleted_at IS NULL`,
        [categoryIds]
      )
      tierSkuRows = tierSkuRes.rows
    }
    applyTreatmentTierPricing(inItems, tierSkuRows, buyerIsMember, '转换单')

    // 转入明细写库时 amount 会同时落到 sale_amount 和 received，必须同步梯度成交价。
    for (const item of inItems) {
      item.amount = item.saleAmount
    }

    // 重新计算 totalIn（梯度累加可能改变了 amount / saleAmount）
    let totalIn = 0
    for (const item of inItems) {
      totalIn += Number(item.saleAmount) || Number(item.amount) || 0
    }
    totalIn = Math.round(totalIn * 100) / 100

    const purchaseLimitViolation = findPurchaseLimitViolation(convertInItems, inItems)
    if (purchaseLimitViolation) {
      throw new Error(`INVALID_PARAMS: PURCHASE_LIMIT_EXCEEDED: ${purchaseLimitExceededMessage(purchaseLimitViolation)}`)
    }

    // 转换单优惠券：仅抵扣转入后的正补差额，不能把折抵余款变成储值卡余额。
    // 先用券前转入额校验券范围/门槛，随后将实际抵扣额按 rawPriceDiff 封顶并分摊回转入行。
    const rawPriceDiff = Math.round((totalIn - totalOut) * 100) / 100
    let couponDiscount = 0
    if (inputCouponId) {
      if (rawPriceDiff <= 0) {
        throw new Error('INVALID_STATE: CONVERSION_COUPON_NO_POSITIVE_DIFFERENCE: 转换单无正补差额，不能使用优惠券')
      }

      const couponResult = await tx.query(
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
      const couponRows = couponResult.rows
      if (couponRows.length === 0) {
        throw new Error('INVALID_PARAMS: 优惠券已失效')
      }
      const couponInfo = couponRows[0]

      if (couponInfo.applicable_store_ids && couponInfo.applicable_store_ids.length > 0
          && !couponInfo.applicable_store_ids.includes(storeId)) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于此门店')
      }
      if (couponInfo.applicable_market_ids && couponInfo.applicable_market_ids.length > 0) {
        const marketResult = await tx.query(
          `SELECT o.parent_id AS market_id
           FROM stores s
           JOIN org_nodes o ON s.org_node_id = o.id
           WHERE s.store_id = $1 AND o.type = '门店'`,
          [storeId]
        )
        const marketId = marketResult.rows[0]?.market_id
        if (!marketId || !couponInfo.applicable_market_ids.includes(marketId)) {
          throw new Error('INVALID_PARAMS: 该优惠券不适用于此市场')
        }
      }

      const skuInfoResult = await tx.query(
        `SELECT ps.sku_id, ps.category_id, mps.product_id
         FROM product_skus ps
         LEFT JOIN mall_product_skus mps ON ps.sku_id = mps.sku_id
         WHERE ps.sku_id = ANY($1) AND ps.deleted_at IS NULL`,
        [inItems.map(item => item.skuId)]
      )
      const skuInfoRows = skuInfoResult.rows
      const categoryBySku = new Map()
      const productBySku = new Map()
      for (const skuInfo of skuInfoRows) {
        categoryBySku.set(skuInfo.sku_id, skuInfo.category_id)
        productBySku.set(skuInfo.sku_id, skuInfo.product_id)
      }
      const hasCategoryRestriction = !!(couponInfo.applicable_category_ids && couponInfo.applicable_category_ids.length > 0)
      const hasProductRestriction = !!(couponInfo.applicable_product_ids && couponInfo.applicable_product_ids.length > 0)
      const eligibleItems = (hasCategoryRestriction || hasProductRestriction)
        ? inItems.filter(item => {
            const categoryMatch = !hasCategoryRestriction || couponInfo.applicable_category_ids.includes(categoryBySku.get(item.skuId))
            const productMatch = !hasProductRestriction || couponInfo.applicable_product_ids.includes(productBySku.get(item.skuId))
            return categoryMatch && productMatch
          })
        : inItems
      if (eligibleItems.length === 0) {
        throw new Error('INVALID_PARAMS: 该优惠券不适用于当前商品')
      }

      const eligibleTotal = Math.round(eligibleItems.reduce(
        (sum, item) => sum + (Number(item.saleAmount) || Number(item.amount) || 0),
        0,
      ) * 100) / 100
      const minSpend = Math.round((Number(couponInfo.min_spend) || 0) * 100) / 100
      if (eligibleTotal + 0.001 < minSpend) {
        throw new Error(`INVALID_PARAMS: 未满足使用条件（满${minSpend}可用）`)
      }

      let calculatedDiscount = 0
      if (couponInfo.coupon_type === '现金券' || couponInfo.coupon_type === '品项券') {
        calculatedDiscount = Math.min(Number(couponInfo.discount_value), eligibleTotal)
      } else if (couponInfo.coupon_type === '折扣券') {
        calculatedDiscount = eligibleTotal * (1 - Number(couponInfo.discount_value))
        if (couponInfo.max_discount) {
          calculatedDiscount = Math.min(calculatedDiscount, Number(couponInfo.max_discount))
        }
      }
      couponDiscount = Math.round(Math.min(
        Math.max(0, calculatedDiscount),
        rawPriceDiff,
      ) * 100) / 100
      if (couponDiscount <= 0) {
        throw new Error('INVALID_PARAMS: 该优惠券无法抵扣当前补差额')
      }

      let distributed = 0
      for (let i = 0; i < eligibleItems.length; i++) {
        const item = eligibleItems[i]
        const beforeCoupon = Math.round((Number(item.saleAmount) || Number(item.amount) || 0) * 100) / 100
        const share = i === eligibleItems.length - 1
          ? Math.round((couponDiscount - distributed) * 100) / 100
          : Math.round(couponDiscount * (beforeCoupon / eligibleTotal) * 100) / 100
        if (i < eligibleItems.length - 1) distributed += share
        item.saleAmount = Math.max(0, Math.round((beforeCoupon - share) * 100) / 100)
        item.amount = item.saleAmount
        const denom = item.sessionCount != null && item.sessionCount > 0 ? item.sessionCount : item.quantity
        item.unitRealPrice = denom > 0 ? Math.round((item.saleAmount / denom) * 100) / 100 : item.saleAmount
      }
    }

    totalIn = Math.round(inItems.reduce(
      (sum, item) => sum + (Number(item.saleAmount) || Number(item.amount) || 0),
      0,
    ) * 100) / 100
    const priceDiff = Math.round((totalIn - totalOut) * 100) / 100
    const orderTotal = Math.max(0, priceDiff)

    // 储值卡抵扣（仅补差额 priceDiff > 0 时有效）：显式金额必须在 [0, min(补差额, 余额)] 内。
    // payable = priceDiff - card；全额抵扣（payable==0 且 card>0）则事务内即时扣卡 + 结清。
    let card = 0
    if (inputPrepaidCardAmount != null) {
      const v = Number(inputPrepaidCardAmount)
      if (!Number.isFinite(v) || v < 0) throw new Error('INVALID_PARAMS: 储值卡抵扣金额必须为非负数')
      card = Math.round(v * 100) / 100
      const maxCard = Math.max(0, priceDiff)
      if (card > maxCard + 0.001) {
        throw new Error('INVALID_PARAMS: 充值卡抵扣金额超过补差额')
      }
      if (card > 0) {
        const balanceRes = await tx.query(
          'SELECT balance FROM prepaid_cards WHERE user_id = $1',
          [clientUserId]
        )
        const currentBalance = balanceRes.rows.length > 0 ? Number(balanceRes.rows[0].balance) : 0
        if (currentBalance + 0.001 < card) {
          throw new Error('INSUFFICIENT_BALANCE: 充值卡余额不足')
        }
      }
    }
    const payable = Math.max(0, Math.round((orderTotal - card) * 100) / 100)
    const isFullCardCoverage = card > 0 && payable === 0
    // 差额>0 且仍需付现金：'待支付'（线下走 confirmOffline，线上走 payNotify）；
    // 差额>0 全额抵扣 或 差额<=0：'已支付'
    const orderStatus = priceDiff > 0 ? (payable > 0 ? '待支付' : '已支付') : '已支付'
    const orderPaid = priceDiff <= 0 || isFullCardCoverage
    // 全额抵扣 payment_method 落 '无'（现金通道无需使用，与 order.create 对齐）
    const effectivePaymentMethod = isFullCardCoverage ? '无' : paymentMethod

    // 3. document_type 快照：仅按下单时会员身份判（售前=非会员客，售后=会员客）
    const documentType = client.customer_type === '会员客' ? '售后' : '售前'

    // 4. 插入订单主表
    await tx.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type,
        market_name, store_id, store_name, sale_order_datetime,
        client_user_id, client_phone, customer_name,
        total_amount, payable_amount, prepaid_card_amount, received,
        payment_method, opened_by,
        preferred_employee_id, coupon_id, coupon_discount, allocation_status, remark,
        paid_at, created_at, updated_at, is_activity
      ) VALUES ($1, $2, '转换单', $3, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $5), $4), $5, (SELECT store_name FROM stores WHERE store_id = $5), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, '待分配', $19, $20, $6, $6, $21)`,
      [
        convOrderId, orderStatus, documentType, marketName, storeId, now,
        clientUserId, client.phone || null, client.name || null,
        orderTotal.toFixed(2), payable.toFixed(2), card.toFixed(2),
        (isFullCardCoverage ? card : 0).toFixed(2),
        effectivePaymentMethod, ctx.auth.staffWfId,
        preferredStaffWfId || null,
        inputCouponId || null, couponDiscount.toFixed(2),
        remark || null,
        orderPaid ? now : null,
        isActivity === true,
      ]
    )

    // 原子核销优惠券必须在订单 INSERT 之后执行：used_sale_order_id 有即时外键约束。
    if (inputCouponId) {
      const claimResult = await tx.query(
        `UPDATE user_coupons
         SET status = '已使用', used_sale_order_id = $1, used_at = NOW()
         WHERE coupon_id = $2 AND user_id = $3
           AND status = '未使用' AND expire_at > NOW()`,
        [convOrderId, inputCouponId, clientUserId]
      )
      if (claimResult.rowCount !== 1) {
        throw new Error('INVALID_PARAMS: 优惠券已失效')
      }
    }

    // 5. 生成 sale_item 流水号序列
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

    // 6. 转出行 × N + 原子扣减可转换次数。服务中的预扣次数必须留在源卡上，
    // 后续 confirm 才会从这部分次数扣减。
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
          // 转出行镜像原 sale_items.is_experience：负 received × is_experience=true 与原订单
          // trial_amount 累计自洽，避免跃迁 SQL 被误判（2026-04-26 ticket）。
          d.isExperience === true,
        ]
      )
      // 原子扣减原卡余量（幂等守卫：余量不足则 rowCount=0）。这里不能置 0：
      // d.quantity 是扣除服务预扣后的可转次数，预扣次数仍需留给服务确认核销。
      if (d.productType === '疗程卡') {
        const upd = await tx.query(
          `UPDATE sale_items
             SET remaining_sessions = remaining_sessions - $4, updated_at = $1
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

    // 7. 转入行 × M（新卡；unit_price=标价快照，unit_real_price=成交价；店长特价时二者分离）
    for (const d of inItems) {
      const saleItemId = `XSLSH-WX-${dateStr}${String(seq).padStart(4, '0')}`
      seq++
      await tx.query(
        `INSERT INTO sale_items (
          sale_item_id, sale_order_id, store_id, item_direction,
          sku_id, product_name, product_type,
          session_count, remaining_sessions,
          unit_price, quantity, unit_real_price, sale_amount, received,
          sales_category, service_fee, is_shengmei, is_experience, is_manager_special
        ) VALUES ($1, $2, $3, '转入', $4, $5, $6, $7, $7, $8, $9, $10, $11, $11, $12, $13, $14, $15, $16)`,
        [
          saleItemId, convOrderId, storeId,
          d.skuId, d.productName, d.productType,
          d.sessionCount,
          d.unitPrice, d.quantity, d.unitRealPrice, d.amount,
          d.salesCategory, d.serviceFee,
          d.isShengmei ?? null,
          // 转入行从 product_skus.is_experience 快照写入（2026-04-26 ticket）
          d.isExperience === true,
          d.isManagerSpecial === true,
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

    // 按回款逐笔分配：转换单补差额全额抵扣即结清 → 捕获可分配额（非定向）
    // 必须在 recalcPaidSessionsForOrder 之前：新 STEP1 从 receipt 聚合 received。
    if (convFullCardPaymentId && card > 0) {
      await capturePaymentAllocatables(tx, {
        salePaymentId: convFullCardPaymentId,
        saleOrderId: convOrderId,
        eventAmount: card,
        directedItems: null,
      })
      await refreshOrderAllocationRollup(tx, convOrderId)
    }

    // paid_sessions 初始写入（ticket 2026-05-19）：转换单 total_amount=差额（可能=0），
    // 公式走 op.total_amount <= 0 → 兜底 = session_count（转入新卡视为全付获得）
    // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
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

    // 审计日志（事务 client 为 tx；勿用 client，那是顾客行变量）
    await logOperation(tx, ctx, 'order.createConversion', 'sale_order', convOrderId, {
      _v: 3,
      storeId,
      clientUserId,
      priceDiff,
      couponId: inputCouponId || null,
      couponDiscount,
      prepaidCardAmount: card,
      orderStatus,
    })

    return { totalIn, totalOut, priceDiff, orderStatus, couponDiscount, prepaidCardCredit, prepaidCardAmount: card }
  })

  const convRemaining = Math.max(0, Math.round((result.priceDiff - result.prepaidCardAmount) * 100) / 100)
  ctx.result = {
    saleOrderId: convOrderId,
    status: result.orderStatus,
    totalIn: Math.round(result.totalIn * 100) / 100,
    totalOut: Math.round(result.totalOut * 100) / 100,
    priceDiff: result.priceDiff,
    couponDiscount: result.couponDiscount,
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
 * 返回: { cards: [{ saleItemId, sourceSaleOrderId, productName, productType,
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
            so.sale_order_datetime,
            so.paid_at,
            so.status AS order_status,
            so.sale_order_type,
            so.document_type,
            so.market_name,
            so.legacy_source,
            si.store_id,
            si.sku_id,
            si.item_direction,
            si.ref_sale_item_id,
            si.product_name,
            si.product_type,
            si.quantity,
            si.session_count,
            si.remaining_sessions,
            si.paid_sessions,
            si.unit_price,
            (si.quantity - COALESCE(si.picked_up_quantity, 0)) AS remaining_quantity,
            si.unit_real_price,
            si.sale_amount,
            si.received,
            si.pending_received,
            si.expire_date,
            si.remark,
            si.sales_category,
            si.picked_up_quantity,
            COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
            ps.category_id,
            pc.category_name,
            pc.product_kind,
            CASE
              WHEN si.product_type = '疗程卡'
                THEN si.unit_real_price * COALESCE(si.remaining_sessions, 0)
              ELSE 0
            END AS deductible_amount
     FROM sale_items si
     JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
     LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
     LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
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
      saleOrderDatetime: r.sale_order_datetime || null,
      paidAt: r.paid_at || null,
      orderStatus: r.order_status || '',
      saleOrderType: r.sale_order_type || '',
      documentType: r.document_type || null,
      marketName: r.market_name || '',
      legacySource: r.legacy_source || null,
      storeId: r.store_id || '',
      skuId: r.sku_id || null,
      itemDirection: r.item_direction || '',
      refSaleItemId: r.ref_sale_item_id || null,
      productName: r.product_name,
      productType: r.product_type,
      unit: r.unit || (r.product_type === '家居产品' ? '盒' : '次'),
      quantity: Number(r.quantity || 1),
      sessionCount: r.session_count != null ? Number(r.session_count) : null,
      remainingSessions: r.remaining_sessions != null ? Number(r.remaining_sessions) : null,
      remainingQuantity: r.remaining_quantity != null ? Number(r.remaining_quantity) : null,
      paidSessions: r.paid_sessions != null ? Number(r.paid_sessions) : null,
      unitPrice: r.unit_price != null ? String(r.unit_price) : null,
      unitRealPrice: String(r.unit_real_price),
      saleAmount: r.sale_amount != null ? String(r.sale_amount) : null,
      received: r.received != null ? String(r.received) : null,
      pendingReceived: r.pending_received != null ? String(r.pending_received) : null,
      expireDate: r.expire_date || null,
      remark: r.remark || null,
      salesCategory: r.sales_category || null,
      pickedUpQuantity: r.picked_up_quantity != null ? Number(r.picked_up_quantity) : null,
      deductibleAmount: Number(r.deductible_amount).toFixed(2),
      categoryId: r.category_id || '',
      categoryName: r.category_name || '',
      productKind: r.product_kind || '',
    }))
  }
}

// ========== P2: 取货单 ==========

async function generatePickupInventoryDocNo(client) {
  const prefix = 'GCK'
  const ymd = shanghaiYMD()
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `store_inventory_docs:${prefix}:${ymd}`,
  ])
  const rows = await client.query(
    `SELECT id
       FROM store_inventory_docs
      WHERE id LIKE $1
   ORDER BY id DESC
      LIMIT 1`,
    [`${prefix}-${ymd}-%`],
  )
  const latest = rows.rows[0]?.id
  const seq = latest ? Number(String(latest).slice(-4)) + 1 : 1
  return `${prefix}-${ymd}-${String(seq).padStart(4, '0')}`
}

async function createPickupInventoryDoc(client, ctx, updatedItem, clientUserId, customerName, pickupQuantity, remark, idempotencyKey) {
  const stockRows = await client.query(
    `SELECT id, store_id, sku_id, sku_name, batch_no, expiry_date, quantity_on_hand
       FROM store_inventory_stocks
      WHERE store_id = $1
        AND sku_id = $2
        AND quantity_on_hand > 0
   ORDER BY expiry_date NULLS LAST, id
      FOR UPDATE`,
    [ctx.auth.effectiveStoreId, updatedItem.sku_id],
  )

  let available = 0
  for (const row of stockRows.rows) available += Number(row.quantity_on_hand)
  if (available < Number(pickupQuantity)) {
    throw new Error(`INVALID_STATE: 门店库存不足，当前可用 ${available}`)
  }

  const docId = await generatePickupInventoryDocNo(client)
  await client.query(
    `INSERT INTO store_inventory_docs (
       id, doc_type, status, store_id, doc_date, total_quantity,
       related_sale_order_id, client_user_id, customer_name,
       remark, created_by, confirmed_by, confirmed_at
     )
     VALUES ($1, '院顾客产品出库', '已完成', $2, $3, $4,
             $5, $6, $7, $8, $9, $9, NOW())`,
    [
      docId,
      ctx.auth.effectiveStoreId,
      shanghaiDateStr(),
      pickupQuantity,
      updatedItem.sale_order_id,
      clientUserId,
      customerName || null,
      remark || null,
      ctx.auth.staffWfId,
    ],
  )

  let remaining = Number(pickupQuantity)
  let itemSeq = 0
  for (const stock of stockRows.rows) {
    if (remaining <= 0) break
    const before = Number(stock.quantity_on_hand)
    const deduct = Math.min(before, remaining)
    const after = before - deduct
    const inserted = await client.query(
      `INSERT INTO store_inventory_doc_items (
         doc_id, stock_id, sku_id, sale_item_id, sku_name, batch_no, expiry_date,
         quantity, stock_snapshot, remark
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        docId,
        stock.id,
        stock.sku_id,
        updatedItem.sale_item_id,
        stock.sku_name || updatedItem.product_name || updatedItem.sku_id,
        stock.batch_no || '',
        stock.expiry_date || null,
        deduct,
        before,
        remark || null,
      ],
    )
    const docItemId = inserted.rows[0].id
    await client.query(
      `UPDATE store_inventory_stocks
          SET quantity_on_hand = $1,
              updated_at = NOW()
        WHERE id = $2`,
      [after, stock.id],
    )
    await client.query(
      `INSERT INTO store_inventory_movements (
         movement_key, stock_id, store_id, sku_id, doc_id, doc_item_id,
         sale_order_id, sale_item_id, direction, quantity_delta,
         quantity_before, quantity_after, created_by, remark
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'出库',$9,$10,$11,$12,$13)`,
      [
        `pickup:${updatedItem.sale_item_id}:${idempotencyKey || docId}:${itemSeq++}`,
        stock.id,
        ctx.auth.effectiveStoreId,
        stock.sku_id,
        docId,
        docItemId,
        updatedItem.sale_order_id,
        updatedItem.sale_item_id,
        -deduct,
        before,
        after,
        ctx.auth.staffWfId,
        remark || null,
      ],
    )
    remaining -= deduct
  }

  return docId
}

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

  // 冻结闭环（Bug I）：退款审批中禁止提货（家居退款 cascade 会回滚 picked_up，待审批期提货会冲突）
  const pickupOrderRows = await pg.query(`SELECT sale_order_id FROM sale_items WHERE sale_item_id = $1`, [saleItemId])
  if (pickupOrderRows.length > 0) await assertNoPendingRefund(pg, pickupOrderRows[0].sale_order_id)

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
       RETURNING sale_item_id, sale_order_id, store_id, sku_id, product_name, quantity, picked_up_quantity`,
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
      `SELECT si.sale_order_id, o.client_user_id, o.customer_name
       FROM sale_items si JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
       WHERE si.sale_item_id = $1`,
      [saleItemId]
    )
    const clientUserId = itemRows.rows.length > 0 ? itemRows.rows[0].client_user_id : null
    const customerName = itemRows.rows.length > 0 ? itemRows.rows[0].customer_name : null

    updated = result.rows[0]

    // 3) 写入统一库存单据 + 库存扣减流水。库存不足时回滚 picked_up_quantity。
    const inventoryDocId = await createPickupInventoryDoc(
      client,
      ctx,
      updated,
      clientUserId,
      customerName,
      pickupQuantity,
      remark,
      idempotencyKey,
    )

    // 4) 插入提货记录（DB 层 uq_pickup_idempotency 兜底 race；命中则整事务 rollback 防 UPDATE/库存重复扣减）
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

    // 审计日志
    await logOperation(client, ctx, 'order.createPickup', 'sale_item', saleItemId, {
      _v: 4,
      pickupQuantity,
      clientUserId,
      storeId: ctx.auth.effectiveStoreId,
      pickedUp: updated.picked_up_quantity,
      total: updated.quantity,
      inventoryDocId,
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
            NULL::text AS spec_name,
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
           NULL::text AS spec_name,
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
  const dateStr = shanghaiYYMMDD(today)
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
      `SELECT si.sale_item_id, si.product_name, NULL::text AS spec_name, si.product_type,
              ps.unit AS sku_unit
         FROM sale_items si
         LEFT JOIN product_skus ps ON si.sku_id = ps.sku_id
         WHERE si.sale_item_id = ANY($1)`,
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
      unit: si.sku_unit || ((it.productType || si.product_type) === '家居产品' ? '盒' : '次'),
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

// ========== B5: 寄存单（剩余次数初始化）==========

/**
 * 创建寄存单（店长专用）
 *
 * 寄存单是把"顾客在 WorkFine 上的剩余次数"初始化到小程序的特殊订单：
 *   - 复用 sale_orders + sale_items，可生成 service_orders 核销
 *   - 提交审批：received=0 / payable_amount=0 / total_amount=0 / payment_method='无' / status='待审批'
 *   - 审批通过前不写 paid_at / paid_sessions，不允许生成服务单核销次数
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
  // market_name 在 INSERT 时以门店反查 org 树市场名为权威（子查询），此处仅备开单人快照作 COALESCE 兜底。
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
  // 非本店顾客禁止开寄存单（同 order.create 口径）
  if (!isStoreInScope(ctx.auth, client.bound_store_id)) {
    throw new Error('PERMISSION_DENIED: 该顾客不属于当前门店，无法开单')
  }

  // 拉 SKU 信息（参考 createConversion 的 SKU JOIN 模式）
  const rawItemDataList = await Promise.all(items.map(async (item) => {
    if (!item || !item.skuId) {
      throw new Error('INVALID_PARAMS: items 缺少 skuId')
    }
    const skuRows = await pg.query(
      `SELECT s.sku_id, s.product_type, s.spec_name, s.price, s.special_price, s.session_count,
              s.service_fee, s.is_shengmei, s.is_experience, s.market_scope,
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
    // 历史实收金额（可选，默认 0）：>0 时写 '回款'(线下) 流水，total_amount 仍保持 0
    const itemReceived = item.received != null ? Math.round((Number(item.received) || 0) * 100) / 100 : 0
    if (!Number.isFinite(itemReceived) || itemReceived < 0) {
      throw new Error('INVALID_PARAMS: received 必须为非负数')
    }
    // 原价快照（供审计），不入 received
    const basePrice = Number(sku.special_price || sku.price)
    // 先按输入行计算总次数；疗程卡 quantity>1 在下方拆为独立卡实体。
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
      marketScope: sku.market_scope,
    }
  }))

  await assertNormalSkuMarketScopeForCurrentStore(rawItemDataList, ctx.auth)

  // 寄存单内相同疗程卡按 SKU 合并为一条销售明细，累计张数、次数、标价与历史实收。
  // 家居产品保持原输入行语义，不参与合并。
  const itemDataList = []
  const treatmentCardItemIndex = new Map()
  for (const d of rawItemDataList) {
    if (d.productType !== '疗程卡') {
      itemDataList.push(d)
      continue
    }

    const existingIndex = treatmentCardItemIndex.get(d.skuId)
    if (existingIndex == null) {
      treatmentCardItemIndex.set(d.skuId, itemDataList.length)
      itemDataList.push(d)
      continue
    }

    const existing = itemDataList[existingIndex]
    const quantity = existing.quantity + d.quantity
    const sessionCount = existing.sessionCount != null && d.sessionCount != null
      ? existing.sessionCount + d.sessionCount
      : null
    const saleAmount = roundMoney(existing.saleAmount + d.saleAmount)
    const received = roundMoney(existing.received + d.received)
    const denom = sessionCount != null && sessionCount > 0 ? sessionCount : quantity
    const unit = denom > 0 ? roundMoney(saleAmount / denom) : saleAmount

    itemDataList[existingIndex] = {
      ...existing,
      quantity,
      sessionCount,
      remainingSessions: sessionCount,
      saleAmount,
      received,
      unitPrice: unit,
      unitRealPrice: unit,
    }
  }

  const now = new Date()
  let saleOrderId

  await pg.transaction(async (tx) => {
    // 订单号（advisory lock 防并发）
    saleOrderId = await generateOrderNo('FY-XSD-WX-', tx)

    // document_type：寄存单是把老顾客剩余次数初始化进来，固定 '售后'
    const documentType = '售后'

    // INSERT sale_orders —— 寄存单核心：金额全 0、status 待审批、payment_method='无'
    await tx.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, total_amount, client_user_id, client_phone, customer_name,
        payment_method, opened_by,
        preferred_employee_id, coupon_id, coupon_discount, remark,
        prepaid_card_amount, received, payable_amount, paid_at,
        allocation_status, created_at, updated_at
      ) VALUES ($1, '待审批', '寄存单', $2, COALESCE((SELECT m.name FROM stores s JOIN org_nodes so ON s.org_node_id = so.id JOIN org_nodes m ON so.parent_id = m.id WHERE s.store_id = $4), $3), $4, (SELECT store_name FROM stores WHERE store_id = $4), $5, 0, $6, $7, $8, '无', $9,
                NULL, NULL, 0, $10, 0, 0, 0, NULL,
                '待分配', $5, $5)`,
      [
        saleOrderId, documentType, marketName, storeId, now,
        clientUserId, client.phone || null, client.name || null,
        ctx.auth.staffWfId,
        remark || null,
      ]
    )

    // sale_item 流水号序列
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

    // INSERT sale_items —— received=0（由 recalc STEP1 据流水填）；session_count/remaining_sessions 正常写
    // 同时收集 received>0 的行，循环后写 '回款'(线下) 流水
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

    // 历史实收录入：对 received>0 的行写待审批 '回款'(线下) 流水（ref=该行，targeted）。
    // 审批通过前不计入 sale_orders.received、不落 paid_sessions，避免未审批寄存单可被核销。
    if (receiptRows.length > 0) {
      for (const r of receiptRows) {
        await tx.query(
          `INSERT INTO sale_order_payments (
            sale_order_id, change_type, amount, payment_method, external_txn_id,
            status, source_end, operator_employee_id, ref_sale_item_id, note, created_at, paid_at
          ) VALUES ($1, '回款', $2, '线下', NULL, '待审批', 'staff', $3, $4, $5, $6, NULL)`,
          [saleOrderId, r.received, ctx.auth.staffWfId, r.saleItemId, DEPOSIT_RECEIPT_NOTE, now]
        )
      }
    }

    // 审计日志
    await logOperation(tx, ctx, 'order.createDeposit', 'sale_order', saleOrderId, {
      _v: 4,
      clientUserId,
      status: '待审批',
      itemCount: itemDataList.length,
      totalSessionCount: itemDataList.reduce(
        (acc, it) => acc + (it.sessionCount != null ? it.sessionCount : 0),
        0
      ),
    })
  })

  ctx.result = {
    saleOrderId,
    status: '待审批',
    itemCount: itemDataList.length,
    message: '寄存单已提交审批',
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

// 非枚举测试出口，避免路由完整性检查把内部 helper 误认作公开 action。
Object.defineProperty(module.exports, '__testables__', {
  enumerable: false,
  value: {
    _loadAndValidateBundle,
    buildNormalSkuMarketScopeFilter,
    assertNormalSkuMarketScopeForCurrentStore,
  },
})
