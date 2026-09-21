/**
 * 订单模块路由
 * 客户端订单相关接口
 */

const cloud = require('wx-server-sdk')
const pg = require('../db/pg')
const { requirePhone } = require('../middleware/auth')
const { getMemberThreshold, getPointsToYuanRate, getPointsDeductionMaxRate } = require('../utils/config')
const { settlePointsSafe, grantPointBatch, consumePointBatches } = require('../utils/points')
const { recalcMemberLevel } = require('../utils/member-level')
const { isMember, resolveUnitPrice } = require('../utils/member-pricing')
const { recalcPaidSessionsForOrder } = require('../utils/paid-sessions')
const { capturePaymentAllocatables, refreshOrderAllocationRollup } = require('../utils/payment-allocatable')
const { getPerItemRefundedMap, getPerItemRefundedMapBatch, computeRefundAwareDirectedItems, itemRepayableAmount } = require('../utils/per-item-refund')
const lakalaClient = require('../utils/lakala-client')
const lakalaConfig = require('../utils/lakala-config')
const { shanghaiYMD, shanghaiYYMMDD } = require('../utils/datetime')
const { INVENTORY_LINKAGE_ENABLED } = require('../utils/feature-flags')
const { classifySaleOrderDocumentType } = require('../utils/document-type')

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100
}

async function loadInventoryCompositionSnapshots(client, items) {
  if (!INVENTORY_LINKAGE_ENABLED) return new Map()
  const homeItems = [...new Map(
    items.filter((item) => item.productType === '家居产品').map((item) => [item.skuId, item]),
  ).values()]
  if (homeItems.length === 0) return new Map()
  const result = await client.query(
    `SELECT mapping.product_sku_id, mapping.inventory_sku_id,
            inventory.product_code, inventory.product_name, inventory.spec_name, inventory.is_active,
            mapping.quantity_per_sale_unit
       FROM inventory_sku_product_sku_mappings mapping
       JOIN inventory_skus inventory ON inventory.sku_id = mapping.inventory_sku_id
      WHERE mapping.is_active = TRUE
        AND mapping.product_sku_id = ANY($1::text[])
   ORDER BY inventory.product_name, inventory.product_code`,
    [homeItems.map((item) => item.skuId)],
  )
  const snapshots = new Map()
  const invalidProductSkuIds = new Set()
  for (const row of result.rows) {
    if (row.is_active === false) {
      invalidProductSkuIds.add(row.product_sku_id)
      continue
    }
    const snapshot = snapshots.get(row.product_sku_id) || { version: 1, components: [] }
    snapshot.components.push({
      inventorySkuId: row.inventory_sku_id,
      productCode: row.product_code,
      productName: row.product_name,
      specName: row.spec_name,
      quantityPerSaleUnit: Number(row.quantity_per_sale_unit),
    })
    snapshots.set(row.product_sku_id, snapshot)
  }
  const invalid = homeItems.find((item) => invalidProductSkuIds.has(item.skuId))
  if (invalid) {
    throw new Error(`INVALID_STATE: INVENTORY_COMPOSITION_INVALID: 商品「${invalid.productName || invalid.skuId}」的库存组成含停用商品`)
  }
  const missing = homeItems.find((item) => !snapshots.has(item.skuId))
  if (missing) {
    throw new Error(`INVALID_STATE: INVENTORY_COMPOSITION_MISSING: 商品「${missing.productName || missing.skuId}」尚未配置库存组成`)
  }
  return snapshots
}

function moneyToCents(value) {
  return Math.max(0, Math.round((Number(value) || 0) * 100))
}

function pointsToDiscountCents(points, rate) {
  return Math.floor(points * rate * 100 + 1e-6)
}

function computePointsDeduction({
  usePoints,
  requestedPoints,
  pointsBalance,
  rawTotal,
  currentAmount,
  pointsToYuanRate,
  pointsDeductionMaxRate,
}) {
  const explicit = requestedPoints !== undefined && requestedPoints !== null
  const enabled = usePoints === true || (explicit && Number(requestedPoints) > 0)
  if (!enabled) return { pointsUsed: 0, pointsDiscount: 0 }

  const balance = Math.floor(Number(pointsBalance) || 0)
  const rate = Number(pointsToYuanRate) || 0
  const maxRate = Number(pointsDeductionMaxRate) || 0
  const capCents = Math.min(
    Math.floor(Math.max(0, Number(rawTotal) || 0) * maxRate * 100 + 1e-6),
    moneyToCents(currentAmount),
  )
  if (balance <= 0 || rate <= 0 || maxRate <= 0 || capCents <= 0) {
    if (explicit && Number(requestedPoints) > 0) {
      throw new Error('INSUFFICIENT_BALANCE: 积分余额不足或当前订单不可抵扣')
    }
    return { pointsUsed: 0, pointsDiscount: 0 }
  }

  if (explicit) {
    const points = Number(requestedPoints)
    if (!Number.isInteger(points) || points < 0) {
      throw new Error('INVALID_PARAMS: 积分抵扣数量必须为非负整数')
    }
    if (points === 0) return { pointsUsed: 0, pointsDiscount: 0 }
    if (points > balance) {
      throw new Error('INSUFFICIENT_BALANCE: 积分余额不足')
    }
    const discountCents = pointsToDiscountCents(points, rate)
    if (discountCents <= 0) {
      throw new Error('INVALID_PARAMS: 积分抵扣金额过小')
    }
    if (discountCents > capCents) {
      throw new Error('INVALID_PARAMS: 积分抵扣金额超过本单上限')
    }
    return { pointsUsed: points, pointsDiscount: discountCents / 100 }
  }

  const centsPerPoint = rate * 100
  const maxPointsByCap = Math.floor(capCents / centsPerPoint)
  const pointsUsed = Math.max(0, Math.min(balance, maxPointsByCap))
  const discountCents = Math.min(capCents, pointsToDiscountCents(pointsUsed, rate))
  return discountCents > 0
    ? { pointsUsed, pointsDiscount: discountCents / 100 }
    : { pointsUsed: 0, pointsDiscount: 0 }
}

function applyOrderLevelDiscountToItems(items, discountAmount) {
  const discountCents = moneyToCents(discountAmount)
  if (!discountCents || !items.length) return

  const totalCents = items.reduce((sum, item) => sum + moneyToCents(item.saleAmount), 0)
  if (!totalCents) return

  let distributedCents = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const baseCents = moneyToCents(item.saleAmount)
    const shareCents = i === items.length - 1
      ? discountCents - distributedCents
      : Math.min(baseCents, Math.round(discountCents * (baseCents / totalCents)))
    distributedCents += shareCents

    const saleCents = Math.max(0, baseCents - shareCents)
    item.saleAmount = saleCents / 100
    item.received = Math.min(moneyToCents(item.received), saleCents) / 100

    const denom = (item.sessionCount != null && item.sessionCount > 0) ? item.sessionCount : (item.quantity || 1)
    const listTotalRow = roundMoney(Number(item.listUnit || 0) * (item.quantity || 1))
    item.unitRealPrice = denom > 0 ? roundMoney(item.saleAmount / denom) : item.saleAmount
    item.unitPrice = denom > 0 ? roundMoney(listTotalRow / denom) : listTotalRow
  }
}

async function getAvailablePointsBalance(client, userId) {
  const res = await client.query(
    `SELECT COALESCE(SUM(remaining_amount), 0)::bigint AS balance
       FROM (
         SELECT remaining_amount
           FROM point_batches
          WHERE user_id = $1
            AND remaining_amount > 0
            AND expire_at > NOW()
          FOR UPDATE
       ) locked_batches`,
    [userId],
  )
  return Number(res.rows?.[0]?.balance || 0)
}

async function recomputePointsBalance(client, userId) {
  await client.query(
    `UPDATE client_wechat_users c
        SET points_balance = COALESCE((
              SELECT SUM(pb.remaining_amount)
                FROM point_batches pb
               WHERE pb.user_id = c.user_id
                 AND pb.expire_at > NOW()
            ), 0),
            points_updated_at = NOW()
      WHERE c.user_id = $1`,
    [userId],
  )
}

async function deductPointsAtCreation(client, { saleOrderId, userId, pointsUsed }) {
  if (!pointsUsed || pointsUsed <= 0) return
  // 积分相关锁序固定为 point_batches -> client_wechat_users，与过期任务一致。
  const available = await getAvailablePointsBalance(client, userId)
  if (available < pointsUsed) {
    throw new Error('INSUFFICIENT_BALANCE: 积分余额不足')
  }
  await client.query('SELECT user_id FROM client_wechat_users WHERE user_id = $1 FOR UPDATE', [userId])
  const inserted = await client.query(
    `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
     VALUES ($1, '消费抵扣', $2, $3, $4, NOW())
     ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, -pointsUsed, saleOrderId, `points-deduct-${saleOrderId}`],
  )
  if (inserted.rows?.[0]?.id) {
    await consumePointBatches(client, { userId, amount: -pointsUsed, refOrderId: saleOrderId })
    await recomputePointsBalance(client, userId)
  }
}

async function releasePointsDeduction(client, { saleOrderId, userId, pointsUsed = 0 }) {
  if (!saleOrderId || !userId || Number(pointsUsed || 0) <= 0) return
  await client.query('SELECT user_id FROM client_wechat_users WHERE user_id = $1 FOR UPDATE', [userId])
  const rows = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = '消费抵扣' THEN -amount ELSE 0 END), 0)::bigint AS deducted,
       COALESCE(SUM(CASE WHEN type = '消费抵扣退回' THEN amount ELSE 0 END), 0)::bigint AS returned
     FROM point_transactions
     WHERE ref_order_id = $1 AND user_id = $2
       AND type IN ('消费抵扣','消费抵扣退回')`,
    [saleOrderId, userId],
  )
  const pointsToRelease = Number(rows.rows?.[0]?.deducted || 0) - Number(rows.rows?.[0]?.returned || 0)
  if (pointsToRelease <= 0) return

  const inserted = await client.query(
    `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref, created_at)
     VALUES ($1, '消费抵扣退回', $2, $3, $4, NOW())
     ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [userId, pointsToRelease, saleOrderId, `points-deduct-rev-${saleOrderId}`],
  )
  const pointTransactionId = Number(inserted.rows?.[0]?.id || 0)
  if (pointTransactionId) {
    await grantPointBatch(client, {
      userId,
      pointTransactionId,
      type: '消费抵扣退回',
      amount: pointsToRelease,
      refOrderId: saleOrderId,
    })
    await recomputePointsBalance(client, userId)
  }
}

/**
 * 重算顾客消费档位（spending_tier，净额口径）—— clientApi 独立副本，镜像 staffApi
 * routes/order.js:73-99；SQL 与 payNotify index.js:998-1018、admin refunds.ts refreshSpendingTierTx、
 * cron refresh-spending-tier 字面对齐。修改须同步另外三端。
 * @param {object} client - pg 事务客户端
 * @param {string} clientUserId - client_wechat_users.user_id
 */
async function refreshSpendingTier(client, clientUserId) {
  if (!clientUserId) return
  // 净额 SUM(GREATEST(received - refunded_amount, 0))，原毛额 total_amount 不减退款/欠款。
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
 * 顾客分类跃迁的订单级金额 CTE（#187，2026-09-18）。$1 = client_user_id。
 * 产出每张已结清销售单的 non_trial / trial = 非体验 / 体验行的**毛实收**合计
 * （sale_items.received 净额 + 该行逐项退款额 → 还原"曾经收到的钱"，退款不扣减）。
 * refund_by_item 的 note→jsonb 三重防线逐字对齐 staffApi utils/paid-sessions.js
 * RECEIVED_REFUNDED_DEDUCT_SQL，根除 22P02。八处副本逐字一致，由 staffApi
 * __tests__/routes/recalc-customer-type-sql.test.js 守护。
 */
const RECALC_CUSTOMER_TYPE_CTE = `WITH refund_by_item AS (
       SELECT sop.sale_order_id,
              elem ->> 'refSaleItemId' AS sale_item_id,
              SUM(COALESCE(public.try_numeric(elem ->> 'refundAmount'), 0)) AS refunded
       FROM sale_order_payments sop
       JOIN sale_orders ro ON ro.sale_order_id = sop.sale_order_id
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
              THEN public.try_jsonb(sop.note) -> 'items'
              ELSE '[]'::jsonb END
       ) AS elem
       WHERE ro.client_user_id = $1
         AND ro.status IN ('已支付', '已完成')
         AND ro.sale_order_type = '销售单'
         AND sop.change_type = '退款'
         AND sop.status = '已支付'
         AND elem ->> 'refSaleItemId' <> 'OVERPAY'
       -- 序号绑定 SELECT 的前 2 列（sale_order_id, refSaleItemId）；重排 SELECT 列须同步改这里
       GROUP BY 1, 2
     ),
     order_amounts AS (
       SELECT o.sale_order_id,
              CASE WHEN NOT EXISTS (SELECT 1 FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
                   THEN GREATEST(o.received::numeric, 0)
                   ELSE COALESCE(SUM(LEAST(si.received::numeric + COALESCE(rbi.refunded, 0),
                                           si.sale_amount::numeric))
                                 FILTER (WHERE si.is_experience = false), 0)
              END AS non_trial,
              CASE WHEN NOT EXISTS (SELECT 1 FROM sale_items si2 WHERE si2.sale_order_id = o.sale_order_id)
                   THEN 0
                   ELSE COALESCE(SUM(LEAST(si.received::numeric + COALESCE(rbi.refunded, 0),
                                           si.sale_amount::numeric))
                                 FILTER (WHERE si.is_experience = true), 0)
              END AS trial
       FROM sale_orders o
       LEFT JOIN sale_items si ON si.sale_order_id = o.sale_order_id
                              AND si.item_direction = '购买'
       LEFT JOIN refund_by_item rbi ON rbi.sale_order_id = o.sale_order_id
                                   AND rbi.sale_item_id = si.sale_item_id
       WHERE o.client_user_id = $1
         AND o.status IN ('已支付', '已完成')
         AND o.sale_order_type = '销售单'
       GROUP BY o.sale_order_id, o.received
     )`

/**
 * 重算顾客类型（customer_type，只升不降）。clientApi 独立副本，镜像 staffApi routes/order.js:109-202。
 * 阈值从 system_configs.new_member_threshold 读取。跃迁为"会员客"时同步写 became_member_at = COALESCE(首笔达标单 paid_at, created_at)（非检测时刻 NOW()），
 * 并给 paid_at 最早的达标销售单打 is_membership_upgrade=true（会员升级单归因）。
 *
 * 八处 SQL 独立副本（staffApi + clientApi + payNotify + admin orders.ts / recompute-customer-tags.ts
 * + db/scripts/recalc-all-customer-types.js + recalc-became-member-at.js + backfill-membership-upgrade-doc-type.js），
 * 修改必须同步其余七处；一致性由 staffApi __tests__/routes/recalc-customer-type-sql.test.js 守护。
 * 单笔订单口径（#187 后判定金额换成该单非体验部分毛实收，仍不跨订单累计）。
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
    `${RECALC_CUSTOMER_TYPE_CTE}
     SELECT CASE
       WHEN EXISTS (SELECT 1 FROM order_amounts WHERE non_trial >= $2) THEN '会员客'
       WHEN EXISTS (SELECT 1 FROM order_amounts WHERE non_trial > 0)   THEN '小美客'
       WHEN EXISTS (SELECT 1 FROM order_amounts WHERE trial > 0)       THEN '体验客'
       ELSE '流量客'
     END AS computed_type`,
    [clientUserId, threshold]
  )

  const newType = typeResult.rows[0]?.computed_type
  // 防御：SELECT CASE 在真实 PG 必返回一行（ELSE '流量客' 兜底）；测试 mock 空 rows 时安全早退。
  if (!newType) return
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

  // 若本次 UPDATE 实际将顾客升级为“会员客”，became_member_at 记为首笔达标单时间 + 打归因标记。
  // became_member_at = COALESCE(paid_at, created_at)，选单子查询与下方 is_membership_upgrade 同源、选同一单。
  // 函数开头“已是会员客即 return”保证只在首次跃迁时执行一次。
  if (updateResult.rowCount > 0 && updateResult.rows[0].customer_type === '会员客') {
    await client.query(
      `UPDATE client_wechat_users SET became_member_at = COALESCE((
         ${RECALC_CUSTOMER_TYPE_CTE}
         SELECT COALESCE(o.paid_at, o.created_at) FROM sale_orders o
         JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id
         WHERE oa.non_trial >= $2
         ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC, o.sale_order_id ASC
         LIMIT 1
       ), became_member_at) WHERE user_id = $1`,
      [clientUserId, threshold]
    )
    await client.query(
      `UPDATE sale_orders SET is_membership_upgrade = true
       WHERE sale_order_id = (
         ${RECALC_CUSTOMER_TYPE_CTE}
         SELECT o.sale_order_id FROM sale_orders o
         JOIN order_amounts oa ON oa.sale_order_id = o.sale_order_id
         WHERE oa.non_trial >= $2
         ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC, o.sale_order_id ASC
         LIMIT 1
       )`,
      [clientUserId, threshold]
    )
  }
}

/**
 * 转已支付统一结算副作用五件套（clientApi 版），镜像 staffApi settlePaidByCardAtCreation
 * （routes/order.js:262-282）与 payNotify inline 链（index.js:998-1149）。
 * 顺序：refreshSpendingTier → recalcCustomerType（含 became_member_at + is_membership_upgrade 打标）
 *      → recalcMemberLevel → settlePointsSafe → grantShareGift（SAVEPOINT 隔离，非致命）。
 * clientApi 三处支付完成点（zeroPayable / confirmPrepaidFull / repay 纯卡）共用此入口，
 * 与 staffApi / payNotify / admin recordPayment 同口径。paid_sessions 由各调用点的
 * recalcPaidSessionsForOrder 负责，此处不重复。无首笔「首次支付」流水时 grantShareGift 内部早退。
 * @param {object} client - pg 事务客户端
 * @param {{saleOrderId:string, clientUserId:string, paidAmount:number, source:string}} args
 */
async function settlePaidEffects(client, { saleOrderId, clientUserId, paidAmount, source }) {
  if (clientUserId) {
    await refreshSpendingTier(client, clientUserId)
    await recalcCustomerType(client, clientUserId)
    // 会员等级即时重算（只升不降；与 recalcCustomerType 同口径，礼包留给 cron）
    await recalcMemberLevel(client, clientUserId, await getMemberThreshold(), 'clientApi')
  }
  await settlePointsSafe(client, saleOrderId, source)
  // 分享礼（首单结清；savepoint 隔离，非致命）
  if (clientUserId) {
    try {
      await client.query('SAVEPOINT sp_share_gift')
      const { grantShareGift } = require('../share-gift')
      await grantShareGift(client, { saleOrderId, clientUserId, paidAmount, source: 'clientApi' })
      await client.query('RELEASE SAVEPOINT sp_share_gift')
    } catch (sgErr) {
      try { await client.query('ROLLBACK TO SAVEPOINT sp_share_gift') } catch (e) {}
      console.error('[clientApi/share-gift] error (non-fatal):', sgErr)
    }
  }
}

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

async function resolveLakalaMerchantInTransaction(client, storeId) {
  if (!lakalaConfig.isReady()) return null
  if (!storeId) return null
  const result = await client.query(
    `SELECT lm.merchant_no, lm.term_no, lm.enabled
       FROM stores s
       JOIN lakala_merchants lm ON lm.id = s.lakala_merchant_id
      WHERE s.store_id = $1`,
    [storeId]
  )
  if (result.rows.length === 0) return null
  const row = result.rows[0]
  if (!row.enabled || !row.merchant_no) return null
  if (!row.term_no) {
    throw new Error('INVALID_STATE: LAKALA_TERM_NO_MISSING: 该门店未配置拉卡拉终端号，请联系管理员')
  }
  return { merchantNo: row.merchant_no, termNo: row.term_no }
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
  orderNo, outTradeNo, merchantNo, termNo,
  payAmountYuan, accountType, transType,
  openid, subAppid, requestIp,
  subject, attach,
  // 仅用于预下单失败时的安全释放（需要按门店解析商户去查单/关单）
  storeId: storeIdForRelease,
  // 单次预下单的超时预算；不传则用微信口径。支付宝要给吱口令那一跳让出预算
  timeoutMs: preorderTimeoutMs,
}) {
  const totalAmountFen = Math.round(payAmountYuan * 100)
  if (!outTradeNo) {
    throw new Error('INVALID_STATE: PAYMENT_INTENT_NOT_RESERVED: 支付场次尚未预占')
  }

  let resp
  try {
    resp = await lakalaClient.requestPreorder({
      merchantNo, termNo, outTradeNo,
      accountType, transType,
      totalAmountFen,
      requestIp: requestIp || '0.0.0.0',
      subject: subject || `凤御美容订单 ${orderNo}`,
      attach: attach || orderNo,
      subAppid, openid,
      timeoutExpressMin: LAKALA_PREORDER_TIMEOUT_MIN,
      timeoutMs: preorderTimeoutMs || LAKALA_PREORDER_TIMEOUT_MS,
    })
  } catch (err) {
    // 渠道明确回了业务失败码 → 确定没建单，直接本地释放，不必再跑一遍查单/关单。
    //
    // 状态集合是 ('待支付','部分支付')，**刻意不含 '支付失败'**：能走到预下单说明
    // reserve 已经放行，而 reserve 只接受这两个状态（见其状态闸门）。与
    // `releaseLakalaPaymentIntent`（含 '支付失败'，服务 staff/admin 的关单路径）用途不同。
    const definitelyNotCreated = err
      && /LAKALA_PREORDER_FAILED/.test(String(err.message || ''))
    if (definitelyNotCreated) {
      // 释放失败不能盖掉真正的业务错误——那会让前端拿到一个无前缀的 DB 错误，
      // 错误映射全乱（双谱系评审 round-7）
      try {
        await pg.query(
          `UPDATE sale_orders
           SET lakala_out_order_no = NULL, updated_at = NOW()
           WHERE sale_order_id = $1
             AND status IN ('待支付', '部分支付')
             AND lakala_out_order_no = $2`,
          [orderNo, outTradeNo]
        )
      } catch (releaseErr) {
        console.warn('[order/preorder] 明确失败后的本地释放未完成，交由定时补偿兜底:',
          orderNo, outTradeNo, releaseErr && releaseErr.message)
      }
    } else {
      // 超时/网络异常：**不确定**渠道是否已建单。以前这里直接放着不管，留下「意图活跃
      // 但没有快照」的状态——顾客重试只会撞 PAYMENT_INTENT_ACTIVE，得等渠道超时 + 定时
      // 补偿才自愈，正是本 issue 要消灭的卡死（双谱系评审 round-6）。
      // 改为走 fail-closed 的安全释放：查得到且未付款就关单后释放，查不到/查不准就保留，
      // 既不会误释放一笔可能已被支付的单，也不会平白把订单锁死。
      await releaseIntentAfterPreorderFailure(orderNo, outTradeNo, storeIdForRelease)
    }
    throw err
  }

  // 微信通道：校验拉卡拉返回的 app_id 与我方 subAppid 一致（防止拉卡拉商户绑定错误导致用户支付到别人账户）
  //
  // 这条抛错发生在预下单**成功之后**：渠道单已经建好、本地意图已占，但快照还没落。
  // 不释放就又是「意图活跃但无快照」，顾客重试只会撞 PAYMENT_INTENT_ACTIVE
  // （双谱系评审 round-7）。这笔单本来就不该被支付，安全释放正合适。
  if (accountType === 'WECHAT' && transType === '71') {
    if (subAppid && resp.lakalaAppId && resp.lakalaAppId !== subAppid) {
      await releaseIntentAfterPreorderFailure(orderNo, outTradeNo, storeIdForRelease)
      throw new Error(`INVALID_STATE: LAKALA_APPID_MISMATCH: 拉卡拉返回 app_id=${resp.lakalaAppId} 与 sub_appid=${subAppid} 不一致`)
    }
  }

  // 渠道回了成功码，但支付参数残缺（缺 package / paySign / 二维码 URL）——
  // 此时渠道单很可能已经建好，本地意图已占。不拦的话会落盘一份**不可用的快照**，
  // 顾客每次重试都复用它、每次都失败，直到场次过期（双谱系评审 round-7）。
  // 按「渠道可能已建单」处理：走安全释放后抛，让顾客可以立刻重新发起。
  if (accountType === 'WECHAT' && transType === '71') {
    // wx.requestPayment 的五个必需字段缺一不可（appId 由小程序 context 提供，不在此列）
    const wxParams = resp.paymentParams
    if (!wxParams || !wxParams.package || !wxParams.paySign
        || !wxParams.timeStamp || !wxParams.nonceStr || !wxParams.signType) {
      await releaseIntentAfterPreorderFailure(orderNo, outTradeNo, storeIdForRelease)
      throw new Error('INVALID_STATE: LAKALA_PREORDER_INCOMPLETE: 渠道未返回完整的微信支付参数')
    }
    return { outTradeNo, tradeNo: resp.tradeNo, paymentParams: wxParams }
  }
  if (accountType === 'ALIPAY' && transType === '41') {
    if (!resp.alipayQrUrl) {
      await releaseIntentAfterPreorderFailure(orderNo, outTradeNo, storeIdForRelease)
      throw new Error('INVALID_STATE: LAKALA_PREORDER_INCOMPLETE: 渠道未返回支付宝二维码地址')
    }
    return { outTradeNo, tradeNo: resp.tradeNo, alipayQrUrl: resp.alipayQrUrl }
  }
  return { outTradeNo, tradeNo: resp.tradeNo }
}

let lastLakalaOutTradeSuffix = 0

function buildLakalaOutTradeNo(orderNo, excludedOutTradeNo) {
  const excludedMatch = String(excludedOutTradeNo || '').match(/_(\d+)$/)
  const excludedSuffix = excludedMatch ? Number(excludedMatch[1]) : 0
  let suffix = Math.max(Math.floor(Date.now() / 1000), lastLakalaOutTradeSuffix + 1)
  if (suffix === excludedSuffix) suffix += 1
  lastLakalaOutTradeSuffix = suffix
  return `${orderNo}_${suffix}`
}

/**
 * 拉卡拉 trade_state 的三分类（官方取值：INIT / CREATE / SUCCESS / FAIL / DEAL /
 * UNKNOWN / CLOSE / PART_REFUND / REFUND / REVOKED）。
 *
 * 历史上代码只认 ['FAIL','CLOSE'] 为可释放终态，漏掉 REVOKED（当日交易撤销）——
 * 撤销过的单会永久卡住支付意图，谁也发不了新支付、谁也关不掉订单（issue #214）。
 */
const LAKALA_RELEASABLE_TRADE_STATES = ['FAIL', 'CLOSE', 'REVOKED']
const LAKALA_PAID_TRADE_STATES = ['SUCCESS', 'PART_REFUND', 'REFUND']

/**
 * 允许关闭的订单状态（跨 env 作废接口的前置复核用）。
 * 必须与 staffApi routes/order.js 的 CLOSEABLE_ORDER_STATUSES 同集合——
 * 两端漂移会让「staff 放行但 clientApi 拒绝」这类状态变成误报，由 snapshot 守护。
 */
const CLOSEABLE_ORDER_STATUSES = ['待支付', '支付失败']

/** 与 payNotify 解析回调时的 `.toUpperCase()` 对齐，避免两端对同一笔单判定不一致。 */
function normalizeTradeState(state) {
  return String(state || '').trim().toUpperCase()
}

/**
 * 作废意图路径上每次渠道调用的超时预算（双谱系评审 round-1）。
 *
 * 该路径最坏串行三次往返（queryTrade → closeTrade → 复核 queryTrade）。按 lakala-client
 * 默认的 30s/次算最坏 90s，而 clientApi 的云函数超时只有 60s —— 会在复核完成前被平台
 * 干掉，留下「渠道已关单、本地意图没释放」的不一致。7s × 3 ≈ 21s，留足余量。
 * ⚠️ 改这个值或改 cloudbaserc 的函数超时，要回头核对 staffApi 桥的 DEFAULT_TIMEOUT_MS。
 */
const LAKALA_VOID_CALL_TIMEOUT_MS = 7000

/**
 * 预下单 / 吱口令的单次超时预算（双谱系评审 round-6）。
 *
 * 整条支付请求必须在 clientApi 的 60s 函数超时内跑完，**且要给失败后的安全释放留出余量**：
 *   微信：preorder 20s + 释放 7s×3 = 41s
 *   支付宝：preorder 20s + 吱口令(8s + 1s 退避 + 8s 重试) + 释放 21s ≈ 58s
 * 用 lakala-client 的默认 30s 会让释放根本跑不完，留下「意图活跃但无快照」——
 * 正是安全释放本身要消灭的状态。
 */
const LAKALA_PREORDER_TIMEOUT_MS = 20000

/**
 * 支付宝通道要多走一跳吱口令（且失败会自动重试一次），必须比微信更紧（双谱系评审 round-7）：
 *   15s + (6s + 1s 退避 + 6s) + 释放 7s×3 = 49s，对 60s 函数超时留 11s。
 * 用微信那套 20s/8s 会算到 58s——余量只剩 2s，扛不住冷启动 + PG 建连 + 十来次查询的开销，
 * 而且最坏路径的几跳在网络劣化时高度相关（拉卡拉慢的时候，释放查询也慢），
 * 不是可以相乘的独立小概率。释放跑不完就又留下「意图活跃但无快照」——它本该消灭的状态。
 */
const LAKALA_PREORDER_TIMEOUT_ALIPAY_MS = 15000
const LAKALA_SHARE_CODE_TIMEOUT_MS = 6000

/**
 * 复用旧支付场次的最小剩余有效期。低于这个值不复用——顾客还没输完密码渠道单就过期了，
 * 重新开一场比让他付一半失败更好。
 */
const PAYMENT_INTENT_REUSE_MIN_REMAINING_MS = 60 * 1000

/**
 * 预下单传给拉卡拉的 timeout_express（分钟）。渠道单在此之后自动转 CLOSE。
 * 支付场次快照的 expiresAt 必须由同一个常量推出，否则「渠道已过期但本地判还能复用」
 * 会让顾客点了支付才失败。
 */
const LAKALA_PREORDER_TIMEOUT_MIN = 10

function lakalaIntentExpiresAt(nowMs = Date.now()) {
  return new Date(nowMs + LAKALA_PREORDER_TIMEOUT_MIN * 60 * 1000).toISOString()
}

/**
 * 构造微信场次快照（pay / repay 两处调用点共用，避免字段各自漂移——漏一个字段不会报错，
 * 只会让复用判据静默落空，退化成「还是发不了新支付」）。
 */
function buildWechatIntentSnapshot(outTradeNo, payAmount, paymentParams) {
  return {
    outTradeNo,
    expiresAt: lakalaIntentExpiresAt(),
    paymentMethod: '微信',
    payAmount,
    paymentParams,
  }
}

/** 构造支付宝吱口令场次快照（alipayPay / repay 两处调用点共用）。 */
function buildAlipayIntentSnapshot(outTradeNo, payAmount, shareToken, expireDate) {
  return {
    outTradeNo,
    // 吱口令自带有效期，可能短于 preorder 的 timeout_express，取更早者
    expiresAt: earlierIntentExpiry(expireDate, lakalaIntentExpiresAt()),
    paymentMethod: '支付宝',
    payAmount,
    paymentParams: { alipayShareToken: shareToken, alipayExpireDate: expireDate },
  }
}

/**
 * 支付宝吱口令自带 expire_date，可能早于 preorder 的 timeout_express。
 * 复用截止取两者更早者；渠道值无法解析时退回 preorder 口径（宁可少复用一会儿）。
 *
 * ⚠️ 渠道返回的是不带时区的 `yyyy-MM-dd HH:mm:ss`（拉卡拉口径固定 GMT+8）。
 * 不能用 `new Date(s.replace(/-/g,'/'))` —— 那按**运行时本地时区**解析，生产靠
 * index.js 设 TZ=Asia/Shanghai 才恰好正确，而单测直接 require routes/ 不加载 index.js，
 * 在 UTC 机器上会算晚 8 小时，`Math.min` 恒选 fallback、函数形同虚设且测不出来。
 * 这里按 utils/datetime.js 的既有约定走纯 UTC 算术，不依赖 process.env.TZ。
 */
function earlierIntentExpiry(channelExpireDate, fallbackIso) {
  if (!channelExpireDate) return fallbackIso
  const m = String(channelExpireDate).trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return fallbackIso
  // GMT+8 → UTC 毫秒
  const channelMs = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  ) - 8 * 3600 * 1000
  if (!Number.isFinite(channelMs)) return fallbackIso
  return new Date(Math.min(channelMs, new Date(fallbackIso).getTime())).toISOString()
}

/**
 * 按当前单号 CAS 释放支付意图。
 *
 * 状态集合含 '支付失败'（#214）：staffApi / admin 的关单入口都允许关闭 '支付失败' 单，
 * 若这里不放行，那类单会走完 queryTrade + closeTrade（**渠道场次已被真的销毁**）却释放
 * 不掉本地意图 → 订单永远关不掉，且每次重试都再关一次渠道单。
 */
async function releaseLakalaPaymentIntent(orderNo, outTradeNo) {
  return pg.query(
    `UPDATE sale_orders
     SET lakala_out_order_no = NULL, updated_at = NOW()
     WHERE sale_order_id = $1
       AND status IN ('待支付', '部分支付', '支付失败')
       AND lakala_out_order_no = $2
     RETURNING sale_order_id`,
    [orderNo, outTradeNo]
  )
}

/**
 * 释放 CAS 返回 0 行有三种语义，必须区分（#214）：
 *   a) 别人（前端轮询 confirmPayment / reconcile）已经把同一笔意图释放了 → 目标已达成，放行
 *   b) 意图被换成了新单号 → 必须拦
 *   c) 订单状态已变 → 必须拦
 * 一律当失败会造成可重现的误报：scan-pay 的轮询先释放，顾客随即点取消，就会吃一记
 * 「支付状态已变化，请刷新订单后重试」，要点第二次才成功——正好抵消本 issue 的修复效果。
 *
 * @returns {Promise<boolean>} true = 可继续（已释放或本就无意图）
 */
async function confirmIntentReleased(orderNo, outTradeNo) {
  const released = await releaseLakalaPaymentIntent(orderNo, outTradeNo)
  if (released.length > 0) return true
  const rows = await pg.query(
    'SELECT lakala_out_order_no FROM sale_orders WHERE sale_order_id = $1',
    [orderNo]
  )
  if (rows.length === 0) return false
  // 当前已无意图，或已不是我们刚作废的那一笔 → 目标状态已达成
  return !String(rows[0].lakala_out_order_no || '').trim()
}

/**
 * 预下单成功后把本次支付场次快照落盘，供顾客中途退出后「继续支付」复用（issue #214）。
 *
 * CAS 锚 `lakala_out_order_no = $2`：并发场景下意图若已被换掉，快照就不该落到新场次上。
 *
 * 落盘失败**不抛**：此时支付参数已经拿到手，让顾客先把这笔付掉比什么都重要。代价是
 * 这一场次失去复用能力（顾客中途退出后要等渠道超时），即退回改动前的行为——
 * 与「预下单/吱口令失败」那条路径的安全释放不同，那里顾客根本没拿到可用的支付参数。
 */
async function persistLakalaPaymentIntentSnapshot(orderNo, outTradeNo, snapshot) {
  try {
    await pg.query(
      `UPDATE sale_orders
       SET lakala_payment_intent = $1
       WHERE sale_order_id = $2
         AND lakala_out_order_no = $3`,
      [JSON.stringify(snapshot), orderNo, outTradeNo]
    )
  } catch (err) {
    console.warn('[order/persistLakalaPaymentIntentSnapshot] 落盘失败（不影响本次支付）:',
      orderNo, err && err.message)
  }
}

/**
 * 判断能否复用订单上已有的支付场次，能则返回可直接回发前端的 paymentParams。
 *
 * 六项判据全中才复用，任一不中返回 null（调用方退回「查渠道状态 → 释放 → 重建」的老路）：
 *   1. 快照的 outTradeNo 与订单当前意图一致 —— 这是自校验锚点，也是本设计不依赖
 *      「所有清空点同步清空快照列」的原因：单号对不上即自动失效，残留 jsonb 无害
 *   2. **归属本人** —— paymentParams 里的 prepay_id 绑定的是建单那位顾客的 openid，
 *      回发给第二个人不但泄漏他的 paySign，对方 wx.requestPayment 还必然失败，
 *      且有效期内每次重试都命中同一快照 → 这张单对他永久不可支付。
 *      员工开单在首次支付前 client_user_id 为空，此时任何快照都不该被复用。
 *   3. 剩余有效期足够（见 PAYMENT_INTENT_REUSE_MIN_REMAINING_MS）
 *   4. 金额一致 —— 防御性冗余，意图活跃期改抵扣/改储值卡/改线下三条路径都有既存守卫
 *   5. 支付方式一致（微信场次不能拿去走支付宝）
 *   6. 存在可用的 paymentParams
 *
 * @returns {{ paymentParams: object }|null}
 */
function tryReuseLakalaPaymentIntent(order, { payAmount, paymentMethod, userId }) {
  // 没有活动意图就谈不上复用；不先判这一条，下面 outTradeNo 的比较会在「两边都空」时
  // 误判为相等。
  if (!order.lakala_out_order_no) return null

  const raw = order.lakala_payment_intent
  if (!raw) return null
  const intent = typeof raw === 'string' ? safeParseJson(raw) : raw
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null

  if (String(intent.outTradeNo || '') !== String(order.lakala_out_order_no || '')) return null

  if (!order.client_user_id || !userId || order.client_user_id !== userId) return null

  const expiresAt = intent.expiresAt ? new Date(intent.expiresAt).getTime() : 0
  if (!Number.isFinite(expiresAt)
      || expiresAt - Date.now() < PAYMENT_INTENT_REUSE_MIN_REMAINING_MS) {
    return null
  }

  const snapshotAmount = Math.round(Number(intent.payAmount || 0) * 100)
  if (snapshotAmount !== Math.round(Number(payAmount || 0) * 100)) return null

  if (String(intent.paymentMethod || '') !== String(paymentMethod || '')) return null

  const paymentParams = intent.paymentParams
  if (!paymentParams || typeof paymentParams !== 'object') return null

  // 按通道校验必需字段：历史上可能落过畸形快照（渠道回成功却少字段），
  // 复用它只会让顾客反复失败到场次过期。不复用即退回「查渠道 → 释放 → 重建」老路。
  if (paymentMethod === '微信'
      && (!paymentParams.package || !paymentParams.paySign
          || !paymentParams.timeStamp || !paymentParams.nonceStr || !paymentParams.signType)) {
    return null
  }
  if (paymentMethod === '支付宝' && !paymentParams.alipayShareToken) return null

  return { paymentParams }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 复用旧支付场次前，确认它在渠道侧仍然可支付（双谱系评审 round-1 引入，round-2 补全）。
 *
 * 两类必须拦下的状态：
 *   - **已支付**（SUCCESS / PART_REFUND / REFUND）：顾客付了款但回调还没入账就重新扫码，
 *     不查渠道就回发旧 paymentParams，前端会去唤起一笔已成功的场次，只能得到误导性失败。
 *   - **已终态但本地没释放**（FAIL / CLOSE / REVOKED）：例如关单成功但复核那一跳超时，
 *     fail-closed 保留了意图与快照。此时复用会回发一个**已死亡**的场次，顾客每次重试都
 *     命中同一快照、反复失败，直到快照过期才自愈——正是本 issue 要消灭的卡死的短时复刻。
 *     这种情况直接释放本地意图并返回 false，调用方重新预占一笔新场次，顾客无感。
 *
 * 必须在事务**之外**调用：这是一次 HTTPS 往返，放进事务会把订单行锁持有到网络返回。
 *
 * 查单失败时选择**放行复用**而不是拒绝：复用的是同一笔渠道单，渠道对已支付/已关闭的
 * 场次本身会拒绝付款，不存在重复扣款；而拒绝会让顾客重新卡在「发不了新支付」上。
 *
 * @returns {Promise<boolean>} true = 可继续复用；false = 已释放意图，调用方应重新预占
 */
async function ensureReusedIntentStillPayable(orderNo, outTradeNo, merchant) {
  // 商户配置缺失（数据异常）时放行复用而不是拒绝：拒绝会让顾客直接卡在「发不了支付」，
  // 而放行最坏也只是回发一个可能已失效的场次、由前端唤起失败——两害相权取轻。
  // 能走到这里说明预下单当时是成功的，商户配置凭空消失属于需要人工介入的异常。
  if (!merchant) return true
  let trade
  try {
    trade = await lakalaClient.queryTrade({
      merchantNo: merchant.merchantNo,
      termNo: merchant.termNo,
      outTradeNo,
      timeoutMs: LAKALA_VOID_CALL_TIMEOUT_MS,
    })
  } catch (err) {
    console.warn('[order/reuseIntent] 复用前查单失败，降级放行:', orderNo, err && err.message)
    return true
  }
  if (!trade || trade.ok !== true) {
    console.warn('[order/reuseIntent] 复用前查单未成功返回，降级放行:',
      orderNo, trade && trade.code, trade && trade.msg)
    return true
  }

  const state = normalizeTradeState(trade.tradeState)
  if (LAKALA_PAID_TRADE_STATES.includes(state)) {
    throw new Error('CONFLICT: PAYMENT_ALREADY_SUCCEEDED: 支付已成功，正在更新订单，请稍后刷新')
  }
  if (LAKALA_RELEASABLE_TRADE_STATES.includes(state)) {
    // 渠道已终态：这笔场次再也付不了，留着它只会让顾客反复撞墙。释放后让调用方重建。
    console.warn('[order/reuseIntent] 快照对应的渠道场次已终态，释放后重建:', orderNo, state)
    await confirmIntentReleased(orderNo, outTradeNo)
    return false
  }
  return true
}

/**
 * 预下单已成功、但后续步骤（如支付宝吱口令）失败时的安全释放（双谱系评审 round-5）。
 *
 * 不释放的话会留下「意图活跃但没有可复用快照」的状态：顾客立刻重试只会撞
 * PAYMENT_INTENT_ACTIVE，得等渠道超时 + 定时补偿才能自愈——正是本 issue 要消灭的卡死。
 *
 * 释放本身仍走 fail-closed 的 voidActiveLakalaPaymentIntent（查单确认非 SUCCESS → 关单
 * → 复核）。释放失败不能盖掉真正的业务错误，所以这里只记日志。
 */
async function releaseIntentAfterPreorderFailure(orderNo, outTradeNo, storeId) {
  // 契约：**本函数永不抛**。调用点都是 `await release(...)` 后紧跟 `throw err`（原始业务错误），
  // 一旦这里漏出异常就会把真正的错误换掉，前端的错误映射全乱——正是下面那层 catch 的意义。
  try {
    await voidActiveLakalaPaymentIntent(orderNo, { outTradeNo, storeId })
  } catch (err) {
    console.warn('[order/preorderFailure] 安全释放未完成，交由定时补偿兜底:',
      orderNo, outTradeNo, err && err.message)
  }
}

/**
 * 主动作废订单上的在线支付意图，成功后该订单可被取消/关闭（issue #214）。
 *
 * 全程 **fail-closed**：只有确认渠道侧已是「不可再支付」的终态才清本地意图。
 * 关单失败、复核非终态、查单异常一律抛 CONFLICT 保留意图——宁可让用户重试，
 * 也不制造「本地已关、渠道可付」的窗口（那会让 payNotify 因「非当前意图」拒绝入账，
 * 变成钱收了订单不动的最坏事故）。
 *
 * @param {string} orderNo
 * @param {{ outTradeNo: string, storeId: string }} ctx
 * 调用方负责先判空 outTradeNo（`cancel` 与 `voidPaymentIntent` 都判了）；真漏判也是
 * fail-closed —— lakala-client 的参数校验会先抛 INVALID_PARAMS，不会误释放意图。
 *
 * @returns {Promise<'released'>}
 */
async function voidActiveLakalaPaymentIntent(orderNo, { outTradeNo, storeId }) {
  let merchant
  try {
    merchant = await resolveLakalaMerchant(storeId)
  } catch (err) {
    console.warn('[order/voidIntent] 商户配置读取失败:', orderNo, err && err.message)
    merchant = null
  }
  if (!merchant) {
    throw new Error('CONFLICT: PAYMENT_STATUS_UNCERTAIN: 暂时无法确认支付结果，请稍后重试')
  }

  let trade
  try {
    trade = await lakalaClient.queryTrade({
      merchantNo: merchant.merchantNo,
      termNo: merchant.termNo,
      outTradeNo,
      timeoutMs: LAKALA_VOID_CALL_TIMEOUT_MS,
    })
  } catch (err) {
    console.warn('[order/voidIntent] 查单失败，保留意图:', orderNo, err && err.message)
    throw new Error('CONFLICT: PAYMENT_STATUS_UNCERTAIN: 暂时无法确认支付结果，请稍后重试')
  }

  // 大小写归一：payNotify 解析回调时做了 toUpperCase，查单侧不做就会出现两端对同一笔单
  // 判定不一致（渠道返回 `Success` 之类的变体时，这里会把已付款单当成非终态去关单）。
  const state = normalizeTradeState(trade && trade.tradeState)

  // 只有查单**成功**返回的 trade_state 才是权威的（双谱系评审 round-1）：
  // `request()` 对非成功码不抛错，只把 ok 置 false，而错误响应里可能仍带一个
  // 非权威的 resp_data.trade_state。若不看 ok 就按它释放意图、关闭订单，而渠道单
  // 其实仍可支付，就会形成「本地已关、渠道可付」——正是本次改动最该避免的窟窿。
  // 同理 tradeState 为空串也不能当「未付款」去关单：真实状态未知。
  if (!trade || trade.ok !== true || !state) {
    console.warn('[order/voidIntent] 查单未返回权威 trade_state，保留意图待人工核查:',
      orderNo, outTradeNo, trade && trade.ok, trade && trade.code, trade && trade.msg)
    throw new Error('CONFLICT: PAYMENT_STATUS_UNCERTAIN: 暂时无法确认支付结果，请稍后重试')
  }

  if (LAKALA_PAID_TRADE_STATES.includes(state)) {
    throw new Error('CONFLICT: PAYMENT_ALREADY_SUCCEEDED: 支付已成功，正在更新订单，请稍后刷新')
  }

  // 已是终态：渠道侧不可能再被支付，直接释放。
  if (LAKALA_RELEASABLE_TRADE_STATES.includes(state)) {
    if (!await confirmIntentReleased(orderNo, outTradeNo)) {
      throw new Error('CONFLICT: PAYMENT_INTENT_CHANGED: 支付状态已变化，请刷新订单后重试')
    }
    return 'released'
  }

  // 非终态（INIT / CREATE / DEAL / UNKNOWN）：顾客可能还握着可付款的支付面板，
  // 必须先让渠道关单，否则本地关闭后仍可能收到钱。
  try {
    await lakalaClient.closeTrade({
      merchantNo: merchant.merchantNo,
      termNo: merchant.termNo,
      outTradeNo,
      timeoutMs: LAKALA_VOID_CALL_TIMEOUT_MS,
    })
  } catch (err) {
    console.warn('[order/voidIntent] 关单请求失败，保留意图:', orderNo, err && err.message)
    throw new Error('CONFLICT: PAYMENT_INTENT_ACTIVE: 暂时无法终止本次支付，请稍后重试')
  }

  // 关单返回成功不等于渠道已终态，必须复核——这是本流程唯一可信的放行依据。
  let recheck
  try {
    recheck = await lakalaClient.queryTrade({
      merchantNo: merchant.merchantNo,
      termNo: merchant.termNo,
      outTradeNo,
      timeoutMs: LAKALA_VOID_CALL_TIMEOUT_MS,
    })
  } catch (err) {
    console.warn('[order/voidIntent] 关单后复核失败，保留意图:', orderNo, err && err.message)
    throw new Error('CONFLICT: PAYMENT_STATUS_UNCERTAIN: 暂时无法确认支付结果，请稍后重试')
  }

  const recheckState = normalizeTradeState(recheck && recheck.tradeState)
  // 复核同样只认查单成功的响应——它是整个关单流程唯一的放行依据
  if (!recheck || recheck.ok !== true) {
    console.warn('[order/voidIntent] 关单后复核未成功返回，保留意图:',
      orderNo, recheck && recheck.code, recheck && recheck.msg)
    throw new Error('CONFLICT: PAYMENT_STATUS_UNCERTAIN: 暂时无法确认支付结果，请稍后重试')
  }
  if (LAKALA_PAID_TRADE_STATES.includes(recheckState)) {
    throw new Error('CONFLICT: PAYMENT_ALREADY_SUCCEEDED: 支付已成功，正在更新订单，请稍后刷新')
  }
  if (!LAKALA_RELEASABLE_TRADE_STATES.includes(recheckState)) {
    console.warn('[order/voidIntent] 关单后仍非终态，保留意图:', orderNo, recheckState)
    throw new Error('CONFLICT: PAYMENT_INTENT_ACTIVE: 支付结果仍在确认中，请稍后再试')
  }

  if (!await confirmIntentReleased(orderNo, outTradeNo)) {
    throw new Error('CONFLICT: PAYMENT_INTENT_CHANGED: 支付状态已变化，请刷新订单后重试')
  }
  return 'released'
}

function activePaymentIntentError(order) {
  const err = new Error('CONFLICT: PAYMENT_INTENT_ACTIVE: 本次支付单已生成，请勿重复发起')
  err.activeOutTradeNo = order.lakala_out_order_no
  err.activeStoreId = order.store_id
  err.activeMerchant = order._lakalaMerchant
  return err
}

function normalizeRequestedPayAmount(payAmountInput) {
  if (payAmountInput === undefined || payAmountInput === null) return null
  const value = Number(payAmountInput)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('INVALID_PARAMS: 支付金额无效')
  }
  if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) {
    throw new Error('INVALID_PARAMS: 支付金额最多保留 2 位小数')
  }
  return Math.round(value * 100) / 100
}

/**
 * 在单个行锁事务内重读订单资金快照、校验卡余额、计算本次金额并预占拉卡拉单号。
 * payment_method / client_user_id 的支付计划更新必须以刚预占的精确 out_trade_no 为 CAS。
 */
async function reserveDirectOnlinePaymentIntent({
  orderNo,
  userId,
  payAmountInput,
  paymentMethod,
  outTradeNo,
  requireAlipayShareSource = false,
}) {
  const requestedAmount = normalizeRequestedPayAmount(payAmountInput)
  return pg.transaction(async (client) => {
    const lockedRes = await client.query(
      `SELECT sale_order_id, status, sale_order_type, store_id, client_user_id, opened_by,
              sale_order_datetime, total_amount, payable_amount, prepaid_card_amount,
              pending_prepaid_card_amount, received, refunded_amount, first_payment_amount,
              lakala_out_order_no, lakala_payment_intent
       FROM sale_orders
       WHERE sale_order_id = $1
       FOR UPDATE`,
      [orderNo]
    )
    if (lockedRes.rows.length === 0) {
      throw new Error('INVALID_PARAMS: 订单不存在')
    }
    const order = lockedRes.rows[0]

    if (order.client_user_id) {
      if (order.client_user_id !== userId) {
        throw new Error('PERMISSION_DENIED: 无权操作该订单')
      }
    } else if (!order.opened_by) {
      throw new Error('INVALID_PARAMS: 订单不存在')
    }
    if (!['待支付', '部分支付'].includes(order.status)) {
      throw new Error('INVALID_PARAMS: 订单状态不允许支付')
    }
    if (order.status === '待支付' && !order.opened_by) {
      const orderTime = new Date(order.sale_order_datetime)
      if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
        throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
      }
    }

    const totalAmount = Math.round(Number(order.total_amount || 0) * 100) / 100
    const prepaidAmount = Math.round(Number(order.prepaid_card_amount || 0) * 100) / 100
    const pendingPrepaidAmount = Math.round(Number(order.pending_prepaid_card_amount || 0) * 100) / 100
    const computedPayableAmount = Math.round(
      (totalAmount - prepaidAmount - pendingPrepaidAmount) * 100
    ) / 100
    const rawStoredPayableAmount = order.payable_amount == null
      ? null
      : Math.round(Number(order.payable_amount || 0) * 100) / 100
    const effectivePayableAmount = order.sale_order_type === '充值单'
      ? (rawStoredPayableAmount == null ? computedPayableAmount : rawStoredPayableAmount)
      : (rawStoredPayableAmount != null && rawStoredPayableAmount > 0
          ? rawStoredPayableAmount
          : computedPayableAmount)
    const receivedAmount = Math.round(Number(order.received || 0) * 100) / 100
    const refundedAmount = Math.round(Number(order.refunded_amount || 0) * 100) / 100
    const netReceived = Math.round((receivedAmount - refundedAmount) * 100) / 100
    const remainingBase = order.sale_order_type === '充值单'
      ? effectivePayableAmount
      : totalAmount - pendingPrepaidAmount
    const remaining = Math.round((remainingBase - netReceived) * 100) / 100

    if (effectivePayableAmount <= 0 && order.status === '待支付') {
      return {
        prepaidFull: true,
        orderNo,
        totalAmount: order.total_amount,
        status: '已支付',
      }
    }
    if (remaining <= 0) {
      throw new Error('INVALID_STATE: 订单无欠款')
    }

    const firstPaymentCap = Math.round(Number(order.first_payment_amount || 0) * 100) / 100
    const effectiveRemaining = firstPaymentCap > 0
      ? Math.min(remaining, firstPaymentCap)
      : remaining
    const payAmount = requestedAmount == null ? effectiveRemaining : requestedAmount
    if (payAmount > effectiveRemaining + 0.001) {
      throw new Error('INVALID_PARAMS: 支付金额超过剩余应付')
    }
    if (firstPaymentCap > 0 && payAmount + 0.001 < effectiveRemaining) {
      throw new Error('INVALID_PARAMS: 支付金额必须等于本次冻结金额')
    }

    if (pendingPrepaidAmount > 0) {
      const cardRes = await client.query(
        'SELECT balance FROM prepaid_cards WHERE user_id = $1 FOR UPDATE',
        [userId]
      )
      if (cardRes.rows.length === 0
          || Number(cardRes.rows[0].balance || 0) + 0.001 < pendingPrepaidAmount) {
        throw new Error('INSUFFICIENT_BALANCE: 储值卡余额不足，请重新选择抵扣金额')
      }
    }

    if (requireAlipayShareSource && !lakalaConfig.readConfig().alipayShareSource) {
      throw new Error('INVALID_STATE: ALIPAY_NOT_AVAILABLE: 暂不支持支付宝，请使用微信支付')
    }

    const merchant = await resolveLakalaMerchantInTransaction(client, order.store_id)
    if (!merchant) {
      throw new Error('INVALID_STATE: LAKALA_NOT_CONFIGURED: 该门店未启用拉卡拉聚合支付，请联系管理员')
    }

    if (order.lakala_out_order_no) {
      // issue #214：顾客唤起支付后没付就退出，渠道单仍在有效期内（trade_state=CREATE/INIT），
      // 旧逻辑一律拒绝 → 再进来就「无法支付」。这里改为优先**复用**同一笔场次，把原
      // paymentParams 回发给前端重新唤起。复用比「关旧单建新单」安全：全程只有一笔渠道单，
      // 不会出现旧单被付款而 payNotify 判为「非当前意图」拒绝入账的资金窟窿。
      const reusable = tryReuseLakalaPaymentIntent(order, { payAmount, paymentMethod, userId })
      if (reusable) {
        return {
          prepaidFull: false,
          reused: true,
          orderNo,
          outTradeNo: order.lakala_out_order_no,
          storeId: order.store_id,
          status: order.status,
          totalAmount: order.total_amount,
          payAmount,
          pendingPrepaidAmount,
          merchant,
          paymentParams: reusable.paymentParams,
        }
      }
      order._lakalaMerchant = merchant
      throw activePaymentIntentError(order)
    }

    const claimRes = await client.query(
      `UPDATE sale_orders
       SET lakala_out_order_no = $1, updated_at = NOW()
       WHERE sale_order_id = $2
         AND status = $3
         AND lakala_out_order_no IS NULL
       RETURNING sale_order_id`,
      [outTradeNo, orderNo, order.status]
    )
    if (claimRes.rowCount !== 1) {
      throw new Error('CONFLICT: PAYMENT_INTENT_CHANGED: 支付场次已变化，请刷新后重试')
    }

    const planRes = await client.query(
      `UPDATE sale_orders
       SET client_user_id = CASE
             WHEN client_user_id IS NULL AND opened_by IS NOT NULL THEN $1
             ELSE client_user_id
           END,
           payment_method = $2,
           updated_at = NOW()
       WHERE sale_order_id = $3
         AND status = $4
         AND lakala_out_order_no = $5
       RETURNING sale_order_id`,
      [userId, paymentMethod, orderNo, order.status, outTradeNo]
    )
    if (planRes.rowCount !== 1) {
      throw new Error('CONFLICT: PAYMENT_INTENT_CHANGED: 支付场次已变化，请刷新后重试')
    }

    return {
      prepaidFull: false,
      orderNo,
      outTradeNo,
      storeId: order.store_id,
      status: order.status,
      totalAmount: order.total_amount,
      payAmount,
      pendingPrepaidAmount,
      merchant,
    }
  })
}

async function reserveDirectOnlinePaymentIntentWithTerminalRetry(options) {
  let excludedOutTradeNo = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const outTradeNo = buildLakalaOutTradeNo(options.orderNo, excludedOutTradeNo)
    try {
      return await reserveDirectOnlinePaymentIntent({ ...options, outTradeNo })
    } catch (err) {
      if (!err || !err.activeOutTradeNo || attempt > 0) throw err
      const merchant = err.activeMerchant || await resolveLakalaMerchant(err.activeStoreId)
      if (!merchant) throw err
      try {
        const oldTrade = await lakalaClient.queryTrade({
          merchantNo: merchant.merchantNo,
          termNo: merchant.termNo,
          outTradeNo: err.activeOutTradeNo,
        })
        // 必须先验 ok：业务失败码的响应里也可能带非权威的 CLOSE，据此释放旧意图会
        // 凭空造出第二笔可支付的单，旧单迟到付款将无法入账（双谱系评审 round-2）
        if (!oldTrade || oldTrade.ok !== true
            || !LAKALA_RELEASABLE_TRADE_STATES.includes(normalizeTradeState(oldTrade.tradeState))) {
          throw err
        }
        await releaseLakalaPaymentIntent(options.orderNo, err.activeOutTradeNo)
        excludedOutTradeNo = err.activeOutTradeNo
      } catch (queryErr) {
        if (queryErr === err) throw err
        console.warn('[order/reserveDirectOnlinePaymentIntent] 旧意图状态不确定，保留:', options.orderNo, queryErr && queryErr.message)
        throw err
      }
    }
  }
  throw new Error('CONFLICT: PAYMENT_INTENT_ACTIVE: 本次支付单已生成，请勿重复发起')
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
    timeoutMs: LAKALA_SHARE_CODE_TIMEOUT_MS,
  })
  if (!resp.shareToken) {
    // 同上：渠道回了成功但没给吱口令，落盘也是一份不可用的快照
    throw new Error('INVALID_STATE: LAKALA_SHARE_CODE_INCOMPLETE: 渠道未返回吱口令')
  }
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
    const orderRows = await client.query(
      `SELECT client_user_id, points_used
         FROM sale_orders
        WHERE sale_order_id = $1
          AND status = '待支付'
          AND opened_by IS NULL
        FOR UPDATE`,
      [orderNo],
    )
    if (orderRows.rows.length === 0) return false

    const result = await client.query(
      `UPDATE sale_orders
       SET status = '已关闭',
           pending_prepaid_card_amount = 0,
           payable_amount = CASE
             WHEN sale_order_type IN ('销售单','内部单','转换单')
               THEN GREATEST(0, total_amount::numeric - prepaid_card_amount::numeric)
             ELSE payable_amount
           END,
           updated_at = NOW()
       WHERE sale_order_id = $1
         AND status = '待支付'
         AND opened_by IS NULL
         AND lakala_out_order_no IS NULL`,
      [orderNo]
    )
    if (result.rowCount > 0) {
      await client.query(
        `UPDATE user_coupons SET status = '未使用', used_sale_order_id = NULL, used_at = NULL
         WHERE used_sale_order_id = $1`,
        [orderNo]
      )
      await releasePointsDeduction(client, {
        saleOrderId: orderNo,
        userId: orderRows.rows[0].client_user_id,
        pointsUsed: orderRows.rows[0].points_used,
      })
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
 * 顾客自助下单时复核 SKU 的市场范围。
 *
 * 目录允许未绑定门店用户先浏览全市场商品下配置的市场 SKU，但提交订单时
 * 必须以本次订单的目标门店为准重新授权。NULL 表示全市场；空字符串/纯空白
 * 表示没有可见市场；其余值是逗号分隔的市场 org_nodes.id，兼容历史市场名。
 * 过滤放在 SQL 中，避免只依赖前端目录或 auth 缓存造成跨市场下单。
 */
function buildOrderSkuMarketScopeFilter(params, storeId, tableAlias = 'sk') {
  const scopeExpr = `${tableAlias}.market_scope`
  const normalizedScopeExpr = `regexp_replace(${scopeExpr}, '[[:space:]]+', '', 'g')`
  const valuesExpr = `string_to_array(${normalizedScopeExpr}, ',')`
  const storeParam = `$${params.length + 1}`
  params.push(storeId)

  return `AND (
    ${scopeExpr} IS NULL
    OR (
      NULLIF(${normalizedScopeExpr}, '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM stores scope_store
        JOIN org_nodes scope_store_node ON scope_store.org_node_id = scope_store_node.id
        JOIN org_nodes scope_market_node
          ON scope_store_node.parent_id = scope_market_node.id
         AND scope_market_node.type = '市场'
        WHERE scope_store.store_id = ${storeParam}
          AND (
            scope_market_node.id = ANY(${valuesExpr})
            OR regexp_replace(scope_market_node.name, '[[:space:]]+', '', 'g') = ANY(${valuesExpr})
          )
      )
    )
  )`
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

  const { userId } = ctx.auth
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
      si.prepaid_card_received, si.cash_received,
      si.sale_amount, si.session_count,
      COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
      si.product_name,
      (SELECT p.cover_image FROM mall_product_skus mps
       JOIN products p ON mps.product_id = p.product_id
       WHERE mps.sku_id = si.sku_id LIMIT 1) AS cover_image
    FROM sale_items si
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [targetOrderId])

  // 行级退款额（已退行不可继续支付/回款）
  const itemRefundMap = await getPerItemRefundedMap(pg, targetOrderId)

  // 应付实金 = total - prepaid_card_amount（payable_amount 列冗余，兜底现算）
  const totalAmount = Number(order.total_amount || 0)
  const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
  const pendingPrepaidCardAmount = Number(order.pending_prepaid_card_amount || 0)
  const payableAmount = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmount - prepaidCardAmount - pendingPrepaidCardAmount) * 100) / 100
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
      pendingPrepaidCardAmount,
      payableAmount,
      received,
      refundedAmount,
      firstPaymentAmount,
      isExperienceConversion: order.is_experience_conversion === true,
      paymentMethod: order.payment_method || '微信',
      couponDiscount: Number(order.coupon_discount || 0),
      pointsUsed: Number(order.points_used || 0),
      pointsDiscount: Number(order.points_discount || 0),
      // #214：本人是否有一笔可续付的支付场次（双谱系评审 round-7）。
      //
      // 只下发布尔值，**绝不下发快照本身**（里面有 paySign/prepay_id）。前端据此决定
      // 重入时走 order.pay（能复用场次）还是 order.repay（fail-fast，会撞
      // PAYMENT_INTENT_ACTIVE）—— 普通回款此前固定走 repay，导致「退出后重新扫码
      // 还是付不了」在回款场景下原样复现，正是本 issue 要消灭的症状。
      //
      // 判据含 client_user_id 匹配，对员工开单同样成立：归属是在**预占支付意图那一刻**
      // 由 reserve 的 planRes 写入的（`client_user_id = CASE WHEN ... IS NULL AND
      // opened_by IS NOT NULL THEN $1`），不是等支付成功才写。所以「顾客扫码建了场次
      // 又退出」时归属已经落定，重入能正确识别（round-8 复核过这个时序）。
      hasResumablePaymentIntent: Boolean(
        String(order.lakala_out_order_no || '').trim()
        && order.client_user_id
        && order.client_user_id === userId
      ),
    },
    items: items.map(i => ({
      saleItemId: i.sale_item_id,
      productName: i.product_name,
      unitPrice: i.unit_price,
      quantity: i.quantity,
      // sale_amount = 行应付总额（权威），前端按此展示；unitPrice/sessionCount 仅供"×N次/单价"辅助提示
      saleAmount: i.sale_amount,
      sessionCount: i.session_count,
      unit: i.unit,
      received: i.received,
      prepaidCardReceived: i.prepaid_card_received,
      cashReceived: i.cash_received,
      refundedAmount: Number(itemRefundMap.get(i.sale_item_id) || 0),
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
    prepaidCardAmount: inputPrepaidCardAmount, // 可选, 前端传的抵扣金额
    usePoints, // 可选, 是否使用积分抵扣
    pointsUsed: inputPointsUsed // 可选, 前端传的积分抵扣数量
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
  const skuQueryParams = [skuIds]
  const skuMarketScopeFilter = buildOrderSkuMarketScopeFilter(skuQueryParams, storeId)
  const skuResults = await pg.query(`
    SELECT
      sk.sku_id, sk.product_type, sk.spec_name,
      sk.price, sk.special_price, sk.session_count,
      sk.category_id, sk.is_experience, pc.sales_category
    FROM product_skus sk
    JOIN product_categories pc ON sk.category_id = pc.category_id
    WHERE sk.sku_id = ANY($1) AND sk.deleted_at IS NULL
      ${skuMarketScopeFilter}
  `, skuQueryParams)

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

  // 查询顾客姓名 + 会员身份（customer_type + member_level），供会员价分流（会员价 vs 标价）。
  let customerName = null
  let documentType
  let buyerIsMember = false
  {
    const userRows = await pg.query(
      'SELECT name, customer_type, member_level FROM client_wechat_users WHERE user_id = $1',
      [userId]
    )
    if (userRows.length > 0) {
      if (userRows[0].name) customerName = userRows[0].name
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
  const rawItemsData = items.map(item => {
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
    // 先按购物车行计算总次数；疗程卡 quantity>1 会在下方拆成独立卡实体。
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
  // B2：疗程卡 quantity>1 必须按"每张卡"拆成 N 行 sale_items。
  // 前端购物车继续按 SKU 合并 quantity；后端落库保持每张卡独立，避免 5 次卡 ×2 变成 1 张 10 次卡。
  const itemsData = []
  for (const d of rawItemsData) {
    if (d.productType === '疗程卡' && d.quantity > 1) {
      const n = d.quantity
      const perSession = d.sessionCount != null ? Math.round(d.sessionCount / n) : null
      const totalSaleCents = Math.round(Number(d.saleAmount || 0) * 100)
      const perSaleCents = Math.round(totalSaleCents / n)
      const totalReceivedCents = Math.round(Number(d.received || 0) * 100)
      const perReceivedCents = Math.round(totalReceivedCents / n)

      for (let i = 0; i < n; i++) {
        const isLast = i === n - 1
        const saleCents = isLast
          ? totalSaleCents - perSaleCents * (n - 1)
          : perSaleCents
        const receivedCents = isLast
          ? totalReceivedCents - perReceivedCents * (n - 1)
          : perReceivedCents
        const saleAmount = Math.round(saleCents) / 100
        const received = Math.round(receivedCents) / 100
        const denom = (perSession != null && perSession > 0) ? perSession : 1
        const listTotalRow = Math.round(Number(d.listUnit || 0) * 100) / 100
        itemsData.push({
          ...d,
          sessionCount: perSession,
          remainingSessions: perSession,
          quantity: 1,
          saleAmount,
          received,
          unitRealPrice: denom > 0 ? Math.round((saleAmount / denom) * 100) / 100 : saleAmount,
          unitPrice: denom > 0 ? Math.round((listTotalRow / denom) * 100) / 100 : listTotalRow,
        })
      }
    } else {
      itemsData.push(d)
    }
  }
  totalAmount = Math.round(itemsData.reduce((s, d) => s + d.saleAmount, 0) * 100) / 100
  const rawTotalBeforeDeductions = totalAmount

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

  let pointsUsed = 0
  let pointsDiscount = 0
  if (usePoints || inputPointsUsed != null) {
    const [pointsToYuanRate, pointsDeductionMaxRate, pointsRows] = await Promise.all([
      getPointsToYuanRate(),
      getPointsDeductionMaxRate(),
      pg.query('SELECT points_balance FROM client_wechat_users WHERE user_id = $1', [userId]),
    ])
    const deduction = computePointsDeduction({
      usePoints,
      requestedPoints: inputPointsUsed,
      pointsBalance: pointsRows[0]?.points_balance,
      rawTotal: rawTotalBeforeDeductions,
      currentAmount: totalAmount,
      pointsToYuanRate,
      pointsDeductionMaxRate,
    })
    pointsUsed = deduction.pointsUsed
    pointsDiscount = deduction.pointsDiscount
    if (pointsDiscount > 0) {
      applyOrderLevelDiscountToItems(itemsData, pointsDiscount)
      totalAmount = roundMoney(itemsData.reduce((sum, d) => sum + d.saleAmount, 0))
    }
  }

  // document_type 在创建事务内写预测值；首次成功入账路径会按达标次数再次冻结权威快照。

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
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', ['sale_order_id_gen'])

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
    documentType = await classifySaleOrderDocumentType(client, userId, orderNo)

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
    //   - payable_amount = total_amount - actual prepaid - pending prepaid（约定现金应付）
    //   - 全额抵扣单的 received = prepaidCardAmount（储值卡抵扣等同已收；券全额抵扣 prepaidCardAmount=0 → received=0）
    const initialStatus = zeroPayable ? '已支付' : '待支付'
    const initialReceived = zeroPayable ? prepaidCardAmount : 0
    const initialSettledPrepaid = prepaidFullPaid ? prepaidCardAmount : 0
    const initialPendingPrepaid = prepaidFullPaid ? 0 : prepaidCardAmount
    await client.query(
      `INSERT INTO sale_orders (
        sale_order_id, status, sale_order_type, document_type, market_name, store_id, store_name,
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, prepaid_card_amount, pending_prepaid_card_amount, received, payable_amount, payment_method,
        preferred_employee_id, coupon_id, coupon_discount, points_used, points_discount,
        paid_at, created_at, updated_at
      ) VALUES ($1, $2, '销售单', $3, $4, $5, (SELECT store_name FROM stores WHERE store_id = $5), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $6, $6)`,
      [
        orderNo, initialStatus, documentType, marketName, storeId, now, userId,
        ctx.auth.phone || null, customerName,
        totalAmount, initialSettledPrepaid, initialPendingPrepaid, initialReceived, paidAmount, effectivePaymentMethod,
        preferredStaffWfId || null, inputCouponId || null, couponDiscount, pointsUsed, pointsDiscount,
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

    if (pointsUsed > 0) {
      await deductPointsAtCreation(client, { saleOrderId: orderNo, userId, pointsUsed })
    }

    // 创建订单明细（流水号递增）。联动开启时冻结家居产品库存组成；临时关闭时写 null，不阻断建单。
    const compositionSnapshots = await loadInventoryCompositionSnapshots(client, itemsData)
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
          sale_amount, received, pending_received, sales_category, is_experience,
          inventory_composition_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '0', $13, $14, $15, $16::jsonb)`,
        [
          saleItemId, orderNo, storeId, d.skuId,
          d.productName, d.productType,
          d.sessionCount, d.remainingSessions,
          d.unitPrice, d.quantity, d.unitRealPrice,
          d.saleAmount, d.received, d.salesCategory || null, d.isExperience,
          compositionSnapshots.has(d.skuId) ? JSON.stringify(compositionSnapshots.get(d.skuId)) : null,
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
    // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
    await recalcPaidSessionsForOrder(client, orderNo)

    // 零应付单（券/卡全额抵扣）补结算：积分链净额差值法（幂等）+ 会员等级即时重算。
    // 券全额单 received=0 → netSettled=0 → delta=0 → 无积分写入；卡全额单 received=卡额，
    // 与既有 confirmPrepaidFull 口径一致。零应付单永远不会有 payNotify/confirmOffline 来触发结算，
    // 故必须在创建时就地结算（与"所有转已支付的触发点走同一入口"原则一致）。
    if (zeroPayable) {
      // 五件套：积分 + 消费档位 + 客户分类跃迁（became_member_at + is_membership_upgrade 打标）+ 分享礼
      await settlePaidEffects(client, { saleOrderId: orderNo, clientUserId: userId, paidAmount: prepaidCardAmount, source: 'clientApi.create.zeroPayable' })
    }
  })

  if (zeroPayable) {
    ctx.result = {
      orderNo,
      saleOrderId: orderNo,
      totalAmount,
      pointsUsed,
      pointsDiscount,
      prepaidCardAmount: finalPrepaidCardAmount,
      pendingPrepaidCardAmount: 0,
      paidAmount: finalPaidAmount,
      paymentMethod: finalPaymentMethod,
      status: '已支付',
      // 卡全额抵扣保留 'prepaid_card_full'（前端老逻辑判定）；券全额抵扣用 'coupon_full'。
      // 两者前端处理一致（跳详情、不唤起支付），reason 仅供文案/埋点区分。
      reason: finalPrepaidCardAmount > 0 ? 'prepaid_card_full' : (pointsDiscount > 0 ? 'points_full' : 'coupon_full'),
      paymentParams: null,
    }
    return
  }

  ctx.result = {
    orderNo,
    saleOrderId: orderNo,
    totalAmount,
    pointsUsed,
    pointsDiscount,
    prepaidCardAmount: 0,
    pendingPrepaidCardAmount: finalPrepaidCardAmount,
    paidAmount: finalPaidAmount,
    paymentMethod: finalPaymentMethod,
    status: '待支付'
  }
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

  const preflightOrder = orders[0]

  // 事务前只做快速鉴权/自助超时清理；资金字段和状态必须在后续 FOR UPDATE 后重读。
  if (preflightOrder.client_user_id) {
    if (preflightOrder.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
  } else if (!preflightOrder.opened_by) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  // 10分钟超时检查仅对 '待支付' 且顾客自助单(opened_by 为空)生效：
  // 部分支付订单已有首次到账不自动过期；员工单不套用自助超时（closeExpiredOrder 内部跳过，issue #27）
  if (preflightOrder.status === '待支付') {
    const orderTime = new Date(preflightOrder.sale_order_datetime)
    if (Date.now() - orderTime.getTime() > 10 * 60 * 1000) {
      const closed = await closeExpiredOrder(orderNo)
      if (closed) throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
    }
  }

  let reservation = await reserveDirectOnlinePaymentIntentWithTerminalRetry({
    orderNo,
    userId,
    payAmountInput,
    paymentMethod: '微信',
  })
  if (reservation.prepaidFull) {
    ctx.result = {
      orderNo,
      status: '已支付',
      reason: Number(preflightOrder.prepaid_card_amount || 0) > 0
        || Number(preflightOrder.pending_prepaid_card_amount || 0) > 0
        ? 'prepaid_card_full'
        : (Number(preflightOrder.points_used || 0) > 0 ? 'points_full' : 'coupon_full'),
      paymentParams: null,
    }
    return
  }

  // issue #214：命中复用则不再向渠道下单，直接回发原场次参数让顾客继续付同一笔。
  // 回发前先确认渠道侧这笔场次仍可支付（事务已提交，这里做 HTTPS 往返是安全的）；
  // 若渠道已终态，helper 会释放意图并返回 false，这里重新预占一笔新场次，顾客无感。
  if (reservation.reused
      && !await ensureReusedIntentStillPayable(orderNo, reservation.outTradeNo, reservation.merchant)) {
    reservation = await reserveDirectOnlinePaymentIntentWithTerminalRetry({
      orderNo,
      userId,
      payAmountInput,
      paymentMethod: '微信',
    })
  }
  let paymentParams = reservation.paymentParams
  if (!reservation.reused) {
    const cfg = lakalaConfig.readConfig()
    const preorderResp = await createLakalaPreorder({
      orderNo,
      outTradeNo: reservation.outTradeNo,
      storeId: reservation.storeId,
      merchantNo: reservation.merchant.merchantNo,
      termNo: reservation.merchant.termNo,
      payAmountYuan: reservation.payAmount,
      accountType: 'WECHAT',
      transType: '71',
      openid: ctx.auth.openid,
      subAppid: cfg.subAppid,
      requestIp: getRequestIp(),
    })
    paymentParams = preorderResp.paymentParams
    await persistLakalaPaymentIntentSnapshot(orderNo, reservation.outTradeNo,
      buildWechatIntentSnapshot(reservation.outTradeNo, reservation.payAmount, paymentParams))
  }
  // first_payment_amount 必须保留到真实支付回调入账；仅发起预下单不代表付款成功。
  // payNotify 成功写入首笔款项时再清空，避免顾客放弃付款后重新扫码被放大到全额。
  ctx.result = {
    orderNo,
    totalAmount: reservation.totalAmount,
    paidAmount: reservation.payAmount,
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
  if (order.lakala_out_order_no) {
    throw new Error('CONFLICT: PAYMENT_INTENT_ACTIVE: 在线支付仍在处理中，暂不能改为线下付款')
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
  const pendingPrepaidCardAmountOff = Number(order.pending_prepaid_card_amount || 0)
  const payableAmountOff = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmountOff - prepaidCardAmountOff - pendingPrepaidCardAmountOff) * 100) / 100
  if (payableAmountOff === 0) {
    ctx.result = {
      orderNo,
      status: '已支付',
      reason: prepaidCardAmountOff > 0 ? 'prepaid_card_full' : (Number(order.points_used || 0) > 0 ? 'points_full' : 'coupon_full'),
    }
    return
  }

  const now = new Date()
  const offlineUpd = await pg.query(
    "UPDATE sale_orders SET client_user_id = COALESCE(client_user_id, $1), payment_method = '线下', updated_at = $2 WHERE sale_order_id = $3 AND status = '待支付' AND lakala_out_order_no IS NULL",
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
      o.pending_prepaid_card_amount,
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
        si.prepaid_card_received,
        si.cash_received,
        si.sale_amount,
        si.session_count,
        si.remaining_sessions,
        si.paid_sessions,
        COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
        si.product_name,
        si.product_type,
        (SELECT p.cover_image FROM mall_product_skus mps
         JOIN products p ON mps.product_id = p.product_id
         WHERE mps.sku_id = si.sku_id LIMIT 1) AS cover_image
      FROM sale_items si
      LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
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

    // 行级退款额（已退行不可继续支付/回款）：批量聚合避免 N+1
    const refundMapBatch = await getPerItemRefundedMapBatch(pg, orderIds)

    for (const order of orders) {
      const orderItems = itemsMap.get(order.sale_order_id) || []
      const orderRefundMap = refundMapBatch.get(order.sale_order_id)
      if (orderRefundMap) {
        for (const it of orderItems) {
          it.refunded_amount = Number(orderRefundMap.get(it.sale_item_id) || 0)
        }
      }
      order.items = orderItems
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
      si.sale_item_group_id,
      si.sale_order_id,
      si.sku_id,
      si.item_direction,
      si.ref_sale_item_id,
      si.product_name,
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.paid_sessions,
      COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
      si.unit_price,
      si.unit_real_price,
      si.quantity,
      si.sale_amount,
      si.received,
      si.prepaid_card_received,
      si.cash_received,
      si.pending_received,
      si.expire_date,
      si.remark,
      si.sales_category,
      si.picked_up_quantity,
      (SELECT p.cover_image FROM mall_product_skus mps
       JOIN products p ON mps.product_id = p.product_id
       WHERE mps.sku_id = si.sku_id LIMIT 1) AS cover_image
    FROM sale_items si
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    WHERE si.sale_order_id = $1
    ORDER BY si.sale_item_id
  `, [orderNo])

  // 行级退款额（已退行不可继续支付/回款）
  const itemRefundMap = await getPerItemRefundedMap(pg, orderNo)
  for (const it of items) {
    it.refunded_amount = Number(itemRefundMap.get(it.sale_item_id) || 0)
  }

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

  // #214：这里是 `SELECT o.*` 原样展开，新增的 lakala_payment_intent 里含 paySign 等支付凭据，
  // 必须在下发前剥掉（schema 注释也写明「不随 order.detail 下发」）。scanDetail / list 是显式
  // 字段映射，天然不受影响；只有本处的整行展开会把新列带出去。
  const { lakala_payment_intent: _omitPaymentIntent, ...orderForClient } = order

  ctx.result = {
    order: {
      ...orderForClient,
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

  // issue #214 的归属边界（双谱系评审 round-1 收紧）：
  //
  // 甲方诉求是「顾客扫码后未付款能立刻取消」。中途一度放宽到「未认领的员工开单也可取消」，
  // 但订单号是可枚举的日序号（FY-XSD-WX-{YYMMDD}{4位序号}），那等于把**破坏性操作**的
  // 授权凭据降级成一个可猜的字符串：攻击者枚举当日序号就能关掉别人的待支付单，还会顺带
  // 把归属认领走。`order.pay` 允许未认领单是因为「替别人付钱」无害，取消不同源。
  //
  // 因此这里要求 client_user_id 必须已是本人。真实链路上这不影响核心诉求：顾客只要
  // 调整过抵扣方案或发起过支付，client_user_id 就已写入——而「卡在支付意图上取消不掉」
  // 恰恰只发生在发起过支付之后。扫码后零操作的单仍由店员关闭。
  // 若将来要覆盖「扫码即可取消」，正解是给二维码带不可预测的一次性 capability token，
  // 而不是继续放宽订单号本身的权限。
  const orders = await pg.query(
    'SELECT * FROM sale_orders WHERE sale_order_id = $1 AND client_user_id = $2',
    [orderNo, userId]
  )

  if (orders.length === 0) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  const order = orders[0]

  // #182：转换单不能由顾客自行取消。关闭待支付转换单必须走 staff/admin 的
  // rollbackPendingConversionOnClose——它要还原源卡次数、家居已结算数量，以及折抵时
  // 下调的原单应付（waived_amount）。从这里直接置「已关闭」会绕过全部回滚，
  // 源卡权益永久蒸发、原单欠款被永久抹掉。与 card.js 的 _closeExpiredPendingByUser
  // 同一道闸门（它已显式排除转换单）。
  if (order.sale_order_type === '转换单') {
    throw new Error('INVALID_PARAMS: 转换单不支持自行取消，请联系门店处理')
  }

  // 允许取消状态：待支付（常规）、已支付（仅全额抵扣单，需回冲储值卡）
  // 2026-04-26 sale-order-domain-refactor:
  //   - paid_amount 已删除 → 全额抵扣判定改为 payable_amount=0（即 total = prepaid_card_amount）
  const prepaidCardAmount = Number(order.prepaid_card_amount || 0)
  const pointsUsedCnl = Number(order.points_used || 0)
  const pendingPrepaidCardAmount = Number(order.pending_prepaid_card_amount || 0)
  const totalAmountCnl = Number(order.total_amount || 0)
  const payableAmountCnl = Number(order.payable_amount || 0) > 0
    ? Number(order.payable_amount)
    : Math.round((totalAmountCnl - prepaidCardAmount - pendingPrepaidCardAmount) * 100) / 100
  const isPrepaidFull = (prepaidCardAmount > 0 || pointsUsedCnl > 0) && payableAmountCnl === 0
  const cancelableStatuses = ['待支付']
  if (isPrepaidFull && order.status === '已支付') {
    // 全额抵扣单顾客确认立刻取消：允许回冲
    cancelableStatuses.push('已支付')
  }
  if (!cancelableStatuses.includes(order.status)) {
    throw new Error('INVALID_PARAMS: 当前订单状态不允许取消')
  }

  // 作废渠道意图必须排在状态闸门**之后**（双谱系评审 round-1）：
  // 否则对一张「部分支付」单点取消，会先把顾客正在用的补款场次销毁掉，
  // 然后才返回「当前订单状态不允许取消」——订单没关成，合法支付却被打断。
  //
  // wx.requestPayment 失败/取消只发生在小程序侧，云函数不会自动获知，预下单写入的
  // lakala_out_order_no 因此可能残留。#214 之前这里只在渠道已是终态时才放行，未付款的
  // 场次（CREATE/INIT）一律拒绝「请稍后再取消」——顾客得等拉卡拉 10 分钟超时 +
  // payNotify 定时补偿扫到，实测约 20 分钟。现在改为主动向渠道关单后再取消；
  // 关不掉就仍然不放行（fail-closed，见 helper 注释）。
  if (order.lakala_out_order_no) {
    await voidActiveLakalaPaymentIntent(orderNo, {
      outTradeNo: order.lakala_out_order_no,
      storeId: order.store_id,
    })
    order.lakala_out_order_no = null
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
    //
    const allowedStatusList = cancelableStatuses // 已根据 isPrepaidFull 计算
    const updRes = await client.query(
      `UPDATE sale_orders SET status = '已关闭',
           pending_prepaid_card_amount = 0,
           payable_amount = CASE
             WHEN sale_order_type IN ('销售单','内部单','转换单')
               THEN GREATEST(0, total_amount::numeric - prepaid_card_amount::numeric)
             ELSE payable_amount
           END,
           updated_at = $1
       WHERE sale_order_id = $2
         AND client_user_id = $3
         AND status = ANY($4::order_status[])
         AND lakala_out_order_no IS NULL
         -- #182 第二道闸门（函数入口已早退）：即便将来有人绕过入口校验，也不能从这里
         -- 关掉转换单——那会跳过 rollbackPendingConversionOnClose 的次数/数量/欠款还原。
         AND sale_order_type <> '转换单'`,
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
    await releasePointsDeduction(client, { saleOrderId: orderNo, userId, pointsUsed: pointsUsedCnl })

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
          // 取消全额储值卡单是对原扣款的作废：流水不再属于已结算，
          // actual prepaid 与行级通道分摊由后续统一重算归零。
          await client.query(
            `UPDATE sale_order_payments
                SET status = '已作废', allocation_status = NULL
              WHERE sale_order_id = $1
                AND change_type = '储值卡抵扣'
                AND payment_method = '储值卡'
                AND status = '已支付'`,
            [orderNo]
          )
          await client.query(
            `UPDATE sale_orders
                SET received = 0, refunded_amount = 0,
                    prepaid_card_amount = 0, pending_prepaid_card_amount = 0,
                    payable_amount = CASE
                      WHEN sale_order_type IN ('销售单','内部单','转换单') THEN total_amount
                      ELSE payable_amount
                    END,
                    updated_at = NOW()
              WHERE sale_order_id = $1`,
            [orderNo]
          )
          await recalcPaidSessionsForOrder(client, orderNo)
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
 * 查询有效订单（已支付/部分支付/已完成）中有剩余次数的项目(疗程卡)
 */
async function appointableItems(ctx) {
  const { userId } = ctx.auth
  const { includeInactive } = ctx.event.payload || {}

  const activeFilter = includeInactive
    ? ''
    : `AND si.remaining_sessions > 0
      AND (si.expire_date IS NULL OR si.expire_date > CURRENT_DATE)
      AND (
        si.paid_sessions IS NULL
        OR si.paid_sessions > (si.session_count - si.remaining_sessions)
      )`

  const items = await pg.query(`
    SELECT
      o.sale_order_id,
      o.status AS order_status,
      o.sale_order_datetime,
      o.paid_at,
      o.sale_order_type,
      o.document_type,
      o.legacy_source,
      o.remark AS order_remark,
      o.store_id AS order_store_id,
      s.store_name,
      o.market_name,
      o.preferred_employee_id,
      si.sale_item_id,
      si.store_id AS item_store_id,
      si.sku_id,
      si.item_direction,
      si.ref_sale_item_id,
      si.product_name,
      si.product_type,
      si.session_count,
      si.remaining_sessions,
      si.paid_sessions,
      si.quantity,
      COALESCE(ps.unit, CASE WHEN si.product_type = '家居产品' THEN '盒' ELSE '次' END) AS unit,
      si.unit_price,
      si.unit_real_price,
      si.sale_amount,
      si.received,
      si.pending_received,
      si.expire_date,
      si.remark,
      si.sales_category,
      si.picked_up_quantity,
      -- 行级欠款：仅「订单确实未付清」且「该卡未买满次数」时才算。
      -- 订单已付清但行 received 不足的是行级分摊缺口（已知数据问题），不是顾客欠款；
      -- 寄存单 total_amount<=0 → paid_sessions=session_count，天然不进此分支（其 sale_amount 只是原价快照）。
      CASE
        WHEN o.status = '部分支付'
         AND si.paid_sessions IS NOT NULL
         AND si.paid_sessions < si.session_count
         AND NOT EXISTS (
           SELECT 1 FROM sale_order_payments sop
           WHERE sop.sale_order_id = o.sale_order_id
             AND sop.change_type = '退款' AND sop.status = '已支付'
         )
         -- 1 元阈值：瀑布分摊的 ROUND 尾差会造出 ¥0.01 的假欠款，不值得推给顾客
         AND (si.sale_amount::numeric - si.received::numeric) >= 1
        THEN GREATEST(0, si.sale_amount::numeric - si.received::numeric)::numeric(12, 2)
        ELSE NULL
      END AS unpaid_amount,
      ps.category_id,
      pc.category_name,
      pc.product_kind
    FROM sale_orders o
    INNER JOIN sale_items si ON o.sale_order_id = si.sale_order_id
    LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
    LEFT JOIN product_categories pc ON pc.category_id = ps.category_id
    LEFT JOIN stores s ON o.store_id = s.store_id
    WHERE o.client_user_id = $1
      AND o.status IN ('已支付', '部分支付', '已完成')
      ${activeFilter}
      AND si.product_type = '疗程卡'
      AND (
        si.item_direction = '购买'
        OR (o.sale_order_type = '转换单' AND si.item_direction = '转入')
      )
      -- 在途退款冻结：原订单存在 '待审批' 退款时排除整单的卡
      AND NOT EXISTS (
        SELECT 1 FROM sale_order_payments sop
        WHERE sop.sale_order_id = o.sale_order_id
          AND sop.change_type = '退款' AND sop.status = '待审批'
      )
      -- includeInactive=true 的疗程卡历史列表保留已用完/已失效卡；存在已审批退款时仍隐藏已退完的卡。
      AND (
        NOT EXISTS (
          SELECT 1 FROM sale_order_payments sop
          WHERE sop.sale_order_id = o.sale_order_id
            AND sop.change_type = '退款' AND sop.status = '已支付'
        )
        OR si.paid_sessions IS NULL
        OR si.paid_sessions > (si.session_count - si.remaining_sessions)
      )
      -- M12：历史订单（workfine 拉取）的 NULL 卡不进可预约列表（后端过滤，前端 uniform-disabled 保留给非 legacy NULL 卡）
      AND NOT (si.paid_sessions IS NULL AND o.legacy_source = 'workfine')
    ORDER BY o.paid_at DESC, si.sale_item_id
  `, [userId])

  // 按订单号分组
  const orderMap = new Map()
  for (const item of items) {
    if (!orderMap.has(item.sale_order_id)) {
      orderMap.set(item.sale_order_id, {
        saleOrderId: item.sale_order_id,
        orderStatus: item.order_status,
        saleOrderDatetime: item.sale_order_datetime,
        paidAt: item.paid_at,
        saleOrderType: item.sale_order_type,
        documentType: item.document_type,
        legacySource: item.legacy_source,
        orderRemark: item.order_remark,
        storeId: item.order_store_id,
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
      storeId: item.item_store_id,
      skuId: item.sku_id,
      itemDirection: item.item_direction,
      refSaleItemId: item.ref_sale_item_id,
      productName: item.product_name,
      productType: item.product_type,
      sessionCount: item.session_count,
      unit: item.unit,
      remainingSessions: item.remaining_sessions,
      paidSessions: item.paid_sessions,
      quantity: Number(item.quantity || 1),
      unitPrice: item.unit_price,
      unitRealPrice: item.unit_real_price,
      saleAmount: item.sale_amount,
      received: item.received,
      pendingReceived: item.pending_received,
      // 仅订单未付清且该卡未买满次数时有值；已付清/寄存单/NULL 卡一律 null
      unpaidAmount: item.unpaid_amount != null ? Number(item.unpaid_amount) : null,
      expireDate: item.expire_date,
      remark: item.remark,
      salesCategory: item.sales_category,
      pickedUpQuantity: item.picked_up_quantity,
      productKind: item.product_kind,
      categoryId: item.category_id,
      categoryName: item.category_name,
      active: isActive
    })
  }

  ctx.result = {
    orders: Array.from(orderMap.values())
  }
}

function mapHomeProductRow(row) {
  const pickedQuantity = Number(row.picked_quantity || 0)
  const refundedQuantity = Number(row.refunded_quantity || 0)
  const convertedQuantity = Number(row.converted_quantity || 0)
  const remainingQuantity = Number(row.remaining_quantity || 0)
  const paidQuantity = Number(row.paid_quantity || 0)
  const pendingPickupQuantity = Number(row.pending_pickup_quantity || 0)
  // 待付清行的欠款金额：received 是行级净实收（已扣该行退款），故对退过款的行
  // sale_amount - received 会把"退掉的钱"误算成欠款；寄存单行 SQL 已置 NULL。
  const unpaidAmount =
    refundedQuantity > 0 || row.unpaid_amount == null ? null : Number(row.unpaid_amount)
  let status
  if (row.refund_pending) status = '退款处理中'
  else if (pendingPickupQuantity > 0) status = pickedQuantity > 0 ? '部分提货' : '待提货'
  // 「待付清」必须与欠款金额绑定：只有真的算得出欠款才这么标。
  // 否则寄存单（金额列留空）和退款后仍有剩余的行会被误标成待付清/已完成。
  else if (unpaidAmount > 0) status = '待付清'
  // 还有未交付份额但算不出欠款（寄存单、退款后剩余）——是待提，不是已完成。
  else if (remainingQuantity > 0) status = '待提货'
  // #125：整行折抵后 settled=purchased，于是 pending=0、remaining=0、refunded=0，
  // 不看 convertedQuantity 会把「已转走」误判成「已提货」。
  else status = (refundedQuantity > 0 || convertedQuantity > 0) ? '已完成' : '已提货'

  return {
    saleItemId: row.sale_item_id,
    saleItemGroupId: row.sale_item_group_id || null,
    saleOrderId: row.sale_order_id,
    productName: row.product_name || '家居产品',
    unit: row.unit || '盒',
    purchasedQuantity: Number(row.purchased_quantity || 0),
    paidQuantity,
    pickedQuantity,
    refundedQuantity,
    convertedQuantity,
    remainingQuantity,
    pendingPickupQuantity,
    unpaidAmount,
    status,
    storeId: row.store_id,
    storeName: row.store_name || null,
    purchasedAt: row.purchased_at,
  }
}

/** 当前顾客已购家居产品资产；pickup_records 是真实提货数量的权威来源。 */
async function homeProducts(ctx) {
  const { userId } = ctx.auth
  const rows = await pg.query(
    `WITH conversion_totals AS (
       -- #154 拆列后件数直读 sale_items.converted_quantity，这里只剩**金额**：折抵额度按金额结算，
       -- 不能由「已转换件数 × 单价」推算（折 4 件可能带走 ¥450 而非 ¥400）。
       -- 只有「已关闭」完成过 rollback（数量已退回），故只排除它；
       -- 其余状态（含"支付失败"）扣减仍然生效，必须计入已转换。删除订单的转出行已随主单消失。
       SELECT out_item.ref_sale_item_id AS sale_item_id,
              SUM(GREATEST(0, -out_item.received::numeric)) AS converted_amount
         FROM sale_items out_item
         JOIN sale_orders conv_order ON conv_order.sale_order_id = out_item.sale_order_id
        WHERE out_item.item_direction = '转出'
          AND out_item.product_type = '家居产品'
          AND out_item.ref_sale_item_id IS NOT NULL
          AND conv_order.status <> '已关闭'
        GROUP BY out_item.ref_sale_item_id
     ), home_product_rows AS (
       SELECT COALESCE(si.sale_item_group_id, si.sale_item_id) AS sale_item_group_id,
              si.sale_item_id,
              si.sale_order_id,
              COALESCE(si.product_name, '家居产品') AS product_name,
              COALESCE(ps.unit, '盒') AS unit,
              si.quantity::int AS purchased_quantity,
              -- #154：三语义各有独立列，「已结算」回归派生量 = 已提货 + 已退款 + 已转换。
              LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0)))::int AS settled_quantity,
              LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0)))::int AS picked_quantity,
              LEAST(si.quantity, GREATEST(0, COALESCE(si.refunded_quantity, 0)))::int AS refunded_quantity,
              LEAST(si.quantity, GREATEST(0, COALESCE(si.converted_quantity, 0)))::int AS converted_quantity,
              -- #145/#153：行级可提件数 = min(物理未结算, floor(剩余已付 / 单价))，与折抵额度同一口径。
              -- 剩余已付 = 行实收 − 已提货金额 − 已转走金额；退款不在此处扣（received 已扣过）。
              -- 必须按金额算而非「已付件数 − 已提 − 已折抵件数」：折抵金额含余数时两者不等，
              -- 折 4 件带走 ¥450 后再回款 ¥50，按件数会多放出 1 件（累计兑现超实收）。
              CASE
                WHEN o.sale_order_type = '寄存单' OR si.sale_amount <= 0
                  THEN GREATEST(0, si.quantity - LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0))))
                ELSE LEAST(
                  GREATEST(0, si.quantity - LEAST(si.quantity, GREATEST(0, COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0)))),
                  GREATEST(0, FLOOR((GREATEST(0, si.received::numeric)
                    - GREATEST(0, COALESCE(si.picked_up_quantity, 0)) * si.unit_real_price::numeric
                    - COALESCE(ct.converted_amount, 0)) / NULLIF(si.unit_real_price::numeric, 0)))::int
                )
              END AS row_pending_pickup,
              CASE
                -- 寄存单：货本就属于顾客，全额可提（sale_amount 只是原价快照，received 不代表欠款）。
                -- 判据与 #120 展示侧 is_deposit 同源；刻意不用疗程卡那条 total_amount<=0——后者会连带覆盖
                -- 转换单/零总额单，且 total_amount 无 CHECK 约束，负值会静默放行。
                WHEN o.sale_order_type = '寄存单' THEN si.quantity
                WHEN si.sale_amount <= 0 THEN si.quantity
                ELSE LEAST(
                  si.quantity,
                  FLOOR(GREATEST(0, si.received::numeric) * si.quantity / NULLIF(si.sale_amount::numeric, 0))::int
                )
              END AS paid_quantity,
              si.sale_amount::numeric AS row_sale_amount,
              GREATEST(0, si.received::numeric) AS row_received,
              (o.sale_order_type = '寄存单') AS is_deposit,
              o.store_id,
              s.store_name,
              COALESCE(o.paid_at, o.sale_order_datetime, o.created_at) AS purchased_at,
              EXISTS (
                SELECT 1 FROM sale_order_payments sop
                 WHERE sop.sale_order_id = o.sale_order_id
                   AND sop.change_type = '退款'
                   AND sop.status = '待审批'
              ) AS refund_pending
         FROM sale_items si
         JOIN sale_orders o ON o.sale_order_id = si.sale_order_id
         LEFT JOIN stores s ON s.store_id = o.store_id
         LEFT JOIN product_skus ps ON ps.sku_id = si.sku_id
         LEFT JOIN conversion_totals ct ON ct.sale_item_id = si.sale_item_id
        WHERE o.client_user_id = $1
          AND o.status IN ('已支付', '部分支付', '已完成')
          -- #145/#153：转换单换入的家居与购买行同权（与疗程卡侧放行写法同源）。
          -- sale_amount>0 的转入行，received 已由 paid-sessions STEP 1.6 重建为「转出旧卡
          -- 价值 + 本单净到账」，FLOOR(received × qty / sale_amount) 天然成立；sale_amount<=0
          -- 的转入行走上方赠品分支全额可提（STEP 1.6 带 sale_amount>0 过滤，刻意不碰 0 元行，
          -- 与购买侧 0 元赠品行同口径）。两类都不需要为「转入」另加满付分支。
          AND (
            si.item_direction = '购买'
            OR (o.sale_order_type = '转换单' AND si.item_direction = '转入')
          )
          AND si.product_type = '家居产品'
     ), home_products AS (
       SELECT sale_item_group_id,
              MIN(si.sale_item_id) AS sale_item_id,
              MIN(si.sale_order_id) AS sale_order_id,
              MIN(COALESCE(si.product_name, '家居产品')) AS product_name,
              MIN(si.unit) AS unit,
              SUM(si.purchased_quantity)::int AS purchased_quantity,
              SUM(si.settled_quantity)::int AS settled_quantity,
              SUM(si.picked_quantity)::int AS picked_quantity,
              SUM(si.refunded_quantity)::int AS refunded_quantity,
              SUM(si.converted_quantity)::int AS converted_quantity,
              SUM(si.row_pending_pickup)::int AS pending_pickup_quantity,
              SUM(si.paid_quantity)::int AS paid_quantity,
              SUM(si.row_sale_amount) AS sale_amount_total,
              SUM(si.row_received) AS received_total,
              BOOL_OR(si.is_deposit) AS is_deposit,
              MIN(si.store_id) AS store_id,
              MIN(si.store_name) AS store_name,
              MAX(si.purchased_at) AS purchased_at,
              BOOL_OR(si.refund_pending) AS refund_pending
         FROM home_product_rows si
      GROUP BY sale_item_group_id
     ), home_product_balances AS (
       SELECT *,
              -- #154 前「已退款」只能由 settled − 已提货 − 已转换 倒推；拆列后直读独立列。
              (purchased_quantity - settled_quantity)::int AS remaining_quantity,
              -- 寄存单的 sale_amount 只是原价快照、received 恒为历史值，两者相减不是欠款
              -- （寄存的货本就属于顾客）。金额列一律留空，与导出口径一致。
              CASE WHEN is_deposit THEN NULL
                   ELSE GREATEST(0, sale_amount_total - received_total)::numeric(12, 2)
              END AS unpaid_amount
         FROM home_products
     )
     SELECT *
       FROM home_product_balances
      WHERE picked_quantity > 0 OR remaining_quantity > 0 OR converted_quantity > 0
   ORDER BY (pending_pickup_quantity > 0) DESC,
            purchased_at DESC,
            sale_item_id`,
    [userId],
  )

  ctx.result = { items: rows.map(mapHomeProductRow) }
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

  const preflightOrder = orders[0]

  if (preflightOrder.client_user_id) {
    if (preflightOrder.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
  } else if (!preflightOrder.opened_by) {
    throw new Error('INVALID_PARAMS: 订单不存在')
  }

  // 10分钟超时检查（仅 '待支付' 且顾客自助单生效）；员工单 closeExpiredOrder 内部跳过，不抛超时（issue #27）
  if (preflightOrder.status === '待支付') {
    const orderTimeAlipay = new Date(preflightOrder.sale_order_datetime)
    if (Date.now() - orderTimeAlipay.getTime() > 10 * 60 * 1000) {
      const closed = await closeExpiredOrder(orderNo)
      if (closed) throw new Error('INVALID_PARAMS: 订单已超时，请重新下单')
    }
  }

  let reservation = await reserveDirectOnlinePaymentIntentWithTerminalRetry({
    orderNo,
    userId,
    payAmountInput,
    paymentMethod: '支付宝',
    requireAlipayShareSource: true,
  })
  if (reservation.prepaidFull) {
    ctx.result = {
      orderNo,
      status: '已支付',
      reason: 'prepaid_card_full',
      paymentParams: null,
    }
    return
  }

  // issue #214：命中复用则直接回发原吱口令，顾客继续付同一笔，不再开新场次。
  // 渠道已终态时 helper 释放意图并返回 false，这里重新预占，顾客无感（同 pay）。
  if (reservation.reused
      && !await ensureReusedIntentStillPayable(orderNo, reservation.outTradeNo, reservation.merchant)) {
    reservation = await reserveDirectOnlinePaymentIntentWithTerminalRetry({
      orderNo,
      userId,
      payAmountInput,
      paymentMethod: '支付宝',
      requireAlipayShareSource: true,
    })
  }
  let alipayShareToken = reservation.paymentParams && reservation.paymentParams.alipayShareToken
  let alipayExpireDate = reservation.paymentParams && reservation.paymentParams.alipayExpireDate
  if (!reservation.reused) {
    const cfgAli = lakalaConfig.readConfig()
    const requestIpAli = getRequestIp()
    // 步骤 1: preorder(ALIPAY, NATIVE=41) 拿二维码 URL
    const preorderRespAli = await createLakalaPreorder({
      orderNo,
      outTradeNo: reservation.outTradeNo,
      storeId: reservation.storeId,
      timeoutMs: LAKALA_PREORDER_TIMEOUT_ALIPAY_MS,
      merchantNo: reservation.merchant.merchantNo,
      termNo: reservation.merchant.termNo,
      payAmountYuan: reservation.payAmount,
      accountType: 'ALIPAY',
      transType: '41',
      requestIp: requestIpAli,
    })
    // 步骤 2: share_code 用 alipayQrUrl 作为 biz_link 换取吱口令
    let shareCodeResp
    try {
      shareCodeResp = await createLakalaAlipayShareCode({
        orderNo,
        merchantNo: reservation.merchant.merchantNo,
        termNo: reservation.merchant.termNo,
        outTradeNo: preorderRespAli.outTradeNo,
        payAmountYuan: reservation.payAmount,
        requestIp: requestIpAli,
        bizLink: preorderRespAli.alipayQrUrl,
      })
    } catch (err) {
      // preorder 已在渠道侧建单（CREATE），但吱口令没拿到 → 意图活跃却无快照可复用。
      // 不释放的话顾客重试只会撞 PAYMENT_INTENT_ACTIVE，得等渠道超时才自愈。
      await releaseIntentAfterPreorderFailure(orderNo, reservation.outTradeNo, reservation.storeId)
      throw err
    }
    alipayShareToken = shareCodeResp.shareToken
    alipayExpireDate = shareCodeResp.expireDate
    await persistLakalaPaymentIntentSnapshot(orderNo, reservation.outTradeNo,
      buildAlipayIntentSnapshot(reservation.outTradeNo, reservation.payAmount,
        shareCodeResp.shareToken, shareCodeResp.expireDate))
  }
  // 与微信一致：首付上限在 payNotify 确认真实到账时清空，预下单阶段继续保留。
  ctx.result = {
    orderNo,
    totalAmount: reservation.totalAmount,
    paidAmount: reservation.payAmount,
    paymentMethod: '支付宝',
    alipayShareToken,
    alipayExpireDate,
    status: reservation.status,
  }
}

/**
 * 顾客在支付前调整抵扣方案（员工扫码 + 顾客自助下单两类入口共用）
 * payload: { saleOrderId, useCard, prepaidCardAmount?, paymentMethod? }
 * 订单状态必须='待支付'；balance 不动，本端点只重算订单的 pending_prepaid_card_amount/payable_amount/payment_method
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
  if (order.lakala_out_order_no) {
    throw new Error('CONFLICT: PAYMENT_INTENT_ACTIVE: 在线支付仍在处理中，暂不能调整抵扣方案')
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
     SET pending_prepaid_card_amount = $1,
         payable_amount = $2,
         payment_method = $3,
         client_user_id = COALESCE(client_user_id, $4),
         updated_at = $5
     WHERE sale_order_id = $6
       AND status = '待支付'
       AND lakala_out_order_no IS NULL`,
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
      `SELECT sale_order_id, status, client_user_id, prepaid_card_amount,
              pending_prepaid_card_amount, payable_amount, total_amount, lakala_out_order_no
       FROM sale_orders WHERE sale_order_id = $1 FOR UPDATE`,
      [saleOrderId]
    )
    if (ordRes.rows.length === 0) {
      throw new Error('INVALID_PARAMS: 订单不存在')
    }
    const order = ordRes.rows[0]
    if (order.status !== '待支付') {
      throw new Error('INVALID_PARAMS: 订单状态不允许支付')
    }
    if (order.lakala_out_order_no) {
      throw new Error('CONFLICT: PAYMENT_INTENT_ACTIVE: 在线支付仍在处理中，暂不能改用储值卡支付')
    }
    if (order.client_user_id && order.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
    const prepaidCardAmount = Number(order.pending_prepaid_card_amount || 0)
    const payableAmount = Number(order.payable_amount || 0) > 0
      ? Number(order.payable_amount)
      : Math.round((Number(order.total_amount || 0) - Number(order.prepaid_card_amount || 0) - prepaidCardAmount) * 100) / 100
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
           pending_prepaid_card_amount = 0,
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
    // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
    await recalcPaidSessionsForOrder(client, saleOrderId)

    // 五件套：积分 + 消费档位 + 客户分类跃迁（became_member_at + is_membership_upgrade 打标）+ 分享礼
    // confirmPrepaidFull 仅对 payable_amount=0 的纯卡抵扣订单：积分链净额=0 → delta=0 → 无积分写入（AC-05）
    // 保留 settlePaidEffects 调用以保证"所有状态转已支付的触发点"都走同一入口
    await settlePaidEffects(client, { saleOrderId, clientUserId: userId, paidAmount: prepaidCardAmount, source: 'clientApi.confirmPrepaidFull' })
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
  const reservedOutTradeNo = (!isPureCard && !isOffline)
    ? buildLakalaOutTradeNo(saleOrderId)
    : null
  let repayMerchant = null
  let repayStoreId = null   // 事务内读到的门店，供预下单失败时的安全释放使用

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
    if (origOrder.client_user_id && origOrder.client_user_id !== userId) {
      throw new Error('PERMISSION_DENIED: 无权操作该订单')
    }
    if (!['待支付', '部分支付'].includes(origOrder.status)) {
      throw new Error('INVALID_STATE: 订单状态不允许回款')
    }
    if (!['销售单', '转换单'].includes(origOrder.sale_order_type)) {
      throw new Error('INVALID_PARAMS: 仅销售单或转换单支持回款')
    }
    if (origOrder.is_experience_conversion === true) {
      throw new Error('INVALID_STATE: EXPERIENCE_CONVERSION_REPAYMENT_FORBIDDEN: 体验转换不允许补款')
    }
    currentStatus = origOrder.status

    const frozenPaymentAmount = Number(origOrder.first_payment_amount || 0)
    // 受限转换回款由 staff 冻结金额后统一走 order.pay/alipayPay；repay 的事务在预下单前
    // 已提交，无法与第三方意图 CAS 原子化。这里必须在任何 pending 作废/订单 UPDATE 前
    // fail-fast，避免旧客户端覆盖或破坏正在途的支付场次。
    if (origOrder.lakala_out_order_no) {
      throw new Error('CONFLICT: PAYMENT_INTENT_ACTIVE: 本次支付单已生成，请勿重复发起')
    }
    if (origOrder.sale_order_type === '转换单' && frozenPaymentAmount > 0) {
      throw new Error('INVALID_STATE: CONVERSION_REPAYMENT_USE_ORDER_PAY: 受限转换回款请使用订单支付')
    }

    // 2. 先作废旧的储值卡抵扣意向并恢复本单应付。
    //    失败/取消的混合支付会留下 pending 意向并暂时降低 payable_amount。
    //    新一次回款必须在计算、校验欠款前清理它，否则顾客按真实未付额重试会被误判为超额。
    await client.query(
      `UPDATE sale_order_payments SET status = '已作废'
       WHERE sale_order_id = $1 AND change_type = '储值卡抵扣' AND status = '待支付'`,
      [saleOrderId]
    )
    await client.query(
      `UPDATE sale_orders
       SET pending_prepaid_card_amount = 0,
           payable_amount = CASE
             WHEN sale_order_type IN ('销售单','内部单','转换单')
               THEN GREATEST(0, total_amount::numeric - prepaid_card_amount::numeric)
             ELSE payable_amount
           END,
           updated_at = NOW()
       WHERE sale_order_id = $1`,
      [saleOrderId]
    )
    origOrder.pending_prepaid_card_amount = 0
    if (['销售单', '内部单', '转换单'].includes(origOrder.sale_order_type)) {
      origOrder.payable_amount = Math.max(
        0,
        Number(origOrder.total_amount || 0) - Number(origOrder.prepaid_card_amount || 0)
      )
    }

    // 3. 计算欠款 + 定向分摊项。
    //    有退款 → 行级口径（已退行不计入，只有「未退且未付清」的行可继续支付），capture 定向到未退行
    //    避免非定向瀑布流把回款误充到已退行（received/paid_sessions 复活）；
    //    无退款 → 沿用订单级口径（正常回款，与首次支付/原逻辑一致）。
    const payableAmount = Number(origOrder.payable_amount || 0) > 0
      ? Number(origOrder.payable_amount)
      : Math.round((Number(origOrder.total_amount || 0)
          - Number(origOrder.prepaid_card_amount || 0)
          - Number(origOrder.pending_prepaid_card_amount || 0)) * 100) / 100
    let directedItems = null
    let remaining
    if (origOrder.sale_order_type === '转换单') {
      const received = Number(origOrder.received || 0)
      const refundedAmount = Number(origOrder.refunded_amount || 0)
      remaining = Math.round((Number(origOrder.total_amount || 0) - received + refundedAmount) * 100) / 100
    } else if (Number(origOrder.refunded_amount || 0) > 0) {
      const repayItemRows = await client.query(
        `SELECT sale_item_id, sale_amount::numeric AS sale_amount, received::numeric AS received
           FROM sale_items WHERE sale_order_id = $1 AND item_direction = '购买'`,
        [saleOrderId]
      )
      const repayRefundMap = await getPerItemRefundedMap(client, saleOrderId)
      directedItems = computeRefundAwareDirectedItems(repayItemRows.rows, repayRefundMap)
      remaining = directedItems
        ? Math.round(directedItems.reduce((s, d) => s + Number(d.amount), 0) * 100) / 100
        : 0
    } else {
      const received = Number(origOrder.received || 0)
      const refundedAmount = Number(origOrder.refunded_amount || 0)
      const netReceived = Math.round((received - refundedAmount) * 100) / 100
      remaining = Math.round((payableAmount - netReceived) * 100) / 100
    }
    if (remaining <= 0) {
      throw new Error('INVALID_STATE: 订单无欠款')
    }
    // first_payment_amount 是员工冻结的本支付场次硬上限。锁单后按“现金 + 储值卡”合计执行，
    // 旧版小程序或直接 API 调用也不能把 500 元场次放大为整笔 2000 元欠款。
    const firstPaymentCap = frozenPaymentAmount
    const hasPaymentCap = firstPaymentCap > 0
    const paymentTarget = hasPaymentCap ? Math.min(remaining, firstPaymentCap) : remaining
    if (totalNew > paymentTarget + 0.001) {
      throw new Error(hasPaymentCap
        ? 'INVALID_PARAMS: 回款金额超过本次支付上限'
        : 'INVALID_PARAMS: 回款金额超过剩余应付')
    }
    // 无冻结场次时仍强制一次付清；有冻结场次时必须恰好支付本场次目标额，不能少付或拆单。
    if (totalNew + 0.001 < paymentTarget) {
      throw new Error(hasPaymentCap
        ? 'INVALID_PARAMS: 回款金额必须等于本次支付金额'
        : 'INVALID_PARAMS: 继续支付必须支付全部未付金额')
    }

    // 所有本地配置校验都必须早于本次 pending 计划写入和 out_trade_no 预占；配置缺失会回滚
    // 上方对遗留 pending 的清理，不留下假活动意图或半套混合支付计划。
    if (!isPureCard && !isOffline) {
      if (paymentMethod === '支付宝' && !lakalaConfig.readConfig().alipayShareSource) {
        throw new Error('INVALID_STATE: ALIPAY_NOT_AVAILABLE: 暂不支持支付宝，请使用微信支付')
      }
      repayStoreId = origOrder.store_id
      repayMerchant = await resolveLakalaMerchantInTransaction(client, origOrder.store_id)
      if (!repayMerchant) {
        throw new Error('INVALID_STATE: LAKALA_NOT_CONFIGURED: 该门店未启用拉卡拉聚合支付，请联系管理员')
      }
    }

    // 4. 储值卡扣款（按通道分流）。
    let cardPaymentId = null
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
      await client.query(
        `UPDATE sale_orders
         SET pending_prepaid_card_amount = $1,
             payable_amount = CASE
               WHEN sale_order_type IN ('销售单','内部单','转换单')
                 THEN GREATEST(0, total_amount::numeric - prepaid_card_amount::numeric - $1::numeric)
               ELSE payable_amount
             END,
             updated_at = $2
         WHERE sale_order_id = $3`,
        [prepaidCardAmountInput, now, saleOrderId]
      )
    }

    // 5. 支付计划：线上通道在同一行锁事务内先预占唯一 out_trade_no，再用精确单号 CAS
    // 绑定 payment_method；混合支付的 pending 计划与该场次一并提交/回滚。
    if (!isPureCard && !isOffline) {
      const claimRes = await client.query(
        `UPDATE sale_orders
         SET lakala_out_order_no = $1, updated_at = $2
         WHERE sale_order_id = $3
           AND status = $4
           AND lakala_out_order_no IS NULL
         RETURNING sale_order_id`,
        [reservedOutTradeNo, now, saleOrderId, origOrder.status]
      )
      if (claimRes.rowCount !== 1) {
        throw new Error('CONFLICT: PAYMENT_INTENT_CHANGED: 支付场次已变化，请刷新后重试')
      }
      const planRes = await client.query(
        `UPDATE sale_orders
         SET payment_method = $1, updated_at = $2
         WHERE sale_order_id = $3
           AND status = $4
           AND lakala_out_order_no = $5
         RETURNING sale_order_id`,
        [paymentMethod, now, saleOrderId, origOrder.status, reservedOutTradeNo]
      )
      if (planRes.rowCount !== 1) {
        throw new Error('CONFLICT: PAYMENT_INTENT_CHANGED: 支付场次已变化，请刷新后重试')
      }
    } else if (isOffline) {
      // CAS-EXEMPT: 线下只记录支付方式，不翻 status；staff 确认收款时再推进资金状态。
      await client.query(
        `UPDATE sale_orders SET payment_method = $1, updated_at = $2
         WHERE sale_order_id = $3 AND status = $4`,
        [paymentMethod, now, saleOrderId, origOrder.status]
      )
    }

    // 6. 重算原单 received/refunded_amount + 推进 status：仅纯储值卡通道（当场扣卡 + 写了已支付储值卡回款行）。
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
      const fullyPaid = newNet + 0.001 >= Number(origOrder.total_amount || 0)
      finalStatus = fullyPaid ? '已支付' : '部分支付'
      if (!['部分支付', '已支付', '已完成'].includes(origOrder.status)) {
        const documentType = await classifySaleOrderDocumentType(client, userId, saleOrderId)
        await client.query(
          `UPDATE sale_orders SET document_type = $1::document_type
           WHERE sale_order_id = $2 AND status = $3`,
          [documentType, saleOrderId, origOrder.status]
        )
      }
      // actual 储值卡金额与 payable_amount 由下方 recalcPaidSessionsForOrder 从流水统一重聚合。
      const repayUpd = await client.query(
        `UPDATE sale_orders
         SET status = $1::order_status,
             received = $2,
             refunded_amount = $3,
             pending_prepaid_card_amount = 0,
             first_payment_amount = NULL,
             paid_at = CASE WHEN $1::text = '已支付' THEN COALESCE(paid_at, $4) ELSE paid_at END,
             updated_at = $4
         WHERE sale_order_id = $5
           AND status IN ('待支付', '部分支付')`,
        [finalStatus, newReceived, newRefunded, now, saleOrderId]
      )
      if (repayUpd.rowCount === 0) {
        throw new Error(`INVALID_STATE: STATE_TRANSITION_BLOCKED:sale_orders:${saleOrderId}:→${finalStatus}`)
      }
      // 按回款逐笔分配：捕获本次储值卡回款逐项可分配额 + 置回款待分配 + 汇总刷新。
      // directedItems：有退款时定向到未退行（上方 STEP 2 算出），无退款时 null 走原瀑布流。
      // （线上回款由 payNotify 捕获，同样按退款感知定向）
      if (cardPaymentId && prepaidCardAmountInput > 0) {
        await capturePaymentAllocatables(client, {
          salePaymentId: cardPaymentId,
          saleOrderId,
          eventAmount: prepaidCardAmountInput,
          directedItems,
        })
        await refreshOrderAllocationRollup(client, saleOrderId)
      }
      // paid_sessions 重算（ticket 2026-05-19）：纯卡回款 received 增长 → settled 上升
      // → 按 floor(settled/total × session_count) 自动解锁更多可消费次数
      // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
      await recalcPaidSessionsForOrder(client, saleOrderId)
      // 五件套：积分 + 消费档位 + 客户分类跃迁（became_member_at + is_membership_upgrade 打标）+ 分享礼
      // 纯卡回款时 received 已增加，需 settle；线上通道等 payNotify 触发
      await settlePaidEffects(client, { saleOrderId, clientUserId: userId, paidAmount: prepaidCardAmountInput, source: 'clientApi.repay' })
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
  const repayCfg = lakalaConfig.readConfig()
  const repayRequestIp = getRequestIp()

  if (paymentMethod === '微信') {
    const { paymentParams: repayPaymentParams } = await createLakalaPreorder({
      orderNo: saleOrderId,
      outTradeNo: reservedOutTradeNo,
      storeId: repayStoreId,
      merchantNo: repayMerchant.merchantNo,
      termNo: repayMerchant.termNo,
      payAmountYuan: repayAmountInput,
      accountType: 'WECHAT',
      transType: '71',
      openid: ctx.auth.openid,
      subAppid: repayCfg.subAppid,
      requestIp: repayRequestIp,
    })
    // issue #214：repay 自身保持「有活动意图即 fail-fast」（见上方事务注释——它的
    // pending 作废与 payable 回写在预下单前已提交，无法与渠道意图 CAS 原子化）。
    // 但仍落盘快照：顾客中断后从 order.pay 入口回来时可复用这一场次继续付。
    await persistLakalaPaymentIntentSnapshot(saleOrderId, reservedOutTradeNo,
      buildWechatIntentSnapshot(reservedOutTradeNo, repayAmountInput, repayPaymentParams))
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
      outTradeNo: reservedOutTradeNo,
      storeId: repayStoreId,
      timeoutMs: LAKALA_PREORDER_TIMEOUT_ALIPAY_MS,
      merchantNo: repayMerchant.merchantNo,
      termNo: repayMerchant.termNo,
      payAmountYuan: repayAmountInput,
      accountType: 'ALIPAY',
      transType: '41',
      requestIp: repayRequestIp,
    })
    let repayShareCodeResp
    try {
      repayShareCodeResp = await createLakalaAlipayShareCode({
        orderNo: saleOrderId,
        merchantNo: repayMerchant.merchantNo,
        termNo: repayMerchant.termNo,
        outTradeNo: repayPreorderResp.outTradeNo,
        payAmountYuan: repayAmountInput,
        requestIp: repayRequestIp,
        bizLink: repayPreorderResp.alipayQrUrl,
      })
    } catch (err) {
      // 同 alipayPay：preorder 已建单但吱口令失败，安全释放后再抛，别把订单锁死
      await releaseIntentAfterPreorderFailure(saleOrderId, reservedOutTradeNo, repayStoreId)
      throw err
    }
    await persistLakalaPaymentIntentSnapshot(saleOrderId, reservedOutTradeNo,
      buildAlipayIntentSnapshot(reservedOutTradeNo, repayAmountInput,
        repayShareCodeResp.shareToken, repayShareCodeResp.expireDate))
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
 * 查询拉卡拉聚合主扫交易状态（轮询兜底）
 *
 * 前端轮询 order.detail 仍 '待支付' 时可调本接口，主动问拉卡拉该单是否已支付，
 * 避免 payNotify 延迟/丢失时死等。**不直接入账**——订单结算（置已支付/积分/储值卡等）仍由
 * payNotify 单源负责；本接口仅在拉卡拉明确 FAIL/CLOSE 时按旧 out_trade_no CAS 释放
 * 活动意图，其余状态只透出给前端做 UX 决策。
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
  // 同样要求 ok===true 才解释状态：否则业务失败码携带的非权威 CLOSE 会释放意图
  const queriedTradeState = (resp && resp.ok === true) ? normalizeTradeState(resp.tradeState) : ''
  let lakalaIntentReleased = false
  if (queriedTradeState && LAKALA_RELEASABLE_TRADE_STATES.includes(queriedTradeState)) {
    const released = await pg.query(
      `UPDATE sale_orders
       SET lakala_out_order_no = NULL, updated_at = NOW()
       WHERE sale_order_id = $1
         AND status IN ('待支付', '部分支付')
         AND lakala_out_order_no = $2
       RETURNING sale_order_id`,
      [orderNo, order.lakala_out_order_no]
    )
    lakalaIntentReleased = released.length > 0
  }
  ctx.result = {
    orderNo,
    localStatus: order.status,
    lakalaQueried: true,
    lakalaOk: resp.ok,
    lakalaTradeState: resp.tradeState || null,  // 'SUCCESS' 才算到账
    lakalaCode: resp.code,
    lakalaIntentReleased,
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
    `SELECT sale_order_id, status, store_id, lakala_out_order_no, client_user_id, payment_method,
            received, first_payment_amount
     FROM sale_orders WHERE sale_order_id = $1`,
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
  const localPaymentSnapshot = {
    received: Number(order.received || 0),
    firstPaymentAmount: order.first_payment_amount == null
      ? null
      : Number(order.first_payment_amount),
  }

  // 早期决策：终态 / 无拉卡拉单 → 无需对账，直接返回本地 status
  if (decideReconcile(localStatus, hasLakalaOrder, null) === 'skip') {
    ctx.result = {
      saleOrderId: orderNo,
      status: localStatus,
      reconciled: false,
      reason: hasLakalaOrder ? 'terminal' : 'no_lakala_order',
      ...localPaymentSnapshot,
    }
    return
  }

  // 查拉卡拉真实状态（resolveLakalaMerchant 在 term_no 缺失时抛 INVALID_STATE，包 try/catch 降级）
  let merchant
  try {
    merchant = await resolveLakalaMerchant(order.store_id)
  } catch (e) {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, reason: 'lakala_not_configured', message: e.message, ...localPaymentSnapshot }
    return
  }
  if (!merchant) {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, reason: 'lakala_not_configured', ...localPaymentSnapshot }
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
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, reason: 'query_failed', message: e.message, ...localPaymentSnapshot }
    return
  }

  // ⚠️ 这条路径的 SUCCESS 会直接触发本地入账，非权威状态绝不能采信：
  // 拉卡拉业务失败码的响应里也可能带 resp_data.trade_state，据此入账等于无真实到账却记账
  // （双谱系评审 round-2）。ok 不为 true 时按「查不到状态」处理，交给下游降级分支。
  const tradeState = resp.ok === true ? normalizeTradeState(resp.tradeState) : ''
  if (tradeState && LAKALA_RELEASABLE_TRADE_STATES.includes(tradeState)) {
    const released = await pg.query(
      `UPDATE sale_orders
       SET lakala_out_order_no = NULL, updated_at = NOW()
       WHERE sale_order_id = $1
         AND status IN ('待支付', '部分支付')
         AND lakala_out_order_no = $2
       RETURNING sale_order_id`,
      [orderNo, order.lakala_out_order_no]
    )
    ctx.result = {
      saleOrderId: orderNo,
      status: localStatus,
      reconciled: false,
      lakalaTradeState: tradeState,
      lakalaIntentReleased: released.length > 0,
      reason: 'terminal_failed',
      ...localPaymentSnapshot,
    }
    return
  }
  // 拉卡拉侧尚未 SUCCESS：返回本地 status，前端继续轮询
  if (decideReconcile(localStatus, hasLakalaOrder, tradeState) !== 'reconcile') {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, lakalaTradeState: tradeState, reason: 'not_success', ...localPaymentSnapshot }
    return
  }

  // 拉卡拉 SUCCESS + 本地待支付/部分支付 → 触发与回调同款的幂等入账
  const payAmount = Math.round(Number(resp.totalAmountFen || 0)) / 100
  if (!(payAmount > 0)) {
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, lakalaTradeState: tradeState, reason: 'invalid_amount', ...localPaymentSnapshot }
    return
  }
  const paymentMethod = order.payment_method === '支付宝' ? '支付宝' : '微信'
  // fail-closed：入账目标函数名必须显式配置，不回退到 'payNotify'。
  // 同一 env 内并存 payNotify(prod 库) 与 payNotifyDev(dev 库)，回退等于让 clientApiDev
  // 拿 dev 库的订单号去调生产函数在 prod 库入账。宁可这次对账降级，也不能把钱写错库。
  if (!process.env.PAYNOTIFY_FN_NAME) {
    console.error('[order.confirmPayment] PAYNOTIFY_FN_NAME 未配置，拒绝猜测目标函数（避免跨库入账）')
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, reason: 'paynotify_not_configured', ...localPaymentSnapshot }
    return
  }
  let payNotifyResult
  try {
    const r = await cloud.callFunction({
      name: process.env.PAYNOTIFY_FN_NAME,
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
    ctx.result = { saleOrderId: orderNo, status: localStatus, reconciled: false, reason: 'paynotify_call_failed', message: e.message, ...localPaymentSnapshot }
    return
  }

  // 重查本地 status（payNotify 已更新），返回最新态
  const after = await pg.query(
    'SELECT status, received, first_payment_amount FROM sale_orders WHERE sale_order_id = $1',
    [orderNo]
  )
  const newStatus = (after[0] && after[0].status) || localStatus
  const newReceived = Number((after[0] && after[0].received) ?? order.received ?? 0)
  const newFirstPaymentAmount = after[0] && after[0].first_payment_amount != null
    ? Number(after[0].first_payment_amount)
    : null
  ctx.result = {
    saleOrderId: orderNo,
    status: newStatus,
    // 部分支付订单本场次到账后状态仍可能保持“部分支付”；payNotify 成功 ACK 本身也是本场次完成证据，
    // 不能再依赖 status 必须发生变化。
    reconciled: !!(payNotifyResult && payNotifyResult.code === 'SUCCESS'),
    received: newReceived,
    firstPaymentAmount: newFirstPaymentAmount,
    payNotifyResult,
  }
}

/**
 * 作废订单上进行中的在线支付意图（跨 env 内部接口，issue #214）。
 *
 * 仅供 staffApi 经 HTTP 触发器 + HMAC 调用：员工端/管理端关闭订单前，需要先让渠道关单，
 * 否则顾客手机上残留的支付面板仍可付款。staffApi 所在的 CloudBase 账号没有拉卡拉凭据，
 * 也不该有——把凭据面限制在 clientApi 一处，是这条跨 env 调用存在的理由。
 *
 * 鉴权完全依赖 index.js 的 HMAC 链路（签名 + 时间戳窗口 + action 白名单），
 * 这里做与 auth.uploadStaffAvatar 同款的二次断言，防止 cloud.callFunction 直调绕过。
 */
async function voidPaymentIntent(ctx) {
  if (!ctx.event._fromHttp || ctx.event._hmacVerified !== true) {
    throw new Error('PERMISSION_DENIED: 该接口仅供内部服务调用')
  }
  const payload = ctx.event.payload || {}
  const saleOrderId = payload.saleOrderId || payload.orderNo
  if (!saleOrderId) {
    throw new Error('INVALID_PARAMS: 缺少 saleOrderId 参数')
  }
  // 调用方预读到的意图单号，**必填**。本接口绝不能「读当前是哪笔就关哪笔」——见下方
  // TOCTOU 说明。
  //
  // 这里刻意不做向后兼容的软校验（双谱系评审 round-4）：滚动部署期间必然存在「旧版
  // staffApi 只发 saleOrderId」的窗口，软校验会在那段时间静默跳过比对、关掉顾客新发起的
  // 合法支付。宁可让旧版调用直接失败（关单功能短暂不可用、店员重试即可），也不要静默
  // 破坏一笔正在进行的支付。
  const expectedOutTradeNo = String(payload.expectedOutTradeNo || '').trim()

  const rows = await pg.query(
    'SELECT sale_order_id, status, store_id, lakala_out_order_no FROM sale_orders WHERE sale_order_id = $1',
    [saleOrderId]
  )
  if (rows.length === 0) {
    throw new Error('NOT_FOUND: 订单不存在')
  }
  const order = rows[0]
  if (!order.lakala_out_order_no) {
    ctx.result = { saleOrderId, result: 'noop' }
    return
  }

  // TOCTOU 防线：staffApi 预检时看到的是意图 A，但在跨 env 请求到达这里之前，A 可能已经
  // 到账并清锁、顾客又发起了补款意图 B。若本接口只按订单号「关当前那笔」，就会把合法的 B
  // 关掉——而 staff 侧事务随后会因订单已变「部分支付」拒绝关闭，最终订单没关成、顾客的
  // 补款却被破坏。所以单号不匹配一律拒绝，绝不自动改为操作新意图。
  if (!expectedOutTradeNo) {
    // 必须排在任何渠道调用之前：缺参时一笔查单/关单都不能发出去
    throw new Error('INVALID_PARAMS: 缺少 expectedOutTradeNo 参数')
  }
  if (expectedOutTradeNo !== String(order.lakala_out_order_no)) {
    throw new Error('CONFLICT: PAYMENT_INTENT_CHANGED: 支付场次已变化，请刷新后重试')
  }
  // 状态同样要在任何渠道调用之前复核（调用方的预检与这里之间可能已经变化）。
  // 集合与 staffApi 的 CLOSEABLE_ORDER_STATUSES 必须一致，由 cross-copy snapshot 守护。
  if (!CLOSEABLE_ORDER_STATUSES.includes(order.status)) {
    throw new Error('CONFLICT: PAYMENT_INTENT_CHANGED: 订单状态已变化，请刷新后重试')
  }

  const result = await voidActiveLakalaPaymentIntent(saleOrderId, {
    outTradeNo: order.lakala_out_order_no,
    storeId: order.store_id,
  })
  ctx.result = { saleOrderId, result }
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
  homeProducts,
  scanDetail,
  scanAdjust,
  confirmPrepaidFull,
  repay,
  queryLakalaStatus,
  confirmPayment,
  decideReconcile,
  voidPaymentIntent,
}
