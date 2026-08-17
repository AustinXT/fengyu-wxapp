'use server'

import { db } from '@/db'
import { rowsAffected } from '@/lib/pg-rows'
import {
  saleOrders,
  saleItems,
  saleOrderPayments,
  salePaymentItemReceipts,
  salePaymentItemAllocations,
} from '@db/order'
import { userCoupons, couponTemplates } from '@db/coupon'
import { stores, orgNodes } from '@db/org'
import { clientWechatUsers, staffWechatUsers } from '@db/user'
import { productSkus, productCategories, products, mallBundleGroups, mallProductSkus } from '@db/product'
import { prepaidCards, cardTransactions } from '@db/prepaid-card'
import { eq, desc, asc, and, or, sql, ilike, gte, lt, gt, inArray, isNull } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { AuthSession, SaleOrder, SaleItem, OrderStatus, SaleOrderType } from '@/lib/types'
import { revalidatePath } from 'next/cache'
import { scopeCondition, isInScope, requireAdmin, isDepositOrderApprover } from '@/lib/permissions'
import { withPermission, withAnyPermission } from '@/lib/with-permission'
import { logOperation, logTransition, logUpdate } from '@/lib/operation-log'
import { ApiError, parseErrorPrefix } from '@/lib/api-error'
import { hasPendingRefund } from '@/lib/refund-cascade'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { calcCouponDiscount } from '@/lib/utils'
import { getMemberThreshold } from '@/lib/member-threshold'
import { isMember, resolveUnitPrice } from '@/lib/member-pricing'
import { calculateTreatmentTierLineAmounts } from '@/lib/treatment-tier-pricing'
// TODO: 后续若 admin 需自建充值订单入口，从 '@/lib/recharge' 引入 loadRechargeConfig + matchTier
import { settlePointsSafe } from '@/lib/points-settle'
import { recalcPaidSessionsForOrder, paidUnusedSessionsExpr } from '@/lib/paid-sessions'
import { capturePaymentAllocatables, refreshOrderAllocationRollup } from '@/lib/payment-allocatable'
import { getPerItemRefundedMap } from '@/lib/per-item-refund'
import { storeInMarketCondition } from '@/lib/market-store-sql'
import { shanghaiYmd } from '@/lib/datetime'
import { nowTs, beijingBoundaryTs } from '@/lib/db-time'
import {
  resolveExportBatchLimit,
  type ExportBatchOptions,
  type ExportBatchResult,
} from '@/lib/export-pagination'
import { parseOrderFilters, parseAllocationOrderFilters } from '@/lib/list-filters'
import { orderMarketScopeCondition, resolveCustomerOrderMarketScope } from '@/lib/order-market-scope'

// drizzle 0.45 alias() 返回 PgTableWithColumns<Required<Update<any,...>>>，与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
const opener = alias(staffWechatUsers, 'opener') as unknown as typeof staffWechatUsers
// 订单详情：指定美容师 / 线下确认人 各自 JOIN staff_wechat_users 取姓名
const preferredStaff = alias(staffWechatUsers, 'preferredStaff') as unknown as typeof staffWechatUsers
const offlineConfirmer = alias(staffWechatUsers, 'offlineConfirmer') as unknown as typeof staffWechatUsers
const auditor = alias(staffWechatUsers, 'auditor') as unknown as typeof staffWechatUsers
const performanceAttributionAdjuster = alias(staffWechatUsers, 'performanceAttributionAdjuster') as unknown as typeof staffWechatUsers

// 寄存单历史实收流水的 note 标记（change_type='回款' 行）。
// 编辑寄存单实收时按此标记删重建；与 staff 端 routes/order.js 字面量保持一致。
const DEPOSIT_RECEIPT_NOTE = '寄存单初始化实收'

// 旧系统(WorkFine)充值金转入专用备注标记（与 staff routes/card.js LEGACY_INFLOW_NOTE 字面一致）
const LEGACY_INFLOW_NOTE = '旧系统充值金转入'

// 寄存单事务客户端类型（与 lib/paid-sessions.ts AdminTx 同义）
type OrderTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DepositTx = OrderTx

type SkuPurchaseLimitRow = {
  skuId: string
  specName?: string | null
  purchaseLimit: number | null
}

type SkuQuantityInput = {
  skuId?: string | null
  quantity?: number | null
}

function findPurchaseLimitViolation(
  items: SkuQuantityInput[],
  skuRows: SkuPurchaseLimitRow[],
): SkuPurchaseLimitRow | null {
  const rowMap = new Map(skuRows.map((row) => [row.skuId, row]))
  const totals = new Map<string, number>()
  for (const item of items) {
    if (!item.skuId) continue
    totals.set(item.skuId, (totals.get(item.skuId) ?? 0) + Number(item.quantity ?? 0))
  }
  for (const [skuId, quantity] of totals.entries()) {
    const row = rowMap.get(skuId)
    if (row?.purchaseLimit != null && quantity > row.purchaseLimit) return row
  }
  return null
}

function purchaseLimitExceededMessage(row: SkuPurchaseLimitRow): string {
  const name = row.specName || row.skuId
  return `商品「${name}」每单最多可购买 ${row.purchaseLimit} 件`
}

function splitMoneyByCount(value: number | string, count: number): number[] {
  const totalCents = Math.round((Number(value) || 0) * 100)
  const eachCents = Math.trunc(totalCents / count)
  return Array.from({ length: count }, (_unused, index) =>
    (eachCents + (index === count - 1 ? totalCents - eachCents * count : 0)) / 100)
}

function allocateExperienceConversionAmounts<
  T extends { amount: number; unitRealPrice: string; item: { quantity: number; sessionCount: number | null }; sku: { sessionCount: number | null } },
>(items: T[], targetAmount: number): void {
  const targetCents = Math.round(targetAmount * 100)
  const weights = items.map((item) => Math.max(0, Math.round(item.amount * 100)))
  const weightTotal = weights.reduce((sum, value) => sum + value, 0)
  if (targetCents < 0 || weightTotal <= 0) {
    throw new ApiError('INVALID_STATE', 'EXPERIENCE_CONVERSION_PRICE_INVALID: 体验转换项目正常价格必须大于0')
  }
  let allocatedCents = 0
  items.forEach((item, index) => {
    const cents = index === items.length - 1
      ? targetCents - allocatedCents
      : Math.floor(targetCents * weights[index] / weightTotal)
    allocatedCents += cents
    item.amount = cents / 100
    const skuSessions = item.sku.sessionCount ?? item.item.sessionCount
    const totalSessions = skuSessions != null ? skuSessions * item.item.quantity : null
    const denom = totalSessions != null && totalSessions > 0 ? totalSessions : item.item.quantity
    item.unitRealPrice = (item.amount / Math.max(denom, 1)).toFixed(2)
  })
}

// 寄存单疗程卡「实际单价按实付重算」—— unit_real_price = 实付received / 总次数session_count。
// 实付=0 的行置 0（如实反映未收款，不再回落标价）；仅 product_type='疗程卡'，家居产品行(session_count NULL)被 WHERE 排除不受影响。
// ⚠️ 必须 deposit-only + 严格在 recalcPaidSessionsForOrder 之后调用（理由见 staff routes/order.js 同名注释）：
//   并进通用 recalc 会腰斩所有欠款单 per-session 价（腐蚀提成/退款/转换）；勿 DRY 进 recalcPaidSessionsForOrder。
// 与 staff routes/order.js DEPOSIT_REAL_PRICE_RECALC_SQL 字节同义，cross-end-sql-snapshot.test.js 守护。marker: DEPOSIT_REAL_PRICE
async function recomputeDepositRealPrice(tx: DepositTx, saleOrderId: string): Promise<void> {
  await tx.execute(sql`UPDATE sale_items
      SET unit_real_price = CASE
            WHEN session_count > 0 AND received > 0
              THEN ROUND(received::numeric / session_count, 2)
            ELSE 0
          END,
          updated_at = NOW()
      WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买' AND product_type = '疗程卡'
      -- DEPOSIT_REAL_PRICE`)
}

function assertCanApproveDepositOrder(session: AuthSession): void {
  if (!isDepositOrderApprover(session)) {
    throw new ApiError('PERMISSION_DENIED', '仅系统管理员、总部/市场/门店店长或财务可审批寄存单')
  }
}

/**
 * 待支付/支付失败转换单被关闭时撤销创建时的即时资产变更。
 * staffApi/routes/order.js 有同义 SQL 副本；修改时保持语义一致。
 */
async function rollbackPendingConversionOnClose(tx: OrderTx, saleOrderId: string): Promise<void> {
  await tx.execute(sql`
    WITH restore AS (
      SELECT ref_sale_item_id, SUM(quantity)::integer AS restore_sessions
        FROM sale_items
       WHERE sale_order_id = ${saleOrderId}
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
       FOR UPDATE OF src
    )
    UPDATE sale_items src
       SET remaining_sessions = LEAST(
             COALESCE(src.session_count, src.remaining_sessions, 0),
             COALESCE(src.remaining_sessions, 0) + locked_source.restore_sessions
           ),
           updated_at = NOW()
      FROM locked_source
     WHERE src.sale_item_id = locked_source.sale_item_id
  `)

  await tx.execute(sql`
    UPDATE sale_items
       SET received = 0,
           remaining_sessions = CASE
             WHEN session_count IS NULL THEN remaining_sessions
             ELSE session_count
           END,
           paid_sessions = CASE
             WHEN session_count IS NULL THEN NULL
             ELSE 0
           END,
           updated_at = NOW()
     WHERE sale_order_id = ${saleOrderId}
       AND item_direction IN ('转出', '转入')
  `)
}

/**
 * 充值卡订单入账（2026-05-20 重构：充值卡剥离 SKU 化）
 *
 * 在订单状态翻转到"已支付"的同事务内调用。识别 sale_orders.sale_order_type='充值单'，
 * 面值直接读 sale_orders.total_amount（不再扫 sale_items）。
 *
 * 幂等：card_transactions.external_ref 唯一约束 + ref_order_id 软查；
 * 与 staff order.confirmOffline + payNotify 同源（external_ref='card-topup-{saleOrderId}'）。
 */
async function applyRechargeOnOrderPaid(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  saleOrderId: string,
  // 可选幂等键覆盖：充值金转入(inflow)传 card-inflow-{requestId} 以跨「不同订单号的重试」去重；
  // 不传则沿用 card-topup-{saleOrderId}（confirmOfflinePayment / createRechargeOrder 原行为不变）。
  externalRef?: string,
): Promise<void> {
  const [order] = await tx
    .select({
      clientUserId: saleOrders.clientUserId,
      saleOrderType: saleOrders.saleOrderType,
      totalAmount: saleOrders.totalAmount,
    })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  // 非充值单 / 未实名订单 → 跳过
  if (!order || !order.clientUserId || order.saleOrderType !== '充值单') return

  const faceValue = Number(order.totalAmount)
  if (!(faceValue > 0)) return

  // 幂等：防重放
  const dup = await tx.execute(sql`
    SELECT 1 FROM card_transactions WHERE ref_order_id = ${saleOrderId} AND type = '充值' LIMIT 1
  `)
  if ((dup as unknown as any[]).length > 0) return

  // 确定性 card_id（Bug U）：一户一卡，避免 Date.now()+random 并发撞 PK
  const newCardId = `FY-CARD-${order.clientUserId}`

  const upsertRows = await tx.execute(sql`
    INSERT INTO prepaid_cards (card_id, user_id, balance)
    VALUES (${newCardId}, ${order.clientUserId}, ${faceValue.toFixed(2)})
    ON CONFLICT (user_id) DO UPDATE
      SET balance = prepaid_cards.balance + EXCLUDED.balance,
          updated_at = NOW()
    RETURNING card_id
  `)
  const cardId = (upsertRows as unknown as any[])[0]?.card_id as string | undefined
  if (!cardId) throw new ApiError('CONFLICT', '充值卡数据写入冲突，请重试')

  await tx.execute(sql`
    INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref)
    VALUES (${cardId}, '充值', ${faceValue.toFixed(2)}, ${saleOrderId}, ${externalRef || 'card-topup-' + saleOrderId})
    ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
  `)
}

/**
 * customer_type 跃迁（admin recordPayment 触发点）。
 *
 * 三端跃迁触发点之一（与 fengyu-staff/cloudfunctions/staffApi/routes/order.js
 * recalcCustomerType + fengyu-client/cloudfunctions/payNotify/index.js 镜像一致）。
 *
 * 业务口径（2026-04-26 体验卡 ticket Round 2）：
 *   - 会员客：销售单 total_amount >= memberThreshold
 *   - 小美客：销售单中存在非体验卡明细行（si.is_experience = false）
 *   - 体验客：销售单中存在体验卡明细行（si.is_experience = true）
 *   - 流量客：兜底
 *
 * 只升不降；跃迁为"会员客"时同步写入 became_member_at = COALESCE(首笔达标单 paid_at, created_at)（非检测时刻 NOW()）。
 *
 * SQL 关键字段（is_experience capability 列、不再 JOIN product_categories）必须与
 * staffApi/routes/order.js + payNotify/index.js 字面一致 —— 守卫测试
 * recalc-customer-type-sql.test.js 跨三个文件比对。
 */
type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function recalcCustomerType(tx: AdminTx, clientUserId: string): Promise<void> {
  if (!clientUserId) return

  const curRes = await tx.execute(sql`
    SELECT customer_type FROM client_wechat_users WHERE user_id = ${clientUserId}
  `)
  const curRows = curRes as unknown as Array<{ customer_type: string }>
  if (curRows[0]?.customer_type === '会员客') return

  const threshold = await getMemberThreshold()

  // 三端 SQL 独立副本（admin actions/orders.ts + staffApi routes/order.js + payNotify index.js）
  // 修改时必须同步另外两端；一致性由 staffApi __tests__/routes/recalc-customer-type-sql.test.js
  // 与 cross-end-sql-snapshot.test.js 守护，任一端漂移立即触发测试失败。
  const typeRes = await tx.execute(sql`
    SELECT CASE
       WHEN EXISTS (
         SELECT 1 FROM sale_orders o
         WHERE o.client_user_id = ${clientUserId}
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND o.total_amount >= ${threshold}
       ) THEN '会员客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         WHERE o.client_user_id = ${clientUserId}
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND si.is_experience = false
       ) THEN '小美客'
       WHEN EXISTS (
         SELECT 1
         FROM sale_orders o
         JOIN sale_items si ON si.sale_order_id = o.sale_order_id
         WHERE o.client_user_id = ${clientUserId}
           AND o.status IN ('已支付', '已完成')
           AND o.sale_order_type = '销售单'
           AND si.is_experience = true
       ) THEN '体验客'
       ELSE '流量客'
     END AS computed_type
  `)
  const typeRows = typeRes as unknown as Array<{ computed_type: string }>
  const newType = typeRows[0]?.computed_type
  if (!newType) return

  const updRes = await tx.execute(sql`
    UPDATE client_wechat_users
       SET customer_type = ${newType}::customer_type, updated_at = NOW()
     WHERE user_id = ${clientUserId}
       AND (CASE customer_type
              WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
              WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
            END)
         < (CASE ${newType}::customer_type
              WHEN '流量客' THEN 0 WHEN '体验客' THEN 1
              WHEN '小美客' THEN 2 WHEN '会员客' THEN 3
            END)
     RETURNING customer_type
  `)
  const updRowCount = rowsAffected(updRes)
  const updRows = updRes as unknown as Array<{ customer_type: string }>
  if (updRowCount > 0 && updRows[0]?.customer_type === '会员客') {
    // became_member_at 记为确立会员资格的首笔达标单时间（COALESCE(paid_at, created_at)）；
    // 选单子查询与下方 is_membership_upgrade 归因同源、选同一单。
    await tx.execute(sql`
      UPDATE client_wechat_users SET became_member_at = (
        SELECT COALESCE(o.paid_at, o.created_at) FROM sale_orders o
        WHERE o.client_user_id = ${clientUserId}
          AND o.status IN ('已支付', '已完成')
          AND o.sale_order_type = '销售单'
          AND o.total_amount >= ${threshold}
        ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC
        LIMIT 1
      ) WHERE user_id = ${clientUserId}
    `)
    // 给触发本次首次跃迁的达标销售单打会员升级标记（WHERE 与会员客判定 CASE 同源；四端镜像）。
    // 函数开头“已是会员客即 return”保证只在首次跃迁时执行一次；paid_at 最早 = 确立会员资格的首笔达标单。
    await tx.execute(sql`
      UPDATE sale_orders SET is_membership_upgrade = true
      WHERE sale_order_id = (
        SELECT o.sale_order_id FROM sale_orders o
        WHERE o.client_user_id = ${clientUserId}
          AND o.status IN ('已支付', '已完成')
          AND o.sale_order_type = '销售单'
          AND o.total_amount >= ${threshold}
        ORDER BY o.paid_at ASC NULLS LAST, o.created_at ASC
        LIMIT 1
      )
    `)
  }
}

/**
 * 开单时即时扣储值卡（全额抵扣场景：payable==0、无需付现金）。
 *
 * 与 confirmOfflinePayment 的扣卡块字面对齐：锁余额 → 校验 → UPDATE prepaid_cards.balance
 * → card_transactions(type='扣款') → sale_order_payments(change_type='储值卡抵扣')。
 * 幂等键 external_ref='card-deduct-{saleOrderId}'；余额不足抛 INSUFFICIENT_BALANCE。
 *
 * 仅在订单全额由储值卡抵扣（payable_amount==0 且 prepaid>0）时于创建事务内调用，
 * 是对「先付款后记账」不变量的有意例外（用户 2026-05-21 拍板）：无现金可收，挂"待支付"
 * 反而会卡死（payment_method='无' 无法走 confirmOfflinePayment），故创建时直接扣卡 + 结清。
 *
 * 注意：此扣卡块需与 staff order.js deductPrepaidCardAtCreation + confirmOffline / payNotify
 * 字面对齐，跨端 snapshot 测试守护。
 */
async function deductPrepaidCardAtCreation(
  tx: AdminTx,
  args: { saleOrderId: string; clientUserId: string; amount: number; employeeId: string; note: string },
): Promise<number | string | null> {
  const { saleOrderId, clientUserId, amount, employeeId, note } = args
  if (!(amount > 0) || !clientUserId) return null

  // 幂等：已扣过则跳过
  const dupRes = await tx.execute(sql`
    SELECT 1 FROM card_transactions
    WHERE ref_order_id = ${saleOrderId} AND type = '扣款' LIMIT 1
  `)
  if ((dupRes as unknown as any[]).length > 0) return null

  const balRes = await tx.execute(sql`
    SELECT card_id, balance FROM prepaid_cards
    WHERE user_id = ${clientUserId} FOR UPDATE
  `)
  const balRows = balRes as unknown as any[]
  if (balRows.length === 0) {
    throw new Error('INSUFFICIENT_BALANCE:NO_CARD: 顾客无储值卡账户')
  }
  const currentBalance = Number(balRows[0].balance)
  if (currentBalance + 0.001 < amount) {
    throw new Error(`INSUFFICIENT_BALANCE:${currentBalance}: 顾客储值卡余额不足，期望扣 ${amount}，实际 ${currentBalance}`)
  }
  const cardId = balRows[0].card_id as string
  await tx.execute(sql`
    UPDATE prepaid_cards
    SET balance = balance - ${amount}::numeric,
        updated_at = NOW()
    WHERE card_id = ${cardId}
  `)
  await tx.execute(sql`
    INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
    VALUES (${cardId}, '扣款', ${-amount}::numeric, ${saleOrderId}, ${`card-deduct-${saleOrderId}`}, NOW())
    ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
  `)
  const insRes = await tx.execute(sql`
    INSERT INTO sale_order_payments (
      sale_order_id, change_type, payment_method, amount, status,
      paid_at, source_end, operator_employee_id, note, created_at
    ) VALUES (
      ${saleOrderId}, '储值卡抵扣', '储值卡', ${amount}::numeric, '已支付',
      NOW(), 'admin', ${employeeId}, ${note}, NOW()
    )
    RETURNING id
  `)
  return (insRes as unknown as Array<{ id: number | string }>)[0]?.id ?? null
}

export const getOrders = withPermission(
  'sale_order:list',
  async (session): Promise<SaleOrder[]> => {
  // 2026-07-08 修复 T1：listOrders/getOrdersPaginated 历史上直接读 sale_orders.customerName /
  // clientPhone，没有 left join client_wechat_users。导出端（exportOrders）已做兜底，
  // 这里对齐：客户档案为权威，sale_orders 仅作 fallback（已污染的旧数据可被自动治愈）。
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
      custName: clientWechatUsers.name,
      custPhone: clientWechatUsers.phone,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(scopeCondition(session, saleOrders.storeId))
    // 例外：业务时间优先（订单日期比"最近编辑"更符合管理员直觉）
    .orderBy(desc(saleOrders.saleOrderDatetime))

  return rows.map((r) => ({
    saleOrderId: r.order.saleOrderId,
    status: r.order.status as SaleOrder['status'],
    saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
    documentType: r.order.documentType as SaleOrder['documentType'],
    refSaleOrderId: r.order.refSaleOrderId,
    legacySource: r.order.legacySource ?? null,
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    performanceAttributionDate: r.order.performanceAttributionDate,
    performanceAttributionAdjustedAt: r.order.performanceAttributionAdjustedAt?.toISOString() ?? null,
    performanceAttributionAdjustedBy: r.order.performanceAttributionAdjustedBy,
    clientUserId: r.order.clientUserId,
    // 顾客档案权威 > sale_orders 兜底（防 client_wechat_users.name='' 的旧数据被原样展示）
    clientPhone: r.custPhone || r.order.clientPhone || null,
    customerName: r.custName || r.order.customerName || null,
    totalAmount: r.order.totalAmount,
    prepaidCardAmount: r.order.prepaidCardAmount ?? '0',
    pendingPrepaidCardAmount: r.order.pendingPrepaidCardAmount ?? '0',
    payableAmount: r.order.payableAmount ?? '0',
    received: r.order.received ?? '0',
    refundedAmount: r.order.refundedAmount ?? '0',
    paymentMethod: r.order.paymentMethod as SaleOrder['paymentMethod'],
    openedBy: r.order.openedBy,
    preferredEmployeeId: r.order.preferredEmployeeId,
    paidAt: r.order.paidAt?.toISOString() ?? null,
    allocationStatus: r.order.allocationStatus as SaleOrder['allocationStatus'],
    couponId: r.order.couponId,
    couponDiscount: r.order.couponDiscount,
    remark: r.order.remark,
    isActivity: r.order.isActivity ?? false,
    isExperienceConversion: r.order.isExperienceConversion ?? false,
    firstPaymentAmount: r.order.firstPaymentAmount ?? null,
    createdAt: r.order.createdAt.toISOString(),
    updatedAt: r.order.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    openedByName: r.openedByName ?? undefined,
  }))
  },
)

/** 订单列表筛选参数 */
export interface OrderFilters {
  status?: string
  /** 订单类型多选；由 URL `type=销售单,转换单` 解析而来。 */
  types?: SaleOrderType[]
  marketId?: string
  storeId?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  /** 支付方式筛选（含 `'无'` = 全额储值卡抵扣） */
  paymentMethod?: string
  /** 是否仅筛选"有储值卡抵扣"的订单（prepaid_card_amount > 0） */
  hasPrepaidDeduction?: boolean
  /** 转换模式审计筛选：experience=体验转换，normal=普通转换 */
  conversionMode?: 'experience' | 'normal'
  /** 分配状态筛选（'待分配' | '已分配'，用于营业额分配页） */
  allocationStatus?: string
  /**
   * 仅营业额分配页/导出传 true：只保留参与营业额分配的订单类型（销售单/转换单），
   * 排除寄存单/充值单/内部单（口径与 dashboard 待分配计数一致）。
   */
  allocationEligibleOnly?: boolean
  page?: number
  pageSize?: number
}

/** 构建订单列表 WHERE 条件（列表分页与导出共用，保证筛选口径一致） */
function buildOrderConditions(
  session: Parameters<typeof scopeCondition>[0],
  filters: OrderFilters,
): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [
    scopeCondition(session, saleOrders.storeId),
  ]

  if (filters.status) {
    conditions.push(eq(saleOrders.status, filters.status as typeof saleOrders.status.enumValues[number]))
  }
  if (filters.types?.length) {
    conditions.push(inArray(saleOrders.saleOrderType, filters.types))
  }
  if (filters.conversionMode === 'experience') {
    conditions.push(and(eq(saleOrders.saleOrderType, '转换单'), eq(saleOrders.isExperienceConversion, true)))
  } else if (filters.conversionMode === 'normal') {
    conditions.push(and(eq(saleOrders.saleOrderType, '转换单'), eq(saleOrders.isExperienceConversion, false)))
  }
  if (filters.marketId) {
    conditions.push(storeInMarketCondition(saleOrders.storeId, filters.marketId))
  }
  if (filters.storeId) {
    conditions.push(eq(saleOrders.storeId, filters.storeId))
  }
  if (filters.dateFrom) {
    // dateFrom 是日期串（date input 'YYYY-MM-DD'）：ES 规范按 UTC 午夜解析 new Date(dateFrom)，
    // postgres.js 发 UTC ISO → PG 当墙钟早 8h，漏当天 00:00-08:00。直接拼北京字面 00:00:00::timestamp
    // （与 sale_order_datetime 北京字面同语义，不经 new Date/beijingTs）。
    conditions.push(gte(saleOrders.saleOrderDatetime, beijingBoundaryTs(filters.dateFrom, '00:00:00')))
  }
  if (filters.dateTo) {
    // 同上：dateTo 日期串拼 23:59:59 北京字面，取当天结束。
    conditions.push(lt(saleOrders.saleOrderDatetime, beijingBoundaryTs(filters.dateTo, '23:59:59')))
  }
  if (filters.search) {
    const pattern = `%${filters.search}%`
    conditions.push(
      or(
        ilike(saleOrders.saleOrderId, pattern),
        ilike(saleOrders.customerName, pattern),
        ilike(saleOrders.clientPhone, pattern),
      ),
    )
  }
  // 支付方式筛选（枚举已扩展为 4 值：微信/支付宝/线下/无）
  if (
    filters.paymentMethod === '微信' ||
    filters.paymentMethod === '支付宝' ||
    filters.paymentMethod === '线下' ||
    filters.paymentMethod === '无'
  ) {
    conditions.push(eq(saleOrders.paymentMethod, filters.paymentMethod))
  }
  // 有储值卡抵扣（prepaid_card_amount > 0）
  if (filters.hasPrepaidDeduction) {
    conditions.push(gt(saleOrders.prepaidCardAmount, '0'))
  }
  if (filters.allocationStatus === '待分配' || filters.allocationStatus === '已分配') {
    conditions.push(eq(saleOrders.allocationStatus, filters.allocationStatus))
  }
  // 营业额分配页/导出：只保留参与营业额分配的订单类型，排除寄存单/充值单/内部单 + 历史订单（workfine）
  if (filters.allocationEligibleOnly) {
    conditions.push(inArray(saleOrders.saleOrderType, ['销售单', '转换单']))
    conditions.push(sql`${saleOrders.legacySource} IS DISTINCT FROM 'workfine'`)
  }

  return conditions
}

/** 分页结果 */
export interface PaginatedOrders {
  data: SaleOrder[]
  total: number
}

/**
 * 服务端分页订单列表 — DB 级过滤 + LIMIT/OFFSET
 *
 * 替代 getOrders() 的客户端过滤模式，支持大数据量下的高效分页。
 * 筛选条件通过 URL searchParams → Server Component → 此函数流转。
 */
export const getOrdersPaginated = withPermission(
  'sale_order:list',
  async (session, filters: OrderFilters = {}): Promise<PaginatedOrders> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? filters.pageSize! : 20
  const offset = (page - 1) * pageSize

  // 构建 WHERE 条件（DB 级过滤，与导出共用同一构建器）
  const whereClause = and(...buildOrderConditions(session, filters))

  // COUNT 查询（与数据查询共用相同 WHERE）
  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(saleOrders)
    .where(whereClause)

  const total = countRow?.count ?? 0

  // 数据查询 — JOIN + ORDER + LIMIT/OFFSET
  // 2026-07-08 修复 T1：与 getOrders 对齐，left join clientWechatUsers 做 name/phone 兜底。
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
      custName: clientWechatUsers.name,
      custPhone: clientWechatUsers.phone,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(whereClause)
    // 例外：业务时间优先（订单日期比"最近编辑"更符合管理员直觉）
    .orderBy(desc(saleOrders.saleOrderDatetime))
    .limit(pageSize)
    .offset(offset)

  const data = rows.map((r) => ({
    saleOrderId: r.order.saleOrderId,
    status: r.order.status as SaleOrder['status'],
    saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
    documentType: r.order.documentType as SaleOrder['documentType'],
    refSaleOrderId: r.order.refSaleOrderId,
    legacySource: r.order.legacySource ?? null,
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    performanceAttributionDate: r.order.performanceAttributionDate,
    performanceAttributionAdjustedAt: r.order.performanceAttributionAdjustedAt?.toISOString() ?? null,
    performanceAttributionAdjustedBy: r.order.performanceAttributionAdjustedBy,
    clientUserId: r.order.clientUserId,
    clientPhone: r.custPhone || r.order.clientPhone || null,
    customerName: r.custName || r.order.customerName || null,
    totalAmount: r.order.totalAmount,
    prepaidCardAmount: r.order.prepaidCardAmount ?? '0',
    pendingPrepaidCardAmount: r.order.pendingPrepaidCardAmount ?? '0',
    payableAmount: r.order.payableAmount ?? '0',
    received: r.order.received ?? '0',
    refundedAmount: r.order.refundedAmount ?? '0',
    paymentMethod: r.order.paymentMethod as SaleOrder['paymentMethod'],
    openedBy: r.order.openedBy,
    preferredEmployeeId: r.order.preferredEmployeeId,
    paidAt: r.order.paidAt?.toISOString() ?? null,
    allocationStatus: r.order.allocationStatus as SaleOrder['allocationStatus'],
    couponId: r.order.couponId,
    couponDiscount: r.order.couponDiscount,
    remark: r.order.remark,
    isActivity: r.order.isActivity ?? false,
    isExperienceConversion: r.order.isExperienceConversion ?? false,
    firstPaymentAmount: r.order.firstPaymentAmount ?? null,
    /** 会员升级单标记（saleOrders.isMembershipUpgrade，recalcCustomerType 自动打标，迁移 0077 双库已迁） */
    isMembershipUpgrade: r.order.isMembershipUpgrade ?? false,
    createdAt: r.order.createdAt.toISOString(),
    updatedAt: r.order.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    openedByName: r.openedByName ?? undefined,
  }))

  return { data, total }
  },
)

/**
 * 导出行（明细级）。一行 = 一条纳入导出的明细：
 *   - 销售/内部/寄存单：sale_items[item_direction='购买']
 *   - 转换单：sale_items[item_direction='转出'|'转入']，两行都导出（转出负/转入正，照实展示）
 *   - 充值单：不写 sale_items，按订单级造一行（productName='储值卡充值'，item 级列 null）
 * 订单号/状态/顾客/支付方式等订单级字段在每条明细行内重复；
 * 金额列走「商品行口径」（与 exportAllocationOrders 对齐）：订单金额=sale_items.sale_amount（行应付）、
 *   实付=sale_items.received（行级净实收，已扣该行退款）；储值卡抵扣/现付分别直接取
 *   sale_items.prepaid_card_received / cash_received。充值单取订单级 total_amount(面额)/received(实付)。
 * 行级字段（商品类型/品质一二级/总次数/可用次数/单次价格/经营类型/商品明细）按 item 各自展示；充值单无 item 留空。
 * 寄存单 5 个销售口径金额列留空（exportOrders 内 isDeposit 分支：total=0 与 received>0 并存会误导）。
 * 历史订单（legacySource='workfine'）默认纳入，与列表分页口径一致。
 */
export interface ExportOrderRow {
  // —— 订单级（每条 item 行重复）——
  marketName: string
  storeName: string | null
  saleOrderId: string
  saleOrderType: string
  documentType: string | null
  status: string
  customerName: string | null
  clientPhone: string | null
  customerSource: string | null
  promoterEmployeeName: string | null
  /** 订单金额：sale_items.sale_amount（行应付，行级；同单多行各不同，可正确求和） */
  totalAmount: string
  /** 储值卡抵扣：sale_items.prepaid_card_received（行级实付分摊） */
  prepaidCardAmount: string
  /** 现付：sale_items.cash_received = received - prepaid_card_received */
  cashAmount: string
  /** 实付：sale_items.received（行级净实收，已扣该行退款） */
  received: string
  /** 已退：sale_orders.refunded_amount（订单级，库内无行级字段，同单多行重复） */
  refundedAmount: string
  paymentMethod: string | null
  /** 是否纳客：sale_orders.is_membership_upgrade（recalcCustomerType 在顾客首次跃迁为会员客时自动打标） */
  isMembershipUpgrade: boolean
  isActivity: boolean
  /** 是否体验转换：仅转换单可能为 true */
  isExperienceConversion: boolean
  /** 经营类型：sale_items.sales_category（行级，订单级页保留便于看清） */
  salesCategory: string | null
  /** 顾客类型：client_wechat_users.customer_type；client_user_id=NULL 时由前端 fallback「未注册」 */
  customerType: string | null
  openedByName: string | null
  saleOrderDatetime: string
  performanceAttributionDate: string
  createdAt: string
  // —— item 级（每条 item 不同）——
  /** 商品类型：sale_items.product_type（疗程卡 / 家居产品） */
  productType: string | null
  /** 品质一级：product_categories.product_kind（一级分类名） */
  categoryL1: string | null
  /** 品质二级：product_categories.category_name（二级分类名） */
  categoryL2: string | null
  /** 商品明细：sale_items.product_name 行级商品名称快照（不再聚合多行） */
  productName: string | null
  /** 总数量：sale_items.session_count；非疗程卡（家居产品）为 NULL → 前端 fallback「—」 */
  sessionCount: number | null
  /** 当前 SKU 的展示单位；历史 SKU 缺失时按商品类型回退。 */
  unit: string | null
  /** 可用数量（已付未用）：paidUnusedSessionsExpr 派生；paid_sessions 为 NULL（历史行/家居产品）退回物理剩余 */
  paidUnusedSessions: number | null
  /** 单位价格：sale_items.unit_real_price（优惠后价 → number 化便于 Excel 求和） */
  unitRealPrice: number | null
  /** 订单备注（按行重复） */
  remark: string | null
  /** 以下字段仅供异步导出 worker 跨分页聚合，不映射到 Excel 列。 */
  __sourceId?: string
  __sourceKind?: 'item' | 'recharge' | 'cardCredit'
  __skuId?: string | null
  __itemDirection?: string | null
  __quantity?: number
  __remainingSessions?: number | null
  __paidSessions?: number | null
  __itemRefundedAmount?: string | number | null
}

export interface ExportOrdersCursor {
  itemOffset: number
  rechargeOffset: number
  cardCreditOffset: number
}

export interface ExportAllocationOrdersCursor {
  allocatedOffset: number
  pendingOffset: number
}

function nonNegativeOffset(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0))
}

/** 导出订单（明细级，一行一 sale_items 行；按筛选条件导出全量）。 */
export const exportOrders = withPermission(
  'sale_order:list',
  async (
    session,
    params: Record<string, string | undefined>,
    options?: ExportBatchOptions<ExportOrdersCursor>,
  ): Promise<ExportBatchResult<ExportOrderRow, ExportOrdersCursor>> => {
    const filters = parseOrderFilters(params)
    const whereClause = and(...buildOrderConditions(session, filters))
    const limit = resolveExportBatchLimit(options?.limit)
    const cursor: ExportOrdersCursor = {
      itemOffset: nonNegativeOffset(options?.cursor?.itemOffset),
      rechargeOffset: nonNegativeOffset(options?.cursor?.rechargeOffset),
      cardCreditOffset: nonNegativeOffset(options?.cursor?.cardCreditOffset),
    }

    // 从 sale_items 出发（明细级）；innerJoin sale_orders 保证每行有归属订单
    // leftJoin 客户/员工/门店/商品三级：NULL 安全，缺失分类/skus 历史订单仍可导出
    // WHERE：购买行（销售/内部/寄存单）∪ 转换单的转出+转入两行。
    //   转换单无「购买」行（明细仅 转出/转入），若只取购买行会整单漏导；这里把转换单的转出+转入
    //   两行一并纳入，完整展示「从哪转出 → 转入什么」。转出负/转入正照实行级口径展示，金额列不留空
    //   （转换单 totalAmount 为真实转换额，非寄存单 total=0 那种特例）。
    //   充值单不写 sale_items，由下方 rechargeOrders 单独查订单级再造一行。
    const itemQuery = db
      .select({
          // 订单级
          marketName: saleOrders.marketName,
          storeName: saleOrders.storeName,
          saleOrderId: saleOrders.saleOrderId,
          saleOrderType: saleOrders.saleOrderType,
          documentType: saleOrders.documentType,
          status: saleOrders.status,
          custName: clientWechatUsers.name,
          custPhone: clientWechatUsers.phone,
          customerSource: clientWechatUsers.customerSource,
          promoterEmployeeName: clientWechatUsers.promoterEmployeeName,
          fallbackName: saleOrders.customerName,
          fallbackPhone: saleOrders.clientPhone,
          totalAmount: saleItems.saleAmount,        // 行应付（商品行口径，与 exportAllocationOrders 对齐）
          prepaidCardAmount: saleItems.prepaidCardReceived,
          cashAmount: saleItems.cashReceived,
          received: saleItems.received,             // 行级净实收（商品行口径）
          refundedAmount: saleOrders.refundedAmount,
          itemRefundedAmount: sql<string>`COALESCE((
            SELECT ABS(SUM(spir.amount::numeric))
              FROM sale_payment_item_receipts spir
              JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
             WHERE spir.sale_item_id = ${saleItems.saleItemId}
               AND sop.status = '已支付'
               AND sop.change_type = '退款'
          ), 0)`,
          paymentMethod: saleOrders.paymentMethod,
          isMembershipUpgrade: saleOrders.isMembershipUpgrade,
          isActivity: saleOrders.isActivity,
          isExperienceConversion: saleOrders.isExperienceConversion,
          customerType: clientWechatUsers.customerType,
          openedByName: opener.name,
          saleOrderDatetime: saleOrders.saleOrderDatetime,
          performanceAttributionDate: saleOrders.performanceAttributionDate,
          createdAt: saleOrders.createdAt,
          remark: saleOrders.remark,
          // item 级
          productType: saleItems.productType,
          salesCategory: saleItems.salesCategory,
          productName: saleItems.productName,
          skuId: saleItems.skuId,
          itemDirection: saleItems.itemDirection,
          quantity: saleItems.quantity,
          sessionCount: saleItems.sessionCount,
          remainingSessions: saleItems.remainingSessions,
          paidSessions: saleItems.paidSessions,
          skuUnit: productSkus.unit,
          paidUnusedSessions: paidUnusedSessionsExpr,
          unitRealPrice: saleItems.unitRealPrice,
          categoryL1: productCategories.productKind,
          categoryL2: productCategories.categoryName,
          sourceId: saleItems.saleItemId,
      })
      .from(saleItems)
      .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
      .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
      .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(and(
        whereClause,
        or(
          eq(saleItems.itemDirection, '购买'),
          and(
            eq(saleOrders.saleOrderType, '转换单'),
            inArray(saleItems.itemDirection, ['转出', '转入']),
          ),
        ),
      ))
      .orderBy(desc(saleOrders.saleOrderDatetime), saleOrders.saleOrderId, saleItems.saleItemId)
    const itemRows = limit == null
      ? await itemQuery
      : await itemQuery.limit(limit + 1).offset(cursor.itemOffset)

    const num = (v: string | null) => (v == null ? null : Number(v))

    // 充值单不写 sale_items，无法走上面的明细 JOIN；按订单级单独查后造一行纳入导出。
    // 金额取订单级：total_amount=面额、received=实付（反映充值档位）；item 级列留空，productName 标「储值卡充值」。
    const rechargeQuery = db
      .select({
          marketName: saleOrders.marketName,
          storeName: saleOrders.storeName,
          saleOrderId: saleOrders.saleOrderId,
          saleOrderType: saleOrders.saleOrderType,
          documentType: saleOrders.documentType,
          status: saleOrders.status,
          custName: clientWechatUsers.name,
          custPhone: clientWechatUsers.phone,
          customerSource: clientWechatUsers.customerSource,
          promoterEmployeeName: clientWechatUsers.promoterEmployeeName,
          fallbackName: saleOrders.customerName,
          fallbackPhone: saleOrders.clientPhone,
          totalAmount: saleOrders.totalAmount,
          prepaidCardAmount: saleOrders.prepaidCardAmount,
          orderReceived: saleOrders.received,
          received: saleOrders.received,
          refundedAmount: saleOrders.refundedAmount,
          paymentMethod: saleOrders.paymentMethod,
          isMembershipUpgrade: saleOrders.isMembershipUpgrade,
          isActivity: saleOrders.isActivity,
          isExperienceConversion: saleOrders.isExperienceConversion,
          customerType: clientWechatUsers.customerType,
          openedByName: opener.name,
          saleOrderDatetime: saleOrders.saleOrderDatetime,
          performanceAttributionDate: saleOrders.performanceAttributionDate,
          createdAt: saleOrders.createdAt,
          remark: saleOrders.remark,
          sourceId: saleOrders.saleOrderId,
      })
      .from(saleOrders)
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
      .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
      .where(and(whereClause, eq(saleOrders.saleOrderType, '充值单')))
      .orderBy(desc(saleOrders.saleOrderDatetime), saleOrders.saleOrderId)
    const rechargeOrders = limit == null
      ? await rechargeQuery
      : await rechargeQuery.limit(limit + 1).offset(cursor.rechargeOffset)

    // 普通转换单旧卡价值高于转入商品时，差额会形成一笔 card_transactions 充值流水。
    // 该资产变动不属于支付，但必须作为独立明细行导出，才能与转换单的转出/转入金额勾稽。
    const cardCreditQuery = db
      .select({
        marketName: saleOrders.marketName,
        storeName: saleOrders.storeName,
        saleOrderId: saleOrders.saleOrderId,
        saleOrderType: saleOrders.saleOrderType,
        documentType: saleOrders.documentType,
        status: saleOrders.status,
        custName: clientWechatUsers.name,
        custPhone: clientWechatUsers.phone,
        customerSource: clientWechatUsers.customerSource,
        promoterEmployeeName: clientWechatUsers.promoterEmployeeName,
        fallbackName: saleOrders.customerName,
        fallbackPhone: saleOrders.clientPhone,
        amount: cardTransactions.amount,
        paymentMethod: saleOrders.paymentMethod,
        isMembershipUpgrade: saleOrders.isMembershipUpgrade,
        isActivity: saleOrders.isActivity,
        isExperienceConversion: saleOrders.isExperienceConversion,
        customerType: clientWechatUsers.customerType,
        openedByName: opener.name,
        saleOrderDatetime: saleOrders.saleOrderDatetime,
        performanceAttributionDate: saleOrders.performanceAttributionDate,
        createdAt: cardTransactions.createdAt,
        remark: saleOrders.remark,
        sourceId: cardTransactions.id,
      })
      .from(cardTransactions)
      .innerJoin(saleOrders, eq(cardTransactions.refOrderId, saleOrders.saleOrderId))
      .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
      .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
      .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
      .where(and(
        whereClause,
        eq(saleOrders.saleOrderType, '转换单'),
        eq(cardTransactions.type, '充值'),
        gt(cardTransactions.amount, '0'),
      ))
      .orderBy(desc(saleOrders.saleOrderDatetime), saleOrders.saleOrderId, cardTransactions.id)
    const cardCreditRows = limit == null
      ? await cardCreditQuery
      : await cardCreditQuery.limit(limit + 1).offset(cursor.cardCreditOffset)

    const toAmount = (value: string | number | null | undefined) => {
      const amount = Number(value ?? 0)
      return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0
    }
    const formatAmount = (amount: number) => amount.toFixed(2)
    const resolveRechargeAmounts = (order: {
      prepaidCardAmount: string | null
      orderReceived: string | null
      refundedAmount: string | null
    }) => {
      const orderReceived = toAmount(order.orderReceived)
      const prepaidCardAmount = toAmount(order.prepaidCardAmount)
      return {
        prepaidCardAmount: formatAmount(prepaidCardAmount),
        cashAmount: formatAmount(orderReceived - prepaidCardAmount - toAmount(order.refundedAmount)),
      }
    }

    // 合并 item 行（销售/内部/寄存购买行 + 转换单转出/转入行）与充值单造行；
    // 导出按筛选条件返回全量，合并后仅做整体排序。
    const combined: Array<{
      row: ExportOrderRow
      source: 'item' | 'recharge' | 'cardCredit'
      sourceId: string
    }> = [
      ...itemRows.map((r) => {
        // 寄存单 total_amount 设计为 0、received 为真金实付（「寄存单初始化实收」回款行），
        // 与销售单口径的金额列不兼容（total=0 与 received>0 并存会误导）。导出时这 5 列对寄存单留空；
        // item 级列（商品明细/总次数/可用次数/单次价格/品类等）照常展示。
        const isDeposit = r.saleOrderType === '寄存单'
        return {
          source: 'item' as const,
          sourceId: String(r.sourceId ?? r.saleOrderId),
          row: {
          // 订单级
          marketName: r.marketName,
          storeName: r.storeName,
          saleOrderId: r.saleOrderId,
          saleOrderType: r.saleOrderType,
          documentType: r.documentType,
          status: r.status,
          customerName: r.custName || r.fallbackName || null,
          clientPhone: r.custPhone || r.fallbackPhone || null,
          customerSource: r.customerSource ?? null,
          promoterEmployeeName: r.promoterEmployeeName ?? null,
          totalAmount: isDeposit ? '' : r.totalAmount,
          prepaidCardAmount: isDeposit ? '' : (r.prepaidCardAmount ?? '0'),
          cashAmount: isDeposit ? '' : (r.cashAmount ?? '0'),
          received: isDeposit ? '' : (r.received ?? '0'),
          refundedAmount: isDeposit ? '' : (r.refundedAmount ?? '0'),
          paymentMethod: r.paymentMethod,
          isMembershipUpgrade: r.isMembershipUpgrade ?? false,
          isActivity: r.isActivity ?? false,
          isExperienceConversion: r.isExperienceConversion ?? false,
          salesCategory: r.salesCategory,
          customerType: r.customerType,
          openedByName: r.openedByName,
          saleOrderDatetime: r.saleOrderDatetime.toISOString(),
          performanceAttributionDate: r.performanceAttributionDate,
          createdAt: r.createdAt.toISOString(),
          // item 级
          productType: r.productType,
          categoryL1: r.categoryL1,
          categoryL2: r.categoryL2,
          productName: r.productName,
          sessionCount: r.sessionCount ?? null,
          unit: r.skuUnit ?? (r.productType === '家居产品' ? '盒' : '次'),
          paidUnusedSessions: r.paidUnusedSessions ?? null,
          unitRealPrice: num(r.unitRealPrice),
          remark: r.remark,
          __sourceId: String(r.sourceId ?? r.saleOrderId),
          __sourceKind: 'item' as const,
          __skuId: r.skuId ?? null,
          __itemDirection: r.itemDirection ?? null,
          __quantity: r.quantity ?? 1,
          __remainingSessions: r.remainingSessions ?? null,
          __paidSessions: r.paidSessions ?? null,
          __itemRefundedAmount: r.itemRefundedAmount ?? null,
          },
        }
      }),
      ...rechargeOrders.map((r) => {
        const settledAmounts = resolveRechargeAmounts(r)
        return {
          source: 'recharge' as const,
          sourceId: String(r.sourceId ?? r.saleOrderId),
          row: {
          // 订单级
          marketName: r.marketName,
          storeName: r.storeName,
          saleOrderId: r.saleOrderId,
          saleOrderType: r.saleOrderType,
          documentType: r.documentType,
          status: r.status,
          customerName: r.custName || r.fallbackName || null,
          clientPhone: r.custPhone || r.fallbackPhone || null,
          customerSource: r.customerSource ?? null,
          promoterEmployeeName: r.promoterEmployeeName ?? null,
          totalAmount: r.totalAmount,
          prepaidCardAmount: settledAmounts.prepaidCardAmount,
          cashAmount: settledAmounts.cashAmount,
          received: r.received ?? '0',
          refundedAmount: r.refundedAmount ?? '0',
          paymentMethod: r.paymentMethod,
          isMembershipUpgrade: r.isMembershipUpgrade ?? false,
          isActivity: r.isActivity ?? false,
          isExperienceConversion: r.isExperienceConversion ?? false,
          salesCategory: null,
          customerType: r.customerType,
          openedByName: r.openedByName,
          saleOrderDatetime: r.saleOrderDatetime.toISOString(),
          performanceAttributionDate: r.performanceAttributionDate,
          createdAt: r.createdAt.toISOString(),
          // item 级：充值单无商品明细
          productType: null,
          categoryL1: null,
          categoryL2: null,
          productName: '储值卡充值',
          sessionCount: null,
          unit: null,
          paidUnusedSessions: null,
          unitRealPrice: null,
          remark: r.remark,
          __sourceId: String(r.sourceId ?? r.saleOrderId),
          __sourceKind: 'recharge' as const,
          },
        }
      }),
      ...cardCreditRows.map((r) => ({
        source: 'cardCredit' as const,
        sourceId: String(r.sourceId),
        row: {
          marketName: r.marketName,
          storeName: r.storeName,
          saleOrderId: r.saleOrderId,
          saleOrderType: r.saleOrderType,
          documentType: r.documentType,
          status: r.status,
          customerName: r.custName || r.fallbackName || null,
          clientPhone: r.custPhone || r.fallbackPhone || null,
          customerSource: r.customerSource ?? null,
          promoterEmployeeName: r.promoterEmployeeName ?? null,
          totalAmount: r.amount,
          prepaidCardAmount: '0.00',
          cashAmount: '0.00',
          received: r.amount,
          refundedAmount: '0.00',
          paymentMethod: null,
          isMembershipUpgrade: r.isMembershipUpgrade ?? false,
          isActivity: r.isActivity ?? false,
          isExperienceConversion: r.isExperienceConversion ?? false,
          salesCategory: null,
          customerType: r.customerType,
          openedByName: r.openedByName,
          saleOrderDatetime: r.saleOrderDatetime.toISOString(),
          performanceAttributionDate: r.performanceAttributionDate,
          createdAt: r.createdAt.toISOString(),
          productType: null,
          categoryL1: null,
          categoryL2: null,
          productName: '转换差额转入储值卡',
          sessionCount: null,
          unit: null,
          paidUnusedSessions: null,
          unitRealPrice: null,
          remark: r.remark,
          __sourceId: String(r.sourceId),
          __sourceKind: 'cardCredit' as const,
        },
      })),
    ]

    combined.sort((left, right) => {
      const byTime = left.row.saleOrderDatetime < right.row.saleOrderDatetime
        ? 1
        : left.row.saleOrderDatetime > right.row.saleOrderDatetime
          ? -1
          : 0
      if (byTime !== 0) return byTime
      const byOrder = left.row.saleOrderId.localeCompare(right.row.saleOrderId)
      if (byOrder !== 0) return byOrder
      const sourcePriority = { item: 0, recharge: 1, cardCredit: 2 } as const
      const bySource = sourcePriority[left.source] - sourcePriority[right.source]
      return bySource || left.sourceId.localeCompare(right.sourceId)
    })

    const selected = limit == null ? combined : combined.slice(0, limit)
    const rows = selected.map((item) => item.row)
    if (limit == null) return { rows, truncated: false, hasMore: false }

    const itemCount = selected.filter((item) => item.source === 'item').length
    const rechargeCount = selected.filter((item) => item.source === 'recharge').length
    const cardCreditCount = selected.filter((item) => item.source === 'cardCredit').length
    const hasMore = itemRows.length > itemCount
      || rechargeOrders.length > rechargeCount
      || cardCreditRows.length > cardCreditCount
    return {
      rows,
      truncated: false,
      hasMore,
      ...(hasMore
        ? {
            nextCursor: {
              itemOffset: cursor.itemOffset + itemCount,
              rechargeOffset: cursor.rechargeOffset + rechargeCount,
              cardCreditOffset: cursor.cardCreditOffset + cardCreditCount,
            },
          }
        : {}),
    }
  },
)

/**
 * 导出营业额分配「销售提成」导出行。已分配段一行 = 一条 receipt 子分配（每被分配员工一行）；
 * 待分配占位段一行 = 一笔回款 × 一个 receipt item（分配/提成列空）。与服务提成导出（ExportAllocationServiceRow）对称。
 * 金额列为 number 便于 Excel 求和；占比/比例保留 string 原值交前端 fmtPercent；
 * isActivity / isMembershipUpgrade 为 boolean 交前端转「是/否」。
 */
export interface ExportAllocationOrderRow {
  market: string | null
  storeName: string | null
  saleOrderId: string
  saleOrderType: string | null
  documentType: string | null
  customerName: string | null
  customerPhone: string | null
  customerSource: string | null
  promoterEmployeeName: string | null
  productType: string | null
  categoryL1: string | null
  categoryL2: string | null
  productName: string | null
  sessionCount: number | null
  /** 当前 SKU 的展示单位；历史 SKU 缺失时按商品类型回退。 */
  unit: string
  /** 可用次数（已付未用）：paidUnusedSessionsExpr 派生；paid_sessions 为 NULL 退回物理剩余 */
  paidUnusedSessions: number | null
  saleAmount: number | null
  prepaidCardAmount: number | null
  received: number | null
  refundedAmount: number | null
  unitRealPrice: number | null
  status: string | null
  allocationStatus: string | null
  employeeName: string | null
  positionName: string | null
  allocationRatio: string | null
  allocationAmount: number | null
  commissionRate: string | null
  commissionAmount: number | null
  isActivity: boolean
  isMembershipUpgrade: boolean
  salesCategory: string | null
  customerType: string | null
  openedByName: string | null
  paidAt: string | null
  remark: string | null
  /** 以下字段仅供异步导出 worker 按完整回款聚合，不映射到 Excel 列。 */
  __sourceId?: string
  __salePaymentId?: number | string
  __receiptId?: number | string
  __saleItemId?: string
  __receiptAmount?: string | number
  __paymentAmount?: string | number | null
  __paymentMethod?: string | null
  __paymentChangeType?: string | null
  __skuId?: string | null
  __itemDirection?: string | null
  __quantity?: number
  __remainingSessions?: number | null
  __paidSessions?: number | null
  __employeeId?: string | null
  __roleType?: string | null
}

/**
 * 导出营业额分配「销售提成」（allocStatus 三态分流，合并后按下单时间 desc 返回全量）：
 * - 全部：已分配明细（sale_payment_item_allocations 主链，每被分配员工一行）∪ 待分配占位行（回款 × receipt item）；
 * - 已分配：仅明细段；待分配：仅占位段（分配/提成列留空，allocation_status=待分配）。
 * 已分配段 allocation → receipt → sale_items → sale_orders；待分配段 sale_order_payments(待分配) →
 * sale_payment_item_receipts → sale_items → sale_orders，粒度对齐服务提成导出（exportAllocationServiceOrders）。
 *
 * 口径：
 * - 金额走「商品行口径」：订单金额=sale_items.sale_amount、实付=sale_items.received（行级净实收）；
 *   储值卡抵扣/已退库内无行级字段，取整单 sale_orders.prepaid_card_amount / refunded_amount（同单多行重复）。
 * - 不锁订单 status='已支付'：部分支付订单的回款同样可被分配，需纳入导出（与回款维度列表一致）。
 * - 支付时间/分配状态优先取回款级（sale_payment_id），旧订单维度分配（payment_id 为 NULL）回退订单级。
 */
export const exportAllocationOrders = withPermission(
  'sale_order:list',
  async (
    session,
    params: Record<string, string | undefined>,
    options?: ExportBatchOptions<ExportAllocationOrdersCursor>,
  ): Promise<ExportBatchResult<ExportAllocationOrderRow, ExportAllocationOrdersCursor>> => {
    // 复用 list-filters 的 URL→filters 映射；覆盖两处：
    // status：不锁「已支付」（部分支付订单的已分配回款也要导出）；
    // allocationStatus：订单级状态不二次过滤，按回款级 allocation_status 在两段查询里各自控制。
    const filters = parseAllocationOrderFilters(params)
    filters.status = undefined
    filters.allocationStatus = undefined
    const allocStatus = params.allocStatus
    const limit = resolveExportBatchLimit(options?.limit)
    const cursor: ExportAllocationOrdersCursor = {
      allocatedOffset: nonNegativeOffset(options?.cursor?.allocatedOffset),
      pendingOffset: nonNegativeOffset(options?.cursor?.pendingOffset),
    }

    const num = (v: string | null | undefined) => (v == null ? null : Number(v))
    // sale_order_datetime 在 admin 运行时为 Date 对象（timestamptz 默认 parser），统一折成 ms 便于合并排序
    const toMs = (d: unknown) => (d instanceof Date ? d.getTime() : d ? Date.parse(String(d)) : 0)
    const merged: Array<{
      row: ExportAllocationOrderRow
      sort: number
      source: 'allocated' | 'pending'
      orderId: string
      paymentId: string
      sourceId: string
    }> = []
    let allocatedCandidateCount = 0
    let pendingCandidateCount = 0

    // 已分配明细段（一行 = 一条有效 sale_payment_item_allocations，每被分配员工一行）
    if (allocStatus !== '待分配') {
      const whereClause = and(eq(salePaymentItemAllocations.isVoid, false), ...buildOrderConditions(session, filters))
      const query = db
        .select({
          market: saleOrders.marketName,
          storeName: stores.storeName,
          saleOrderId: saleOrders.saleOrderId,
          saleOrderType: saleOrders.saleOrderType,
          documentType: saleOrders.documentType,
          customerName: clientWechatUsers.name,
          customerPhone: clientWechatUsers.phone,
          customerSource: clientWechatUsers.customerSource,
          promoterEmployeeName: clientWechatUsers.promoterEmployeeName,
          fallbackName: saleOrders.customerName,
          fallbackPhone: saleOrders.clientPhone,
          productType: saleItems.productType,
          categoryL1: productCategories.productKind,
          categoryL2: productCategories.categoryName,
          productName: saleItems.productName,
          skuId: saleItems.skuId,
          itemDirection: saleItems.itemDirection,
          quantity: saleItems.quantity,
          sessionCount: saleItems.sessionCount,
          remainingSessions: saleItems.remainingSessions,
          paidSessions: saleItems.paidSessions,
          skuUnit: productSkus.unit,
          paidUnusedSessions: paidUnusedSessionsExpr,
          saleAmount: saleItems.saleAmount,
          prepaidCardAmount: saleOrders.prepaidCardAmount,
          received: saleItems.received,
          refundedAmount: saleOrders.refundedAmount,
          unitRealPrice: saleItems.unitRealPrice,
          status: saleOrders.status,
          payAllocStatus: saleOrderPayments.allocationStatus,
          orderAllocStatus: saleOrders.allocationStatus,
          employeeName: staffWechatUsers.name,
          positionName: staffWechatUsers.positionName,
          employeeId: salePaymentItemAllocations.employeeId,
          roleType: salePaymentItemAllocations.roleType,
          allocationRatio: salePaymentItemAllocations.allocationRatio,
          allocationAmount: salePaymentItemAllocations.allocatedAmount,
          commissionRate: salePaymentItemAllocations.commissionRate,
          commissionAmount: salePaymentItemAllocations.commissionAmount,
          isActivity: saleOrders.isActivity,
          isMembershipUpgrade: saleOrders.isMembershipUpgrade,
          salesCategory: saleItems.salesCategory,
          customerType: clientWechatUsers.customerType,
          openedByName: opener.name,
          payPaidAt: saleOrderPayments.paidAt,
          salePaymentId: salePaymentItemReceipts.salePaymentId,
          receiptId: salePaymentItemReceipts.id,
          saleItemId: salePaymentItemReceipts.saleItemId,
          receiptAmount: salePaymentItemReceipts.amount,
          paymentAmount: saleOrderPayments.amount,
          paymentMethod: saleOrderPayments.paymentMethod,
          paymentChangeType: saleOrderPayments.changeType,
          orderPaidAt: saleOrders.paidAt,
          remark: saleOrders.remark,
          sortDatetime: saleOrders.saleOrderDatetime,
          sourceId: salePaymentItemAllocations.id,
        })
        .from(salePaymentItemAllocations)
        .innerJoin(
          salePaymentItemReceipts,
          eq(salePaymentItemReceipts.id, salePaymentItemAllocations.salePaymentItemReceiptId),
        )
        .innerJoin(saleItems, eq(salePaymentItemReceipts.saleItemId, saleItems.saleItemId))
        .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
        .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
        .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
        .leftJoin(staffWechatUsers, eq(salePaymentItemAllocations.employeeId, staffWechatUsers.employeeId))
        .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
        .leftJoin(saleOrderPayments, eq(salePaymentItemReceipts.salePaymentId, saleOrderPayments.id))
        .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
        .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
        .where(whereClause)
        .orderBy(
          desc(saleOrders.saleOrderDatetime),
          saleOrders.saleOrderId,
          salePaymentItemReceipts.salePaymentId,
          salePaymentItemReceipts.id,
          salePaymentItemAllocations.id,
        )
      const raw = limit == null
        ? await query
        : await query.limit(limit + 1).offset(cursor.allocatedOffset)
      allocatedCandidateCount = raw.length

      for (const r of raw as any[]) {
        merged.push({
          row: {
            market: r.market,
            storeName: r.storeName,
            saleOrderId: r.saleOrderId,
            saleOrderType: r.saleOrderType,
            documentType: r.documentType,
            customerName: r.customerName ?? r.fallbackName ?? null,
            customerPhone: r.customerPhone ?? r.fallbackPhone ?? null,
            customerSource: r.customerSource ?? null,
            promoterEmployeeName: r.promoterEmployeeName ?? null,
            productType: r.productType,
            categoryL1: r.categoryL1,
            categoryL2: r.categoryL2,
            productName: r.productName,
            sessionCount: r.sessionCount ?? null,
            unit: r.skuUnit ?? (r.productType === '家居产品' ? '盒' : '次'),
            paidUnusedSessions: r.paidUnusedSessions ?? null,
            saleAmount: num(r.saleAmount),
            prepaidCardAmount: num(r.prepaidCardAmount),
            received: num(r.received),
            refundedAmount: num(r.refundedAmount),
            unitRealPrice: num(r.unitRealPrice),
            status: r.status,
            allocationStatus: r.payAllocStatus ?? r.orderAllocStatus ?? null,
            employeeName: r.employeeName,
            positionName: r.positionName,
            allocationRatio: r.allocationRatio,
            allocationAmount: num(r.allocationAmount),
            commissionRate: r.commissionRate,
            commissionAmount: num(r.commissionAmount),
            isActivity: r.isActivity ?? false,
            isMembershipUpgrade: r.isMembershipUpgrade ?? false,
            salesCategory: r.salesCategory,
            customerType: r.customerType,
            openedByName: r.openedByName,
            paidAt: r.payPaidAt?.toISOString() ?? r.orderPaidAt?.toISOString() ?? null,
            remark: r.remark,
            __sourceId: String(r.sourceId),
            __salePaymentId: r.salePaymentId,
            __receiptId: r.receiptId,
            __saleItemId: r.saleItemId,
            __receiptAmount: r.receiptAmount,
            __paymentAmount: r.paymentAmount,
            __paymentMethod: r.paymentMethod,
            __paymentChangeType: r.paymentChangeType,
            __skuId: r.skuId ?? null,
            __itemDirection: r.itemDirection ?? null,
            __quantity: r.quantity ?? 1,
            __remainingSessions: r.remainingSessions ?? null,
            __paidSessions: r.paidSessions ?? null,
            __employeeId: r.employeeId ?? null,
            __roleType: r.roleType ?? null,
          },
          sort: toMs(r.sortDatetime),
          source: 'allocated',
          orderId: r.saleOrderId,
          paymentId: String(r.salePaymentId ?? ''),
          sourceId: String(r.sourceId),
        })
      }
    }

    // 待分配占位段（一行 = 一笔回款 × 一个 receipt item；无员工子分配，分配/提成列留空）
    if (allocStatus !== '已分配') {
      const whereClause = and(
        eq(saleOrderPayments.allocationStatus, '待分配'),
        eq(saleOrderPayments.status, '已支付'),
        ...buildOrderConditions(session, filters),
      )
      const query = db
        .select({
          market: saleOrders.marketName,
          storeName: stores.storeName,
          saleOrderId: saleOrders.saleOrderId,
          saleOrderType: saleOrders.saleOrderType,
          documentType: saleOrders.documentType,
          customerName: clientWechatUsers.name,
          customerPhone: clientWechatUsers.phone,
          customerSource: clientWechatUsers.customerSource,
          promoterEmployeeName: clientWechatUsers.promoterEmployeeName,
          fallbackName: saleOrders.customerName,
          fallbackPhone: saleOrders.clientPhone,
          productType: saleItems.productType,
          categoryL1: productCategories.productKind,
          categoryL2: productCategories.categoryName,
          productName: saleItems.productName,
          skuId: saleItems.skuId,
          itemDirection: saleItems.itemDirection,
          quantity: saleItems.quantity,
          sessionCount: saleItems.sessionCount,
          remainingSessions: saleItems.remainingSessions,
          paidSessions: saleItems.paidSessions,
          skuUnit: productSkus.unit,
          paidUnusedSessions: paidUnusedSessionsExpr,
          saleAmount: saleItems.saleAmount,
          prepaidCardAmount: saleOrders.prepaidCardAmount,
          received: saleItems.received,
          refundedAmount: saleOrders.refundedAmount,
          unitRealPrice: saleItems.unitRealPrice,
          status: saleOrders.status,
          payAllocStatus: saleOrderPayments.allocationStatus,
          orderAllocStatus: saleOrders.allocationStatus,
          isActivity: saleOrders.isActivity,
          isMembershipUpgrade: saleOrders.isMembershipUpgrade,
          salesCategory: saleItems.salesCategory,
          customerType: clientWechatUsers.customerType,
          openedByName: opener.name,
          payPaidAt: saleOrderPayments.paidAt,
          salePaymentId: salePaymentItemReceipts.salePaymentId,
          receiptId: salePaymentItemReceipts.id,
          saleItemId: salePaymentItemReceipts.saleItemId,
          receiptAmount: salePaymentItemReceipts.amount,
          paymentAmount: saleOrderPayments.amount,
          paymentMethod: saleOrderPayments.paymentMethod,
          paymentChangeType: saleOrderPayments.changeType,
          orderPaidAt: saleOrders.paidAt,
          remark: saleOrders.remark,
          sortDatetime: saleOrders.saleOrderDatetime,
          sourceId: salePaymentItemReceipts.id,
        })
        .from(saleOrderPayments)
        .innerJoin(
          salePaymentItemReceipts,
          eq(salePaymentItemReceipts.salePaymentId, saleOrderPayments.id),
        )
        .innerJoin(saleItems, eq(salePaymentItemReceipts.saleItemId, saleItems.saleItemId))
        .innerJoin(saleOrders, eq(saleItems.saleOrderId, saleOrders.saleOrderId))
        .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
        .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
        .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
        .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
        .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
        .where(whereClause)
        .orderBy(
          desc(saleOrders.saleOrderDatetime),
          saleOrders.saleOrderId,
          saleOrderPayments.id,
          salePaymentItemReceipts.id,
        )
      const raw = limit == null
        ? await query
        : await query.limit(limit + 1).offset(cursor.pendingOffset)
      pendingCandidateCount = raw.length

      for (const r of raw as any[]) {
        merged.push({
          row: {
            market: r.market,
            storeName: r.storeName,
            saleOrderId: r.saleOrderId,
            saleOrderType: r.saleOrderType,
            documentType: r.documentType,
            customerName: r.customerName ?? r.fallbackName ?? null,
            customerPhone: r.customerPhone ?? r.fallbackPhone ?? null,
            customerSource: r.customerSource ?? null,
            promoterEmployeeName: r.promoterEmployeeName ?? null,
            productType: r.productType,
            categoryL1: r.categoryL1,
            categoryL2: r.categoryL2,
            productName: r.productName,
            sessionCount: r.sessionCount ?? null,
            unit: r.skuUnit ?? (r.productType === '家居产品' ? '盒' : '次'),
            paidUnusedSessions: r.paidUnusedSessions ?? null,
            saleAmount: num(r.saleAmount),
            prepaidCardAmount: num(r.prepaidCardAmount),
            received: num(r.received),
            refundedAmount: num(r.refundedAmount),
            unitRealPrice: num(r.unitRealPrice),
            status: r.status,
            allocationStatus: r.payAllocStatus ?? r.orderAllocStatus ?? null,
            // 待分配：无员工子分配，分配/提成列留空
            employeeName: null,
            positionName: null,
            allocationRatio: null,
            allocationAmount: null,
            commissionRate: null,
            commissionAmount: null,
            isActivity: r.isActivity ?? false,
            isMembershipUpgrade: r.isMembershipUpgrade ?? false,
            salesCategory: r.salesCategory,
            customerType: r.customerType,
            openedByName: r.openedByName,
            paidAt: r.payPaidAt?.toISOString() ?? r.orderPaidAt?.toISOString() ?? null,
            remark: r.remark,
            __sourceId: String(r.sourceId),
            __salePaymentId: r.salePaymentId,
            __receiptId: r.receiptId,
            __saleItemId: r.saleItemId,
            __receiptAmount: r.receiptAmount,
            __paymentAmount: r.paymentAmount,
            __paymentMethod: r.paymentMethod,
            __paymentChangeType: r.paymentChangeType,
            __skuId: r.skuId ?? null,
            __itemDirection: r.itemDirection ?? null,
            __quantity: r.quantity ?? 1,
            __remainingSessions: r.remainingSessions ?? null,
            __paidSessions: r.paidSessions ?? null,
            __employeeId: null,
            __roleType: null,
          },
          sort: toMs(r.sortDatetime),
          source: 'pending',
          orderId: r.saleOrderId,
          paymentId: String(r.salePaymentId ?? ''),
          sourceId: String(r.sourceId),
        })
      }
    }

    // 统一按下单时间 desc 排序（与原已分配段排序键一致）。worker 分页时追加来源
    // 排序，避免同一时间戳跨来源翻页时重复或漏行。
    merged.sort((left, right) => {
      const byTime = right.sort - left.sort
      if (byTime !== 0) return byTime
      const byOrder = left.orderId.localeCompare(right.orderId)
      if (byOrder !== 0) return byOrder
      const bySource = left.source === right.source ? 0 : left.source === 'allocated' ? -1 : 1
      if (bySource !== 0) return bySource
      const byPayment = left.paymentId.localeCompare(right.paymentId, 'en', { numeric: true })
      return byPayment || left.sourceId.localeCompare(right.sourceId, 'en', { numeric: true })
    })
    const selected = limit == null ? merged : merged.slice(0, limit)
    const rows = selected.map((item) => item.row)
    if (limit == null) return { rows, truncated: false, hasMore: false }

    const allocatedCount = selected.filter((item) => item.source === 'allocated').length
    const pendingCount = selected.length - allocatedCount
    const hasMore = allocatedCandidateCount > allocatedCount || pendingCandidateCount > pendingCount
    return {
      rows,
      truncated: false,
      hasMore,
      ...(hasMore
        ? {
            nextCursor: {
              allocatedOffset: cursor.allocatedOffset + allocatedCount,
              pendingOffset: cursor.pendingOffset + pendingCount,
            },
          }
        : {}),
    }
  },
)

// 订单详情页可由订单查看者（sale_order:list）或退款相关角色
// （sale_order:refund_create 提单人 / sale_order:refund_approve 审批人）访问
export const getOrderById = withAnyPermission(
  ['sale_order:list', 'sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, saleOrderId: string): Promise<SaleOrder | null> => {
  // 2026-07-08 修复 T1：与 getOrders 对齐，left join clientWechatUsers 做 name/phone 兜底。
  const rows = await db
    .select({
      order: saleOrders,
      storeName: stores.storeName,
      openedByName: opener.name,
      preferredEmployeeName: preferredStaff.name,
      offlineConfirmedByName: offlineConfirmer.name,
      auditedByName: auditor.name,
      performanceAttributionAdjustedByName: performanceAttributionAdjuster.name,
      custName: clientWechatUsers.name,
      custPhone: clientWechatUsers.phone,
    })
    .from(saleOrders)
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(opener, eq(saleOrders.openedBy, opener.employeeId))
    .leftJoin(preferredStaff, eq(saleOrders.preferredEmployeeId, preferredStaff.employeeId))
    .leftJoin(offlineConfirmer, eq(saleOrders.offlineConfirmedBy, offlineConfirmer.employeeId))
    .leftJoin(auditor, eq(saleOrders.auditedBy, auditor.employeeId))
    .leftJoin(
      performanceAttributionAdjuster,
      eq(saleOrders.performanceAttributionAdjustedBy, performanceAttributionAdjuster.employeeId),
    )
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)

  if (rows.length === 0) return null

  const r = rows[0]

  // Get items with SKU join (product_name from sale_items snapshot)
  const itemRows = await db
    .select({
      item: saleItems,
      skuName: productSkus.specName,
      unit: productSkus.unit,
    })
    .from(saleItems)
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .where(eq(saleItems.saleOrderId, saleOrderId))

  const items: SaleItem[] = itemRows.map((ir) => ({
    saleItemId: ir.item.saleItemId,
    saleItemGroupId: ir.item.saleItemGroupId ?? null,
    saleOrderId: ir.item.saleOrderId,
    itemDirection: ir.item.itemDirection as SaleItem['itemDirection'],
    refSaleItemId: ir.item.refSaleItemId,
    skuId: ir.item.skuId,
    unit: ir.unit ?? (ir.item.productType === '家居产品' ? '盒' : '次'),
    sessionCount: ir.item.sessionCount,
    remainingSessions: ir.item.remainingSessions,
    paidSessions: ir.item.paidSessions,
    unitPrice: ir.item.unitPrice,
    quantity: ir.item.quantity,
    unitRealPrice: ir.item.unitRealPrice,
    saleAmount: ir.item.saleAmount,
    received: ir.item.received,
    prepaidCardReceived: ir.item.prepaidCardReceived ?? '0',
    cashReceived: ir.item.cashReceived ?? ir.item.received,
    pendingReceived: ir.item.pendingReceived,
    expireDate: ir.item.expireDate,
    pickedUpQuantity: ir.item.pickedUpQuantity,
    remark: ir.item.remark,
    salesCategory: ir.item.salesCategory as SaleItem['salesCategory'],
    createdAt: ir.item.createdAt.toISOString(),
    updatedAt: ir.item.updatedAt.toISOString(),
    skuName: ir.skuName ?? undefined,
    productName: ir.item.productName ?? undefined,
  }))

  return {
    saleOrderId: r.order.saleOrderId,
    status: r.order.status as SaleOrder['status'],
    saleOrderType: r.order.saleOrderType as SaleOrder['saleOrderType'],
    documentType: r.order.documentType as SaleOrder['documentType'],
    refSaleOrderId: r.order.refSaleOrderId,
    legacySource: r.order.legacySource ?? null,
    marketName: r.order.marketName,
    storeId: r.order.storeId,
    saleOrderDatetime: r.order.saleOrderDatetime.toISOString(),
    performanceAttributionDate: r.order.performanceAttributionDate,
    performanceAttributionAdjustedAt: r.order.performanceAttributionAdjustedAt?.toISOString() ?? null,
    performanceAttributionAdjustedBy: r.order.performanceAttributionAdjustedBy,
    clientUserId: r.order.clientUserId,
    // 顾客档案权威 > sale_orders 兜底（防 client_wechat_users.name='' 的旧数据被原样展示）
    clientPhone: r.custPhone || r.order.clientPhone || null,
    customerName: r.custName || r.order.customerName || null,
    totalAmount: r.order.totalAmount,
    prepaidCardAmount: r.order.prepaidCardAmount ?? '0',
    pendingPrepaidCardAmount: r.order.pendingPrepaidCardAmount ?? '0',
    payableAmount: r.order.payableAmount ?? '0',
    received: r.order.received ?? '0',
    refundedAmount: r.order.refundedAmount ?? '0',
    paymentMethod: r.order.paymentMethod as SaleOrder['paymentMethod'],
    openedBy: r.order.openedBy,
    preferredEmployeeId: r.order.preferredEmployeeId,
    paidAt: r.order.paidAt?.toISOString() ?? null,
    auditedAt: r.order.auditedAt?.toISOString() ?? null,
    auditedBy: r.order.auditedBy,
    allocationStatus: r.order.allocationStatus as SaleOrder['allocationStatus'],
    couponId: r.order.couponId,
    couponDiscount: r.order.couponDiscount,
    remark: r.order.remark,
    isActivity: r.order.isActivity ?? false,
    isExperienceConversion: r.order.isExperienceConversion ?? false,
    firstPaymentAmount: r.order.firstPaymentAmount ?? null,
    createdAt: r.order.createdAt.toISOString(),
    updatedAt: r.order.updatedAt.toISOString(),
    storeName: r.storeName ?? undefined,
    openedByName: r.openedByName ?? undefined,
    preferredEmployeeName: r.preferredEmployeeName ?? undefined,
    offlineConfirmedByName: r.offlineConfirmedByName ?? undefined,
    auditedByName: r.auditedByName ?? undefined,
    performanceAttributionAdjustedByName: r.performanceAttributionAdjustedByName ?? undefined,
    offlineConfirmedAt: r.order.offlineConfirmedAt?.toISOString() ?? null,
    // 营业额分配口径：仅销售单/转换单且非历史订单参与（与 allocations.ts 白名单一致），控制详情页分配入口显隐
    allocatable: ['销售单', '转换单'].includes(r.order.saleOrderType) && r.order.legacySource !== 'workfine',
    items,
  }
  },
)

export interface UpdatePerformanceAttributionDateInput {
  saleOrderId: string
  performanceAttributionDate: string
  expectedUpdatedAt: string
}

export interface UpdatePerformanceAttributionDateResult {
  success: true
  message: string
  data: {
    performanceAttributionDate: string
    performanceAttributionAdjustedAt: string
    performanceAttributionAdjustedBy: string
    performanceAttributionAdjustedByName: string
    updatedAt: string
  }
}

function isValidIsoDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const dateValue = new Date(Date.UTC(year, month - 1, day))
  return dateValue.getUTCFullYear() === year
    && dateValue.getUTCMonth() === month - 1
    && dateValue.getUTCDate() === day
}

/**
 * 一次性修改订单业绩归属日期。
 *
 * 操作时间不限；目标日期必须位于原始订单上海自然日前后 7 天（含边界）。
 * FOR UPDATE + adjusted_at IS NULL + expectedUpdatedAt 三重守卫保证并发时仅一个请求成功。
 */
export const updatePerformanceAttributionDate = withPermission(
  'sale_order:performance_attribution_update',
  async (
    session,
    input: UpdatePerformanceAttributionDateInput,
  ): Promise<UpdatePerformanceAttributionDateResult> => {
    const saleOrderId = input.saleOrderId?.trim()
    const targetDate = input.performanceAttributionDate?.trim()
    const expectedUpdatedAt = input.expectedUpdatedAt?.trim()
    if (!saleOrderId || !isValidIsoDateOnly(targetDate)) {
      throw new ApiError('INVALID_PARAMS', '订单号和有效的业绩归属日期必传')
    }
    if (!expectedUpdatedAt || Number.isNaN(new Date(expectedUpdatedAt).getTime())) {
      throw new ApiError('INVALID_PARAMS', '订单版本时间无效，请刷新后重试')
    }

    const result = await db.transaction(async (tx) => {
      const lockedRes = await tx.execute(sql`
        SELECT
          sale_order_id,
          store_id,
          performance_attribution_date::text AS performance_attribution_date,
          performance_attribution_adjusted_at,
          (sale_order_datetime AT TIME ZONE 'Asia/Shanghai')::date::text AS original_order_date,
          ((sale_order_datetime AT TIME ZONE 'Asia/Shanghai')::date - 7)::text AS min_performance_date,
          ((sale_order_datetime AT TIME ZONE 'Asia/Shanghai')::date + 7)::text AS max_performance_date
        FROM sale_orders
        WHERE sale_order_id = ${saleOrderId}
        FOR UPDATE
      `)
      const locked = (lockedRes as unknown as Array<{
        sale_order_id: string
        store_id: string
        performance_attribution_date: string
        performance_attribution_adjusted_at: Date | string | null
        original_order_date: string
        min_performance_date: string
        max_performance_date: string
      }>)[0]

      if (!locked || !isInScope(session, locked.store_id)) {
        throw new ApiError('NOT_FOUND', '订单不存在或不在当前数据权限范围内')
      }
      if (locked.performance_attribution_adjusted_at) {
        throw new ApiError('CONFLICT', '该订单的业绩归属日期已经调整过，不能再次修改')
      }
      if (targetDate === locked.performance_attribution_date) {
        throw new ApiError('INVALID_PARAMS', '新归属日期与当前日期相同，未消耗修改机会')
      }
      if (targetDate < locked.min_performance_date || targetDate > locked.max_performance_date) {
        throw new ApiError(
          'INVALID_PARAMS',
          `归属日期必须在原始订单日期 ${locked.original_order_date} 前后 7 天内（${locked.min_performance_date} 至 ${locked.max_performance_date}）`,
        )
      }

      const updatedRes = await tx.execute(sql`
        UPDATE sale_orders
        SET performance_attribution_date = ${targetDate}::date,
            performance_attribution_adjusted_at = NOW(),
            performance_attribution_adjusted_by = ${session.employeeId},
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId}
          AND performance_attribution_adjusted_at IS NULL
          AND date_trunc('milliseconds', updated_at)
              = date_trunc('milliseconds', ${expectedUpdatedAt}::timestamptz)
        RETURNING
          performance_attribution_date::text AS performance_attribution_date,
          performance_attribution_adjusted_at,
          performance_attribution_adjusted_by,
          updated_at
      `)
      const updated = (updatedRes as unknown as Array<{
        performance_attribution_date: string
        performance_attribution_adjusted_at: Date | string
        performance_attribution_adjusted_by: string
        updated_at: Date | string
      }>)[0]
      if (!updated) {
        throw new ApiError('CONFLICT', '订单已被其他人修改，请刷新后重试')
      }

      await logUpdate(
        session,
        'order.performanceAttribution.update',
        'sale_order',
        saleOrderId,
        { performanceAttributionDate: locked.performance_attribution_date },
        {
          performanceAttributionDate: updated.performance_attribution_date,
          performanceAttributionAdjustedAt: new Date(updated.performance_attribution_adjusted_at).toISOString(),
          performanceAttributionAdjustedBy: updated.performance_attribution_adjusted_by,
        },
        tx,
      )

      return {
        performanceAttributionDate: updated.performance_attribution_date,
        performanceAttributionAdjustedAt: new Date(updated.performance_attribution_adjusted_at).toISOString(),
        performanceAttributionAdjustedBy: updated.performance_attribution_adjusted_by,
        updatedAt: new Date(updated.updated_at).toISOString(),
      }
    })

    revalidatePath('/orders')
    revalidatePath(`/orders/${saleOrderId}`)
    return {
      success: true,
      message: '业绩归属日期已修改；该订单不可再次调整',
      data: {
        ...result,
        performanceAttributionAdjustedByName: session.name,
      },
    }
  },
)

/**
 * 查询订单款项流水（ticket 2026-04-24 PR-3 §3.3）
 *
 * 只读，按 created_at 升序返回；
 * - LEFT JOIN staff_wechat_users 带出操作人姓名
 * - 退款专属字段（refundReason / refSaleItemId / sessionCount / auditEmployeeId / auditAt / auditRemark）
 *   2026-05-03 起已合并到 sale_order_payments 主表，无需 JOIN。
 * 用于订单详情页展示款项流水表（首次支付 / 回款 / 退款 / 储值卡抵扣）。
 */
// 详情页支付流水：订单查看者或退款相关角色（提单人 / 审批人）均可读
export const getOrderPayments = withAnyPermission(
  ['sale_order:list', 'sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, saleOrderId: string): Promise<import('@/lib/types').SaleOrderPayment[]> => {
  // scope 校验：只有订单所在门店在 scope 内才允许查看流水
  const [order] = await db
    .select({ storeId: saleOrders.storeId })
    .from(saleOrders)
    .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)
  if (!order) return []

  const rows = await db
    .select({
      payment: saleOrderPayments,
      operatorName: staffWechatUsers.name,
      skuUnit: productSkus.unit,
      refundProductType: saleItems.productType,
    })
    .from(saleOrderPayments)
    .leftJoin(staffWechatUsers, eq(saleOrderPayments.operatorEmployeeId, staffWechatUsers.employeeId))
    .leftJoin(saleItems, eq(saleOrderPayments.refSaleItemId, saleItems.saleItemId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .where(eq(saleOrderPayments.saleOrderId, saleOrderId))
    // 例外：详情页支付流水按创建时间正序（按先后顺序阅读）
    .orderBy(asc(saleOrderPayments.createdAt))

  return rows.map((r) => ({
    id: r.payment.id,
    saleOrderId: r.payment.saleOrderId,
    changeType: r.payment.changeType as import('@/lib/types').PaymentChangeType,
    amount: r.payment.amount,
    paymentMethod: r.payment.paymentMethod as import('@/lib/types').SaleOrderPayment['paymentMethod'],
    externalTxnId: r.payment.externalTxnId,
    status: r.payment.status as import('@/lib/types').PaymentFlowStatus,
    sourceEnd: r.payment.sourceEnd as import('@/lib/types').PaymentSourceEnd,
    operatorEmployeeId: r.payment.operatorEmployeeId ?? null,
    note: r.payment.note ?? null,
    createdAt: r.payment.createdAt.toISOString(),
    paidAt: r.payment.paidAt?.toISOString() ?? null,
    operatorName: r.operatorName ?? null,
    refundReason: r.payment.refundReason ?? null,
    refSaleItemId: r.payment.refSaleItemId ?? null,
    sessionCount: r.payment.sessionCount ?? null,
    unit: r.skuUnit ?? (r.refundProductType === '家居产品' ? '盒' : '次'),
    auditEmployeeId: r.payment.auditEmployeeId ?? null,
    auditAt: r.payment.auditAt?.toISOString() ?? null,
    auditRemark: r.payment.auditRemark ?? null,
  }))
  },
)

/**
 * C4: 确认线下收款 — 仅匹配 status='待支付' AND payment_method='线下' + scope。
 *
 * 支持部分确认（confirmAmount，对齐员工端 staffApi confirmOffline）：
 *   - confirmAmount 缺省 = 剩余应付现金（payable_amount - received）；可下调做部分收款。
 *   - 写 1 行现金流水（首次/回款）+ 扣全额预选储值卡（写'储值卡抵扣'行）。
 *   - 重算 received 后：received ≥ total → '已支付'，否则 '部分支付'，剩余走「录入回款」补齐。
 * 并发：FOR UPDATE 锁原单 + 终态 UPDATE 仍带 WHERE status='待支付' 守卫 + 扣卡幂等键 card-deduct-${id}。
 * 因创建时不再写款项流水，首次确认恒写'首次支付'；双击/并发再次进入会因 status≠待支付 被拦下。
 */
export const confirmOfflinePayment = withPermission(
  'sale_order:update',
  async (
    session,
    saleOrderId: string,
    confirmAmount?: number,
  ): Promise<{ success: boolean; message: string; status?: OrderStatus; received?: string }> => {
  let txResult:
    | { matched: false }
    | { matched: true; targetStatus: OrderStatus; newReceived: number; customerName: string | null; totalAmount: string | null }
    | null = null
  try {
    txResult = await db.transaction(async (tx) => {
      // 锁原单 + 校验状态/支付方式/scope
      const lockRes = await tx.execute(sql`
        SELECT status, payment_method, store_id, total_amount, payable_amount,
               received, prepaid_card_amount, pending_prepaid_card_amount,
               client_user_id, customer_name,
               sale_order_type, first_payment_amount
        FROM sale_orders WHERE sale_order_id = ${saleOrderId} FOR UPDATE
      `)
      const lockedRows = lockRes as unknown as any[]
      if (lockedRows.length === 0) return { matched: false as const }
      const locked = lockedRows[0]
      if (locked.status !== '待支付' || locked.payment_method !== '线下') return { matched: false as const }
      if (!isInScope(session, locked.store_id)) return { matched: false as const }

      const orderTotal = Number(locked.total_amount || 0)
      const orderActualPrepaid = Number(locked.prepaid_card_amount || 0)
      const orderPendingPrepaid = Number(locked.pending_prepaid_card_amount || 0)
      const orderReceived = Number(locked.received || 0)
      const orderPayable = locked.payable_amount != null
        ? Number(locked.payable_amount)
        : Math.round((orderTotal - orderActualPrepaid - orderPendingPrepaid) * 100) / 100
      const remainingPayable = Math.round((orderPayable - orderReceived) * 100) / 100

      // 缺省确认金额（两步式 2026-06-07）= 开单约定实付草稿合计（pending_received）− 已收，cap 到剩余应付；
      // 无草稿（旧订单）回退全额 remainingPayable。前端 dialog 通常显式传 confirmAmount（已按 pending 预填），
      // 此默认主要兜底"不传金额"的调用，与 staff confirmOffline 对齐。
      const pendRes = await tx.execute(sql`
        SELECT COALESCE(SUM(pending_received), 0) AS pt FROM sale_items WHERE sale_order_id = ${saleOrderId}
      `)
      const pendingTotal = Math.round(Number((pendRes as unknown as Array<{ pt: number | string }>)[0]?.pt || 0) * 100) / 100

      // 本次确认现金金额：缺省 = 约定实付差额（无草稿回退剩余应付）；传入则校验 0 ≤ v ≤ remainingPayable
      const conversionFirstPayment = locked.sale_order_type === '转换单'
        ? Number(locked.first_payment_amount || 0)
        : 0
      let cashAmount: number
      if (confirmAmount === undefined || confirmAmount === null) {
        // ⚠️ 储值卡从「当下实付」里抵：现金 = pending − 待扣卡 − 已收（与 staff confirmOffline 字面对齐，
        //    否则欠款+卡订单会多收一笔卡额）。外层 max(0,…) 兜底 pending < prepaid。
        cashAmount = conversionFirstPayment > 0
          ? Math.min(remainingPayable, conversionFirstPayment)
          : pendingTotal > 0
            ? Math.max(0, Math.min(remainingPayable, Math.round((pendingTotal - orderPendingPrepaid - orderReceived) * 100) / 100))
            : remainingPayable
      } else {
        cashAmount = Math.round(Number(confirmAmount) * 100) / 100
        if (!Number.isFinite(cashAmount) || cashAmount < 0) {
          throw new ApiError('INVALID_PARAMS', '本次确认金额必须为非负数')
        }
        if (cashAmount > remainingPayable + 0.005) {
          throw new ApiError('INVALID_PARAMS', '本次确认金额不能超过剩余应付金额')
        }
        if (conversionFirstPayment > 0 && cashAmount > conversionFirstPayment + 0.005) {
          throw new ApiError('INVALID_PARAMS', '本次确认金额不能超过转换单录入的实付金额')
        }
      }

      // 设置卡到期日（确认收款即视为卡生效，1 年有效期；部分确认也设置，避免后续补款无触发点）
      await tx.execute(sql`
        UPDATE sale_items
        SET expire_date = (NOW() + INTERVAL '1 year')::date,
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId}
          AND expire_date IS NULL
      `)

      // ========== 储值卡抵扣扣款（ticket 2026-05-19）==========
      // 锁余额 → 扣减 → 写 card_transactions(type='扣款') + 写 sale_order_payments(change_type='储值卡抵扣')
      // 与 staff confirmOffline 字面对齐；幂等键 card-deduct-${id}。首次确认时扣全额预选卡。
      const clientUserId = locked.client_user_id as string | null
      // 回款事件主流水行 id（现金行优先；纯储值卡则取储值卡抵扣行）—— 按回款逐笔分配的归属键
      let cashPaymentId: number | string | null = null
      let cardPaymentId: number | string | null = null
      if (orderPendingPrepaid > 0 && clientUserId) {
        const dupRes = await tx.execute(sql`
          SELECT 1 FROM card_transactions
          WHERE ref_order_id = ${saleOrderId} AND type = '扣款' LIMIT 1
        `)
        const dupRows = dupRes as unknown as any[]
        if (dupRows.length === 0) {
          const balRes = await tx.execute(sql`
            SELECT card_id, balance FROM prepaid_cards
            WHERE user_id = ${clientUserId} FOR UPDATE
          `)
          const balRows = balRes as unknown as any[]
          if (balRows.length === 0) {
            throw new Error('INSUFFICIENT_BALANCE:NO_CARD: 顾客无储值卡账户')
          }
          const currentBalance = Number(balRows[0].balance)
          if (currentBalance + 0.001 < orderPendingPrepaid) {
            throw new Error(`INSUFFICIENT_BALANCE:${currentBalance}: 顾客储值卡余额不足，期望扣 ${orderPendingPrepaid}，实际 ${currentBalance}`)
          }
          const cardId = balRows[0].card_id as string
          await tx.execute(sql`
            UPDATE prepaid_cards
            SET balance = balance - ${orderPendingPrepaid}::numeric,
                updated_at = NOW()
            WHERE card_id = ${cardId}
          `)
          await tx.execute(sql`
            INSERT INTO card_transactions (card_id, type, amount, ref_order_id, external_ref, created_at)
            VALUES (${cardId}, '扣款', ${-orderPendingPrepaid}::numeric, ${saleOrderId}, ${`card-deduct-${saleOrderId}`}, NOW())
            ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
          `)
          const cardIns = await tx.execute(sql`
            INSERT INTO sale_order_payments (
              sale_order_id, change_type, payment_method, amount, status,
              paid_at, source_end, operator_employee_id, note, created_at
            ) VALUES (
              ${saleOrderId}, '储值卡抵扣', '储值卡', ${orderPendingPrepaid}::numeric, '已支付',
              NOW(), 'admin', ${session.employeeId}, '管理后台确认线下收款-储值卡抵扣', NOW()
            )
            RETURNING id
          `)
          cardPaymentId = (cardIns as unknown as Array<{ id: number | string }>)[0]?.id ?? null
        }
      }

      // 现金流水：confirmAmount > 0 时写 1 行（首次/回款）。
      // change_type：已存在非储值卡 payments → '回款'，否则 '首次支付'（正常路径恒为首次支付）。
      if (cashAmount > 0) {
        const existRes = await tx.execute(sql`
          SELECT 1 FROM sale_order_payments
          WHERE sale_order_id = ${saleOrderId} AND status = '已支付'
            AND change_type IN ('首次支付','回款','退款') LIMIT 1
        `)
        const existRows = existRes as unknown as any[]
        const cashChangeType = existRows.length > 0 ? '回款' : '首次支付'
        const cashIns = await tx.execute(sql`
          INSERT INTO sale_order_payments (
            sale_order_id, change_type, payment_method, amount, status,
            paid_at, source_end, operator_employee_id, note, created_at
          ) VALUES (
            ${saleOrderId}, ${cashChangeType}, '线下', ${cashAmount.toFixed(2)}::numeric, '已支付',
            NOW(), 'admin', ${session.employeeId}, '管理后台确认线下收款', NOW()
          )
          RETURNING id
        `)
        cashPaymentId = (cashIns as unknown as Array<{ id: number | string }>)[0]?.id ?? null
      }

      // 重算 received / prepaid_card_amount（跨端字面对齐 staff confirmOffline / recordPayment）：
      //   received = Σ(amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
      //   prepaid_card_amount = Σ(amount WHERE status='已支付' AND change_type='储值卡抵扣')
      const sumRes = await tx.execute(sql`
        SELECT
          COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
                            THEN amount::numeric ELSE 0 END), 0) AS new_received,
          COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                            THEN amount::numeric ELSE 0 END), 0) AS new_prepaid
        FROM sale_order_payments
        WHERE sale_order_id = ${saleOrderId}
      `)
      const sumRow = (sumRes as unknown as any[])[0]
      const newReceived = Math.round(Number(sumRow.new_received) * 100) / 100
      const newPrepaid = Math.round(Number(sumRow.new_prepaid) * 100) / 100

      // 普通订单按 total 结清；充值单 total 是面额，按 payable（本次实付）结清。
      const settleTarget = locked.sale_order_type === '充值单'
        ? Math.round(orderPayable * 100) / 100
        : Math.round(orderTotal * 100) / 100
      const targetStatus: OrderStatus = newReceived + 0.005 >= settleTarget ? '已支付' : '部分支付'
      // paid_at 写北京墙钟字面（见 lib/db-time）：结清→NOW()，未结清→NULL（保留原行为）。
      const paidAtExpr = targetStatus === '已支付' ? nowTs() : sql`NULL`
      const updRes = await tx.execute(sql`
        UPDATE sale_orders
        SET status = ${targetStatus}::order_status,
            received = ${newReceived.toFixed(2)}::numeric,
            prepaid_card_amount = ${newPrepaid.toFixed(2)}::numeric,
            pending_prepaid_card_amount = 0,
            payable_amount = CASE
              WHEN sale_order_type IN ('销售单', '内部单', '转换单')
                THEN GREATEST(total_amount - ${newPrepaid.toFixed(2)}::numeric, 0)
              ELSE payable_amount
            END,
            first_payment_amount = NULL,
            paid_at = ${paidAtExpr},
            offline_confirmed_by = ${session.employeeId},
            offline_confirmed_at = NOW(),
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId} AND status = '待支付'
      `)
      if (rowsAffected(updRes) === 0) {
        // 并发：状态在本事务可见性内已变更
        return { matched: false as const }
      }

      // 充值卡入账 + 客户分类跃迁：仅订单结清（已支付）时触发
      if (targetStatus === '已支付') {
        await applyRechargeOnOrderPaid(tx, saleOrderId)
      }
      // 按回款逐笔分配：捕获本次线下收款逐项可分配额 + 置回款待分配 + 汇总刷新（confirmOffline 无定向）
      // 必须在 recalcPaidSessionsForOrder 之前：新 STEP1 从 receipt 聚合 received。
      const cashThis = cashPaymentId ? cashAmount : 0
      const cardThis = cardPaymentId ? orderPendingPrepaid : 0
      const allocEventAmount = Math.round((cashThis + cardThis) * 100) / 100
      const allocPrimaryId = cashPaymentId || cardPaymentId
      if (allocPrimaryId && allocEventAmount > 0) {
        await capturePaymentAllocatables(tx, {
          salePaymentId: allocPrimaryId,
          saleOrderId,
          eventAmount: allocEventAmount,
          directedItems: null,
        })
        await refreshOrderAllocationRollup(tx, saleOrderId)
      }

      // 积分发放 + paid_sessions 重算：始终执行（净额/幂等；部分支付也要按比例推进 paid_sessions）
      // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
      await settlePointsSafe(tx, saleOrderId, 'admin.confirmOffline')
      await recalcPaidSessionsForOrder(tx, saleOrderId)
      if (targetStatus === '已支付' && clientUserId) {
        await recalcCustomerType(tx, clientUserId)
      }

      return {
        matched: true as const,
        targetStatus,
        newReceived,
        customerName: locked.customer_name ?? null,
        totalAmount: locked.total_amount ?? null,
      }
    })
  } catch (err: any) {
    if (err instanceof ApiError && err.prefix === 'INVALID_PARAMS') {
      return { success: false, message: err.message.replace(/^INVALID_PARAMS:\s*/, '') }
    }
    // 透传 INSUFFICIENT_BALANCE（储值卡余额不足 / 无卡）
    const msg: string = err?.message || ''
    if (msg.startsWith('INSUFFICIENT_BALANCE')) {
      const stripped = msg.replace(/^INSUFFICIENT_BALANCE:?(NO_CARD)?:?\s*/, '')
      return { success: false, message: stripped || '顾客储值卡余额不足' }
    }
    return { success: false, message: '确认收款失败，请稍后重试' }
  }

  if (!txResult || !txResult.matched) {
    return { success: false, message: '订单状态已变更，无法确认收款' }
  }

  await logTransition(session, 'order.confirmPayment', 'sale_order', saleOrderId, '待支付', txResult.targetStatus, {
    customerName: txResult.customerName, totalAmount: txResult.totalAmount,
  })

  revalidatePath('/orders')
  revalidatePath(`/orders/${saleOrderId}`)
  return {
    success: true,
    message: txResult.targetStatus === '已支付' ? '确认收款成功' : '已确认部分收款',
    status: txResult.targetStatus,
    received: txResult.newReceived.toFixed(2),
  }
  },
)

/** C4: 关闭订单 — 仅待支付/支付失败可关闭，同时作废关联的分配记录 */
export const closeOrder = withPermission(
  'sale_order:update',
  async (session, saleOrderId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志
  const [orderCtx] = await db
    .select({
      status: saleOrders.status,
      customerName: saleOrders.customerName,
      totalAmount: saleOrders.totalAmount,
      saleOrderType: saleOrders.saleOrderType,
      storeId: saleOrders.storeId,
    })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  // 事务：关闭订单 + 作废分配，原子提交
  try {
    const txResult = await db.transaction(async (tx) => {
      const result = await tx
        .update(saleOrders)
        .set({
          status: '已关闭',
          allocationStatus: null,
          pendingPrepaidCardAmount: '0',
          payableAmount: sql`CASE
            WHEN ${saleOrders.saleOrderType} IN ('销售单', '内部单', '转换单')
              THEN GREATEST(${saleOrders.totalAmount} - ${saleOrders.prepaidCardAmount}, 0)
            ELSE ${saleOrders.payableAmount}
          END`,
        })
        .where(and(
          eq(saleOrders.saleOrderId, saleOrderId),
          or(eq(saleOrders.status, '待支付'), eq(saleOrders.status, '支付失败')),
          scopeCondition(session, saleOrders.storeId),
        ))

      if ((result as any).count === 0) {
        return { matched: false }
      }

      if (orderCtx?.saleOrderType === '转换单' && orderCtx.storeId) {
        await rollbackPendingConversionOnClose(tx, saleOrderId)
      }

      // 作废关联的营业额子分配（规范：订单关闭时作废分配）
      await tx.execute(sql`
        UPDATE sale_payment_item_allocations
           SET is_void = true, voided_at = NOW(), updated_at = NOW()
         WHERE sale_payment_item_receipt_id IN (
           SELECT id FROM sale_payment_item_receipts WHERE sale_order_id = ${saleOrderId}
         )
           AND is_void = false
      `)

      await tx.execute(sql`
        UPDATE sale_order_payments
         SET allocation_status = NULL,
             status = CASE WHEN status = '待支付' THEN '已作废' ELSE status END
       WHERE sale_order_id = ${saleOrderId}
          AND (allocation_status IN ('待分配', '已分配') OR status = '待支付')
      `)

      // 归还优惠券（订单关闭时释放已核销的券）
      await tx
        .update(userCoupons)
        .set({ status: '未使用', usedSaleOrderId: null, usedAt: null })
        .where(eq(userCoupons.usedSaleOrderId, saleOrderId))

      return { matched: true }
    })

    if (!txResult.matched) {
      return { success: false, message: '订单状态已变更，无法关闭' }
    }
  } catch {
    return { success: false, message: '关闭订单失败，请稍后重试' }
  }

  await logTransition(session, 'order.close', 'sale_order', saleOrderId, orderCtx?.status ?? '待支付', '已关闭', {
    customerName: orderCtx?.customerName, totalAmount: orderCtx?.totalAmount,
  })

  revalidatePath('/orders')
  revalidatePath('/allocations')
  return { success: true, message: '订单已关闭' }
  },
)

/** C4: 重置支付失败 → 待支付（仅店长） */
export const resetOrderFailed = withPermission(
  'sale_order:update',
  async (session, saleOrderId: string): Promise<{ success: boolean; message: string }> => {
  // 获取上下文用于日志
  const [orderCtx] = await db
    .select({ customerName: saleOrders.customerName, totalAmount: saleOrders.totalAmount })
    .from(saleOrders)
    .where(eq(saleOrders.saleOrderId, saleOrderId))
    .limit(1)

  let result: any
  try {
    result = await db
      .update(saleOrders)
      .set({ status: '待支付' })
      .where(and(
        eq(saleOrders.saleOrderId, saleOrderId),
        eq(saleOrders.status, '支付失败'),
        scopeCondition(session, saleOrders.storeId),
      ))
  } catch (err: any) {
    throw err
  }

  if ((result as any).count === 0) {
    return { success: false, message: '订单状态已变更，无法重置' }
  }

  await logTransition(session, 'order.resetFailed', 'sale_order', saleOrderId, '支付失败', '待支付', {
    customerName: orderCtx?.customerName, totalAmount: orderCtx?.totalAmount,
  })

  revalidatePath('/orders')
  return { success: true, message: '已重置为待支付' }
  },
)

/**
 * 物理删除订单（仅系统管理员；数据治理用，清理无意义的测试单据）。
 *
 * 强守卫：有实收 / 已支付状态 / 有已支付款项流水 / 关联积分·储值卡流水 /
 *         明细被服务·提货·预约引用 / 存在引用本单的回款·退款·转换子单 → 一律禁删。
 * 财务/资产流水（point_transactions / card_transactions / 已支付 payment）绝不级联删除，只做守卫拦截。
 * 可删时事务内：释放优惠券 → 删营业额子分配/receipt → 删（仅剩的待支付）payment → 删 sale_items → 删主单。
 * 任何残留外键引用由 pgErrorCode 23503 兜底回滚，安全失败而非误删。
 */
export const deleteOrder = withPermission(
  'sale_order:delete',
  async (session, saleOrderId: string): Promise<{ success: boolean; message: string }> => {
    requireAdmin(session)
    // 1. 读取 + 业务守卫
    const [order] = await db
      .select({
        status: saleOrders.status,
        received: saleOrders.received,
        customerName: saleOrders.customerName,
        totalAmount: saleOrders.totalAmount,
        saleOrderType: saleOrders.saleOrderType,
        // 历史已作废单的删除分支会读这个字段写入 audit snapshot；
        // 同时事务内 DELETE 守卫通过它识别"是否 WorkFine 历史单"以放行。
        legacySource: saleOrders.legacySource,
      })
      .from(saleOrders)
      .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
      .limit(1)

    if (!order) {
      return { success: false, message: '订单不存在或无权操作' }
    }
    // 寄存单是手工填报的剩余次数初始化单，可能填错；未消耗时无视 status（含已支付）允许物理删除。
    const isDeposit = order.saleOrderType === '寄存单'
    // 非寄存单的资金守卫：寄存单 status='已支付' 是常态，此处跳过（由 downstream「未消耗」守卫单独把关）
    if (
      !isDeposit &&
      (Number(order.received) > 0 || (['已支付', '已完成', '部分支付'] as string[]).includes(order.status))
    ) {
      return { success: false, message: '订单已有实收或已支付，不可删除（财务数据受保护）' }
    }

    // 非寄存单：已支付款项流水（财务，禁删）。寄存单跳过 —— 其历史实收初始化流水（note='寄存单初始化实收'）
    // 在事务内级联清理（sale_order_payments WHERE sale_order_id 删行）
    if (!isDeposit) {
      const [paidPayment] = await db
        .select({ id: saleOrderPayments.id })
        .from(saleOrderPayments)
        .where(and(eq(saleOrderPayments.saleOrderId, saleOrderId), eq(saleOrderPayments.status, '已支付')))
        .limit(1)
      if (paidPayment) {
        return { success: false, message: '订单存在已支付款项流水，不可删除' }
      }
    }

    // 积分 / 储值卡流水关联（账户级资产，禁删）
    const [ptRef] = await db.execute<{ one: number }>(
      sql`SELECT 1 AS one FROM point_transactions WHERE ref_order_id = ${saleOrderId} LIMIT 1`,
    ) as unknown as Array<{ one: number }>
    const [ctRef] = await db.execute<{ one: number }>(
      sql`SELECT 1 AS one FROM card_transactions WHERE ref_order_id = ${saleOrderId} LIMIT 1`,
    ) as unknown as Array<{ one: number }>
    if (ptRef || ctRef) {
      return { success: false, message: '订单关联了积分或储值卡流水，不可删除' }
    }

    // 明细被服务单 / 提货记录 / 预约引用（已产生下游业务，禁删）
    // 对寄存单：这是「疗程卡未消耗」的唯一闸门 —— 一旦被核销/提货/预约引用即拒删
    const [downstream] = await db.execute<{ one: number }>(
      sql`SELECT 1 AS one
          FROM sale_items si
          WHERE si.sale_order_id = ${saleOrderId}
            AND (
              EXISTS (SELECT 1 FROM service_items WHERE sale_item_id = si.sale_item_id)
              OR EXISTS (SELECT 1 FROM pickup_records WHERE sale_item_id = si.sale_item_id)
              OR EXISTS (SELECT 1 FROM appointments WHERE sale_item_id = si.sale_item_id)
            )
          LIMIT 1`,
    ) as unknown as Array<{ one: number }>
    if (downstream) {
      return { success: false, message: '订单已产生服务单 / 提货 / 预约，不可删除' }
    }

    // 被回款 / 退款 / 转换子单引用
    const [childOrder] = await db
      .select({ id: saleOrders.saleOrderId })
      .from(saleOrders)
      .where(eq(saleOrders.refSaleOrderId, saleOrderId))
      .limit(1)
    if (childOrder) {
      return { success: false, message: '存在引用本单的回款 / 退款 / 转换单据，不可删除' }
    }

    // 2. 事务级联删除（仅安全从属表 + 释放券；再删主单并复核可删条件）
    try {
      const txResult = await db.transaction(async (tx) => {
        await tx
          .update(userCoupons)
          .set({ status: '未使用', usedSaleOrderId: null, usedAt: null })
          .where(eq(userCoupons.usedSaleOrderId, saleOrderId))

        await tx.execute(sql`
          DELETE FROM sale_payment_item_allocations
          WHERE sale_payment_item_receipt_id IN (
            SELECT id FROM sale_payment_item_receipts WHERE sale_order_id = ${saleOrderId}
          )
        `)
        await tx.execute(sql`DELETE FROM sale_payment_item_receipts WHERE sale_order_id = ${saleOrderId}`)
        // 仅剩待支付/已作废流水（已支付已被守卫拦截）
        await tx.execute(sql`DELETE FROM sale_order_payments WHERE sale_order_id = ${saleOrderId}`)
        await tx.execute(sql`DELETE FROM sale_items WHERE sale_order_id = ${saleOrderId}`)

        const result = await tx
          .delete(saleOrders)
          .where(and(
            eq(saleOrders.saleOrderId, saleOrderId),
            // 寄存单 status='已支付' 是常态，复检放行：未消耗寄存单无视 status 可删
            // 历史已作废单（legacy_source='workfine' AND status='已作废'）放行：
            //   历史单已通过 rejectLegacyOrder 软标记为'已作废'，物理删除是为了释放 PK 让 WorkFine 数据可重新拉取；
            //   其它守卫（资金/已支付流水/积分储值卡/下游引用/子单引用）天然放行（received=0、无 items/流水/下游）。
            //   双重限定 and(legacy, status) 防 future-proof 误放行：legacySource='workfine' 唯一来源是 WorkFine 导入脚本，
            //   status='已作废' 唯一来源是 rejectLegacyOrder（已限定 legacy_source='workfine'），二者同时成立只能是历史已作废单。
            or(
              inArray(saleOrders.status, ['待支付', '支付失败', '已关闭']),
              eq(saleOrders.saleOrderType, '寄存单'),
              and(
                eq(saleOrders.legacySource, 'workfine'),
                eq(saleOrders.status, '已作废'),
              ),
            ),
            scopeCondition(session, saleOrders.storeId),
          ))
        if ((result as any).count === 0) {
          // 状态在读取后被改（并发），抛出以回滚全部子表删除
          throw new Error('ORDER_STATE_CHANGED')
        }
        return true
      })
      if (!txResult) {
        return { success: false, message: '订单状态已变更，请刷新重试' }
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'ORDER_STATE_CHANGED') {
        return { success: false, message: '订单状态已变更，请刷新重试' }
      }
      if (pgErrorCode(e) === '23503') {
        return { success: false, message: '订单存在关联业务数据，无法删除' }
      }
      throw e
    }

    await logOperation(session, 'order.delete', 'sale_order', saleOrderId, {
      snapshot: {
        status: order.status,
        received: order.received,
        totalAmount: order.totalAmount,
        customerName: order.customerName,
        saleOrderType: order.saleOrderType,
        // 历史已作废单删除需在审计中明确区分：auditReason='historical_void_cleanup' 便于日后追溯
        // 「为释放 PK 重新拉取 WorkFine 而清理作废单」这类操作的频次与责任人。
        legacySource: order.legacySource,
        auditReason: order.legacySource === 'workfine' && order.status === '已作废'
          ? 'historical_void_cleanup' : 'admin_cleanup',
      },
    })

    revalidatePath('/orders')
    revalidatePath('/allocations')
    // 友好性：删完后店长去 /legacy-orders 重新拉取 WorkFine 时，新落库的「未审核」单能立即可见，
    // 不必手动刷新。虽然已作废单本身不在 /legacy-orders 列表（listLegacyOrders 限定 status='未审核'），
    // 但 revalidate 一处对未来"删除历史已通过单"等场景也是安全的兜底。
    revalidatePath('/legacy-orders')
    return { success: true, message: '订单已删除' }
  },
)

type BundleOrderItem = {
  skuId: string
  quantity: number
  isBundle?: boolean
}

type NormalSkuMarketScopeRow = {
  skuId: string
  specName: string | null
  isExperience: boolean | null
  marketScope: string | null | undefined
}

/**
 * 普通 SKU 的提交兜底：仅检查实际配置了 market_scope 的非体验卡 SKU。
 *
 * 全局 SKU 无需额外查询，保留原有的 SKU 不存在/软删除错误口径；套餐子 SKU
 * 由 validateBundleOrderForCustomer 校验套餐主商品范围，不能在此重复套 SKU 范围。
 */
async function findNormalSkuMarketScopeViolation(
  clientUserId: string,
  skuRows: NormalSkuMarketScopeRow[],
): Promise<NormalSkuMarketScopeRow | null> {
  const restrictedSkuById = new Map<string, NormalSkuMarketScopeRow>()
  for (const sku of skuRows) {
    if (sku.isExperience === true || sku.marketScope == null) continue
    restrictedSkuById.set(sku.skuId, sku)
  }
  if (restrictedSkuById.size === 0) return null

  const customerMarketScope = await resolveCustomerOrderMarketScope(clientUserId)
  const restrictedSkuIds = [...restrictedSkuById.keys()]
  const visibleRows = await db
    .select({ skuId: productSkus.skuId })
    .from(productSkus)
    .where(and(
      inArray(productSkus.skuId, restrictedSkuIds),
      eq(productSkus.isExperience, false),
      isNull(productSkus.deletedAt),
      orderMarketScopeCondition(productSkus.marketScope, customerMarketScope),
    ))
  const visibleSkuIds = new Set(visibleRows.map((row) => row.skuId))

  for (const skuId of restrictedSkuIds) {
    if (!visibleSkuIds.has(skuId)) return restrictedSkuById.get(skuId)!
  }
  return null
}

function normalSkuMarketScopeMessage(sku: NormalSkuMarketScopeRow): string {
  return `商品「${sku.specName || sku.skuId}」不适用于该顾客绑定门店`
}

/**
 * 管理后台组合套餐提交兜底：重查套餐主商品范围、SKU 归属与分组配额。
 * 列表筛选只改善体验，真正的授权边界必须在提交时再次确认。
 */
async function validateBundleOrderForCustomer(
  bundleProductId: string | null | undefined,
  clientUserId: string,
  items: BundleOrderItem[],
): Promise<string | null> {
  if (!bundleProductId) {
    return items.some((item) => item.isBundle)
      ? '套餐订单缺少套餐标识，请刷新页面后重试'
      : null
  }

  if (items.length === 0) return '组合套餐商品明细不能为空'

  const customerMarketScope = await resolveCustomerOrderMarketScope(clientUserId)
  const [bundle] = await db
    .select({ productId: products.productId })
    .from(products)
    .where(and(
      eq(products.productId, bundleProductId),
      eq(products.isBundle, true),
      isNull(products.deletedAt),
      orderMarketScopeCondition(products.marketScope, customerMarketScope),
    ))
    .limit(1)

  if (!bundle) {
    return '组合套餐不存在、已删除或不适用于该顾客绑定门店'
  }

  const [groupRows, bundleSkuRows] = await Promise.all([
    db
      .select({
        id: mallBundleGroups.id,
        groupName: mallBundleGroups.groupName,
        pickCount: mallBundleGroups.pickCount,
      })
      .from(mallBundleGroups)
      .where(eq(mallBundleGroups.productId, bundleProductId)),
    db
      .select({
        skuId: mallProductSkus.skuId,
        bundleGroupId: mallProductSkus.bundleGroupId,
      })
      .from(mallProductSkus)
      .where(eq(mallProductSkus.productId, bundleProductId)),
  ])

  const skuToGroupId = new Map(bundleSkuRows.map((row) => [row.skuId, row.bundleGroupId]))
  for (const item of items) {
    if (!skuToGroupId.has(item.skuId)) {
      return `SKU ${item.skuId} 不属于该组合套餐`
    }
  }

  const pickedQtyByGroup = new Map<number, number>()
  const pickedSkusByGroup = new Map<number, Set<string>>()
  for (const item of items) {
    const groupId = skuToGroupId.get(item.skuId)
    if (groupId == null) continue
    const quantity = Number(item.quantity) || 0
    pickedQtyByGroup.set(groupId, (pickedQtyByGroup.get(groupId) ?? 0) + quantity)
    const pickedSkus = pickedSkusByGroup.get(groupId) ?? new Set<string>()
    pickedSkus.add(item.skuId)
    pickedSkusByGroup.set(groupId, pickedSkus)
  }

  const totalSkusByGroup = new Map<number, number>()
  for (const row of bundleSkuRows) {
    if (row.bundleGroupId == null) continue
    totalSkusByGroup.set(row.bundleGroupId, (totalSkusByGroup.get(row.bundleGroupId) ?? 0) + 1)
  }

  for (const group of groupRows) {
    if (group.pickCount == null) {
      const total = totalSkusByGroup.get(group.id) ?? 0
      const picked = pickedSkusByGroup.get(group.id)?.size ?? 0
      if (picked !== total) {
        return `套餐分组「${group.groupName}」需全选 ${total} 项，实际 ${picked} 项`
      }
      continue
    }

    const picked = pickedQtyByGroup.get(group.id) ?? 0
    if (picked !== group.pickCount) {
      return `套餐分组「${group.groupName}」需选 ${group.pickCount} 件，实际 ${picked} 件`
    }
  }

  return null
}

/** 管理后台开单 — source='admin' */
export const createOrder = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
  storeId: string
  marketName: string
  clientUserId: string
  clientPhone: string
  customerName: string
  paymentMethod: '微信' | '支付宝' | '线下'
  // 2026-04-26 sale-order-domain-refactor：5→3 值
  // '回款单' 走 recordPayment（写 sop[change_type='回款']）；
  // '退款单' 走 createRefund（写 sop[change_type='退款']）；
  // 此处仅接受 3 个真实业务类型
  saleOrderType: '销售单' | '内部单' | '转换单'
  openedBy?: string
  preferredEmployeeId?: string
  remark?: string | null
  /** 活动单标记（纯标识，不影响金额/提成口径） */
  isActivity?: boolean
  /** 可选：顾客选择使用的优惠券实例ID */
  couponId?: string | null
  /**
   * 本次收款金额（ticket §2.1 决策树 + 2026-05-20 partial-payment-online）
   * - 线下：
   *   - undefined → 全额（payable_amount）；线下走 confirmOffline 翻终态
   *   - 0 → 纯挂账 status='待支付'；不写 payments 流水
   *   - 0 < v < payable_amount → 部分支付 status='部分支付'；写 1 行首次支付
   *   - = payable_amount → 全额 status='待支付'（线下保持，由 confirmOffline 入账）；写 1 行首次支付
   * - 微信/支付宝：
   *   - undefined / 0 / = payable_amount → 全额 QR（status='待支付' 等 payNotify 回调）
   *   - 0 < v < payable_amount → 首付限额（写 sale_orders.first_payment_amount，QR 收限额，
   *     payNotify 入账后落 部分支付 + 清 first_payment_amount）
   * 校验：0 ≤ v ≤ payable_amount
   */
  receivedAmount?: number
  /** 储值卡抵扣金额（> 0 时额外写 1 行 change_type='储值卡抵扣' payments 流水） */
  prepaidCardAmount?: number
  /** 组合套餐主商品 ID；套餐子项必须全部归属该套餐。 */
  bundleProductId?: string
  items: Array<{
    skuId: string
    productName: string
    productType: '疗程卡' | '家居产品'
    sessionCount: number | null
    unitPrice: string
    unitRealPrice: string
    quantity: number
    /** 手动应付金额（可选，覆盖 unitRealPrice * quantity） */
    saleAmount?: string
    /** 手动实付金额（可选，覆盖 saleAmount） */
    received?: string
    salesCategory?: '自销自耗' | '他销自耗' | '他销他耗' | '生态合作' | null
    /**
     * 套餐子项标记（前端 BundlePicker 加购时置 true）：套餐价是独立机制，
     * 后端「会员价分流权威定价」对其豁免（维持现状，沿用前端套餐价）。
     * 普通商品/体验卡为 undefined/false，后端按会员价分流权威重定价。
     */
    isBundle?: boolean
  }>
    },
  ): Promise<{
    success: boolean
    message: string
    saleOrderId?: string
    /** 订单初始 status，前端 Step 4 据此分支文案：'部分支付' / '待支付' / '已支付' */
    status?: '待支付' | '部分支付' | '已支付'
  }> => {
  // 2026-04-26 sale-order-domain-refactor: saleOrderType 5→3 运行时硬校验
  // 静态联合类型已限定在 createOrder data 入参；此处再做一次 runtime 兜底防绕过
  // （旧前端/外部调用可能传入 '回款单'/'退款单'，统一拒绝）
  const ALLOWED_SALE_ORDER_TYPES = ['销售单', '内部单', '转换单'] as const
  if (!ALLOWED_SALE_ORDER_TYPES.includes(data.saleOrderType as typeof ALLOWED_SALE_ORDER_TYPES[number])) {
    return {
      success: false,
      message: `INVALID_PARAMS: SALE_ORDER_TYPE_INVALID: 不允许的 saleOrderType: ${data.saleOrderType}（'回款单' 走 recordPayment；'退款单' 走 createRefund）`,
    }
  }

  // J3 (B9 ticket follow-up): 一张订单仅支持 1 张优惠券；schema 已用 z.string() 拒绝 array，
  // 此处再做 runtime 兜底防外部调用绕过 schema 校验
  if (Array.isArray(data.couponId)) {
    return {
      success: false,
      message: 'INVALID_PARAMS: MULTIPLE_COUPON_NOT_SUPPORTED: 一张订单仅支持 1 张优惠券',
    }
  }

  if (!data.clientUserId) {
    return { success: false, message: '顾客未注册小程序或未绑定门店' }
  }

  // 校验 storeId 在用户 scope 内
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建订单' }
  }

  // 充值卡剥离 SKU 化（2026-05-20）：充值订单走独立 createRechargeOrder action，
  // 不再走 createSaleOrder。这里删除原"isRechargeOrder 识别 + 字段强制覆盖"块。

  // ── 会员价分流 + 后端权威定价（2026-06-24）─────────────────────────────
  // 后端为定价权威（与 staff cloudfunctions/staffApi/routes/order.js 同口径）：
  //   - 普通商品（非套餐、非店长特价）：忽略前端单价，按会员价分流取适用单价
  //     （会员→会员价 special_price、非会员→标价 price；体验卡 is_experience 同口径，#6=B 不再豁免）。
  //   - 店长特价（is_manager_special，仅普通商品）：允许前端向下改价，钳制到 [0, 适用单价]。
  //   - 套餐子项（item.isBundle，前端 BundlePicker 注入）：套餐价独立机制，维持现状不分流。
  //   - 内部单：标价 price × 50% 重算（后端权威，不受会员价/前端影响）；unit_price 原价快照不变。
  // service_fee（手工费）不受影响，仍按 SKU 快照。
  if (data.saleOrderType === '内部单' && data.couponId) {
    return { success: false, message: '内部单不允许叠加优惠券' }
  }

  const bundleValidationError = await validateBundleOrderForCustomer(
    data.bundleProductId,
    data.clientUserId,
    data.items,
  )
  if (bundleValidationError) {
    return { success: false, message: bundleValidationError }
  }

  // 取每个下单 SKU 的标价/会员价/体验卡/店长特价（权威 = DB，不信前端单价）
  const repriceSkuIds = data.items.map((i) => i.skuId).filter((s): s is string => !!s)
  type OrderSkuPricing = {
    skuId: string
    categoryId: string
    specName: string
    productType: '疗程卡' | '家居产品'
    sessionCount: number | null
    price: string
    specialPrice: string | null
    isExperience: boolean
    isManagerSpecial: boolean
    marketScope: string | null
    purchaseLimit: number | null
  }
  const skuPricingMap = new Map<string, OrderSkuPricing>()
  let purchaseLimitRows: SkuPurchaseLimitRow[] = []
  let pricingRows: NormalSkuMarketScopeRow[] = []
  if (repriceSkuIds.length > 0) {
    const loadedPricingRows = await db
      .select({
        skuId: productSkus.skuId,
        categoryId: productSkus.categoryId,
        specName: productSkus.specName,
        productType: productSkus.productType,
        sessionCount: productSkus.sessionCount,
        price: productSkus.price,
        specialPrice: productSkus.specialPrice,
        isExperience: productSkus.isExperience,
        isManagerSpecial: productSkus.isManagerSpecial,
        marketScope: productSkus.marketScope,
        purchaseLimit: productSkus.purchaseLimit,
      })
      .from(productSkus)
      .where(and(inArray(productSkus.skuId, repriceSkuIds), isNull(productSkus.deletedAt)))
    pricingRows = loadedPricingRows
    purchaseLimitRows = loadedPricingRows
    for (const r of loadedPricingRows) {
      skuPricingMap.set(r.skuId, {
        skuId: r.skuId,
        categoryId: r.categoryId,
        specName: r.specName,
        productType: r.productType,
        sessionCount: r.sessionCount,
        price: r.price,
        specialPrice: r.specialPrice,
        isExperience: r.isExperience === true,
        isManagerSpecial: r.isManagerSpecial === true,
        marketScope: r.marketScope,
        purchaseLimit: r.purchaseLimit,
      })
    }
  }

  if (!data.bundleProductId) {
    const marketScopeViolation = await findNormalSkuMarketScopeViolation(data.clientUserId, pricingRows)
    if (marketScopeViolation) {
      return { success: false, message: normalSkuMarketScopeMessage(marketScopeViolation) }
    }
  }

  const purchaseLimitViolation = findPurchaseLimitViolation(data.items, purchaseLimitRows)
  if (purchaseLimitViolation) {
    return { success: false, message: purchaseLimitExceededMessage(purchaseLimitViolation) }
  }

  // 内部单引用了已下架/不存在的 SKU：fail-closed 拒绝建单（与 staff order.js / client order.js「商品 X 不存在」同口径）。
  // ⚠️ 软删 SKU 行仍在 product_skus（deleted_at 置位，PK 行保留 → sale_items.sku_id FK 仍满足），下游 INSERT
  //    不会 23503 报错。内部单若放行：下方重定价 map 的 `if (!pricing) return item` 会短路在 ×50% 之前 →
  //    漏减半 → 落库 ≈2× 应付金额（资金 bug）。故内部单缺价必须拦截在重定价前。
  //    （销售单/转换单缺价仍走 `if (!pricing) return item` 兜底：前端透传价已按会员价分流算好，无翻倍风险。）
  if (data.saleOrderType === '内部单') {
    const missingInternalSkuId = repriceSkuIds.find((id) => !skuPricingMap.has(id))
    if (missingInternalSkuId) {
      return { success: false, message: `商品 ${missingInternalSkuId} 不存在或已下架，请刷新后重试` }
    }
  }

  // 会员判定：会员客 或 有钻石等级（member_level 非空），任一满足。
  // 顺带缓存 customerType 供下方 document_type 快照复用（省一次查询）。
  let buyerCustomerType: string | null = null
  let buyerIsMember = false
  if (data.clientUserId) {
    const [buyerRow] = await db
      .select({ customerType: clientWechatUsers.customerType, memberLevel: clientWechatUsers.memberLevel })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    buyerCustomerType = buyerRow?.customerType ?? null
    buyerIsMember = isMember(buyerRow?.customerType, buyerRow?.memberLevel)
  }

  // 逐项后端权威重定价：覆盖 data.items 的 unitPrice/unitRealPrice/saleAmount/received
  // （saleAmount = 成交单价 × 数量；received 钳制到 ≤ saleAmount）。
  data = {
    ...data,
    items: data.items.map((item) => {
      const pricing = skuPricingMap.get(item.skuId)
      // 缺价兜底：无 skuId 的项、或销售单/转换单引用了软删 SKU（前端透传价已按会员价分流算好）→ 原样放行。
      // 内部单缺价已在上方 fail-closed 拦截，不会走到这里（否则会漏 ×50% → 翻倍）。
      if (!pricing) return item
      const listUnit = Number(pricing.price) || 0
      const qty = item.quantity || 1
      const applicableUnit = resolveUnitPrice(
        { price: pricing.price, specialPrice: pricing.specialPrice, isExperience: pricing.isExperience },
        buyerIsMember,
      ).realUnit
      const clampReceived = (sale: number) =>
        item.received !== undefined ? Math.max(0, Math.min(Number(item.received), sale)).toFixed(2) : undefined

      // 内部单：标价 × 50%（后端权威，不分流；unit_price 原价快照保留标价）
      if (data.saleOrderType === '内部单') {
        const realUnit = Math.round(listUnit * 50) / 100
        const sale = Math.round(realUnit * qty * 100) / 100
        return {
          ...item,
          unitPrice: listUnit.toFixed(2),
          unitRealPrice: realUnit.toFixed(2),
          saleAmount: sale.toFixed(2),
          received: clampReceived(sale),
        }
      }

      // 套餐子项：套餐价独立机制，维持现状（沿用前端套餐价，不分流）
      if (item.isBundle === true) return item

      // 店长特价（仅普通商品）：允许前端向下改价，钳制 [0, 适用单价]
      if (pricing.isManagerSpecial) {
        const rawUnit = item.unitRealPrice != null && item.unitRealPrice !== ''
          ? Number(item.unitRealPrice)
          : (item.saleAmount != null && item.saleAmount !== '' ? Number(item.saleAmount) / qty : applicableUnit)
        const realUnit = Math.max(0, Math.min(Number.isFinite(rawUnit) ? rawUnit : applicableUnit, applicableUnit))
        const sale = Math.round(realUnit * qty * 100) / 100
        return {
          ...item,
          unitPrice: listUnit.toFixed(2),
          unitRealPrice: realUnit.toFixed(2),
          saleAmount: sale.toFixed(2),
          received: clampReceived(sale),
        }
      }

      // 普通商品：会员价分流后端权威，忽略前端单价（堵非会员套用会员价）
      const sale = Math.round(applicableUnit * qty * 100) / 100
      return {
        ...item,
        unitPrice: listUnit.toFixed(2),
        unitRealPrice: applicableUnit.toFixed(2),
        saleAmount: sale.toFixed(2),
        received: clampReceived(sale),
      }
    }),
  }

  // 疗程卡累计梯度价：必须在优惠券分摊和 quantity 拆行前完成。
  // 分组键与 staff 一致，使用服务端 SKU 的 category_id + spec_name，不信任前端 productName。
  const treatmentTierLines = data.items.map((item) => {
    const pricing = skuPricingMap.get(item.skuId)
    return {
      categoryId: pricing?.categoryId,
      specName: pricing?.specName,
      productType: pricing?.productType ?? item.productType,
      sessionCount: pricing?.sessionCount ?? item.sessionCount,
      quantity: item.quantity,
      isExperience: pricing?.isExperience,
      isManagerSpecial: pricing?.isManagerSpecial,
      isBundle: item.isBundle === true,
    }
  })
  const treatmentTierCategoryIds = Array.from(new Set(
    treatmentTierLines
      .filter((line) =>
        data.saleOrderType === '销售单'
        && line.productType === '疗程卡'
        && line.isExperience !== true
        && line.isManagerSpecial !== true
        && line.isBundle !== true
        && line.categoryId
        && line.specName
        && Number(line.sessionCount) > 0,
      )
      .map((line) => line.categoryId as string),
  ))
  if (treatmentTierCategoryIds.length > 0) {
    const tierCandidates = await db
      .select({
        categoryId: productSkus.categoryId,
        specName: productSkus.specName,
        productType: productSkus.productType,
        price: productSkus.price,
        specialPrice: productSkus.specialPrice,
        sessionCount: productSkus.sessionCount,
        isExperience: productSkus.isExperience,
        isManagerSpecial: productSkus.isManagerSpecial,
      })
      .from(productSkus)
      .where(and(
        inArray(productSkus.categoryId, treatmentTierCategoryIds),
        eq(productSkus.productType, '疗程卡'),
        eq(productSkus.isEnabled, true),
        eq(productSkus.isExperience, false),
        eq(productSkus.isManagerSpecial, false),
        isNull(productSkus.deletedAt),
      ))
    const tierAmounts = calculateTreatmentTierLineAmounts(
      treatmentTierLines,
      tierCandidates,
      buyerIsMember,
      data.saleOrderType,
    )
    data = {
      ...data,
      items: data.items.map((item, index) => {
        const amount = tierAmounts[index]
        if (amount == null) return item
        const quantity = Math.max(1, Number(item.quantity) || 1)
        const received = item.received != null
          ? Math.max(0, Math.min(Number(item.received), amount)).toFixed(2)
          : undefined
        return {
          ...item,
          unitRealPrice: (amount / quantity).toFixed(2),
          saleAmount: amount.toFixed(2),
          received,
        }
      }),
    }
  }

  // 校验手动金额
  for (const item of data.items) {
    if (item.saleAmount !== undefined) {
      const sa = Number(item.saleAmount)
      if (isNaN(sa) || sa < 0) return { success: false, message: '应付金额无效' }
    }
    if (item.received !== undefined) {
      const rc = Number(item.received)
      if (isNaN(rc) || rc < 0) return { success: false, message: '实付金额无效' }
      const sa = item.saleAmount ? Number(item.saleAmount) : Number(item.unitRealPrice) * item.quantity
      if (rc > sa + 0.005) return { success: false, message: '实付金额不能超过应付金额' }
    }
  }

  // ========== B2 拆行：疗程卡 quantity>1 → N 行 quantity=1 ==========
  // ticket: notes/tickets/archives/2026-05-18-single-session-card-quantity-not-split.md
  // 业务语义：每张卡（无论 sku.session_count 是 1 还是 N）都是独立可转换/核销的实体，
  // 应在 sale_items 写成 N 行（每行 quantity=1, session_count=sku.session_count）。
  // 家居产品（productType='家居产品'）继续合行（quantity 累加）。
  // 与 staff order.js 同步（见 cross-end-sql-snapshot 守护）。
  //
  // saleAmount 按 N 等分，最后一行吸收尾差（sum 守恒）。
  // received **改贪心填满**（2026-06-01 bundle-paid-sessions fix）：前几行先吃满 cap=perSaleAmount，
  // 最后一行收剩余。避免均分稀释导致 paid_sessions=0（净化美人付 800 应解锁 1 次而非 0 次）。
  // 与 staff order.js B2 拆行算法字节同义。
  data = {
    ...data,
    items: data.items.flatMap((item) => {
      if (item.productType !== '疗程卡' || item.quantity <= 1) {
        return [item]
      }
      const n = item.quantity
      const totalSale = item.saleAmount !== undefined
        ? Number(item.saleAmount)
        : Number(item.unitRealPrice) * n
      const totalReceived = item.received !== undefined
        ? Number(item.received)
        : totalSale
      const perSaleCents = Math.round((totalSale * 100) / n)
      const totalSaleCents = Math.round(totalSale * 100)
      let remainingReceivedCents = item.received !== undefined ? Math.round(totalReceived * 100) : null
      const rows: typeof item[] = []
      for (let i = 0; i < n; i++) {
        const isLast = i === n - 1
        const saleCents = isLast
          ? totalSaleCents - perSaleCents * (n - 1)
          : perSaleCents
        const saleStr = (saleCents / 100).toFixed(2)
        // received 贪心填满：本行最多吃 cap = saleCents，剩余进下一行
        let receivedStr: string | undefined = undefined
        if (remainingReceivedCents !== null) {
          const takenCents = Math.max(0, Math.min(remainingReceivedCents, saleCents))
          remainingReceivedCents -= takenCents
          receivedStr = (takenCents / 100).toFixed(2)
        }
        rows.push({
          ...item,
          quantity: 1,
          // unitRealPrice 重写为本行 per-card 单价（保持入参 unitRealPrice 不变；不再以 received 覆盖）
          unitRealPrice: item.unitRealPrice,
          // saleAmount / received 仅在原入参显式提供时保留分行覆盖；
          // 否则保留原入参的 undefined（让后续按 unitRealPrice × 1 计算）
          saleAmount: item.saleAmount !== undefined ? saleStr : undefined,
          received: receivedStr,
        })
      }
      return rows
    }),
  }

  // 计算商品总金额（应付，基于 saleAmount/unitRealPrice，不依赖 item.received）
  // 与 sale_items.sale_amount 落库口径一致（L1286-1287），跨端与 staff order.js L523 /
  // client order.js L405-416 对齐。item.received（部分支付实收）不参与 total_amount。
  // 浮点 round 兜底（行级 + 累加后），见 notes/tickets/2026-05-17-client-order-no-coupon-rounding.md §5.2
  const rawTotal = Math.round(data.items.reduce((sum, item) => {
    const computed = Number(item.unitRealPrice) * item.quantity
    const itemAmount = item.saleAmount ? Number(item.saleAmount) : computed
    return sum + Math.round(itemAmount * 100) / 100
  }, 0) * 100) / 100

  // 提前校验优惠券（事务外查询，避免在事务内做复杂查询）
  // ticket B9：minSpend / 折扣基数已切换到 eligibleTotal（scope 内应付合计），不再使用全单合计
  let couponDiscount = 0
  if (data.couponId && data.clientUserId) {
    // 查询 SKU 的 categoryId 和 productId，用于优惠券范围校验
    const orderSkuIds = data.items.map(i => i.skuId).filter(Boolean)
    const [skuCatRows, skuProdRows] = await Promise.all([
      db.select({ skuId: productSkus.skuId, categoryId: productSkus.categoryId })
        .from(productSkus).where(and(inArray(productSkus.skuId, orderSkuIds), isNull(productSkus.deletedAt))),
      db.select({ skuId: mallProductSkus.skuId, productId: mallProductSkus.productId })
        .from(mallProductSkus).where(inArray(mallProductSkus.skuId, orderSkuIds)),
    ])
    const skuCatMap = new Map(skuCatRows.map(r => [r.skuId, r.categoryId]))
    const skuProdMap = new Map(skuProdRows.map(r => [r.skuId, r.productId]))
    const [coupon] = await db
      .select({
        status: userCoupons.status,
        expireAt: userCoupons.expireAt,
        userId: userCoupons.userId,
        couponType: couponTemplates.couponType,
        discountValue: sql<number>`COALESCE(${userCoupons.faceValueOverride}, ${couponTemplates.discountValue})`,
        maxDiscount: couponTemplates.maxDiscount,
        minSpend: couponTemplates.minSpend,
        isActive: couponTemplates.isActive,
        applicableStoreIds: couponTemplates.applicableStoreIds,
        applicableCategoryIds: couponTemplates.applicableCategoryIds,
        applicableProductIds: couponTemplates.applicableProductIds,
        applicableMarketIds: couponTemplates.applicableMarketIds,
      })
      .from(userCoupons)
      .innerJoin(couponTemplates, eq(userCoupons.templateId, couponTemplates.templateId))
      .where(eq(userCoupons.couponId, data.couponId))
      .limit(1)

    if (!coupon) return { success: false, message: '优惠券不存在' }
    if (coupon.userId !== data.clientUserId) return { success: false, message: '优惠券不属于该顾客' }
    if (coupon.status !== '未使用') return { success: false, message: '优惠券已被使用或已失效' }
    if (coupon.expireAt < new Date()) return { success: false, message: '优惠券已过期' }
    if (!coupon.isActive) return { success: false, message: '该优惠券模板已停用' }

    // 范围校验：门店维度（NULL/空数组 = 不限制）
    if (coupon.applicableStoreIds && coupon.applicableStoreIds.length > 0) {
      if (!data.storeId || !coupon.applicableStoreIds.includes(data.storeId)) {
        return { success: false, message: '该优惠券不适用于当前门店' }
      }
    }

    // 范围校验：市场维度（NULL/空数组 = 不限制）
    if (coupon.applicableMarketIds && coupon.applicableMarketIds.length > 0) {
      const [storeRow] = await db
        .select({ parentId: orgNodes.parentId })
        .from(stores)
        .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
        .where(eq(stores.storeId, data.storeId))
        .limit(1)
      const marketId = storeRow?.parentId
      if (!marketId || !coupon.applicableMarketIds.includes(marketId)) {
        return { success: false, message: '该优惠券不适用于当前市场' }
      }
    }

    // 范围校验：品类 + 商品维度（NULL/空数组 = 不限制；同时设置时取交集）
    // 计算 eligibleItems：满足 category AND product 双重限制
    // 与 client/staff order.create 对齐（fengyu-client/cloudfunctions/clientApi/routes/order.js L329-355
    // 和 fengyu-staff/cloudfunctions/staffApi/routes/order.js L390-410）
    const hasCatRestriction = !!(coupon.applicableCategoryIds && coupon.applicableCategoryIds.length > 0)
    const hasProdRestriction = !!(coupon.applicableProductIds && coupon.applicableProductIds.length > 0)
    let eligibleItems = data.items
    if (hasCatRestriction || hasProdRestriction) {
      eligibleItems = data.items.filter((item) => {
        const catMatch = !hasCatRestriction
          || coupon.applicableCategoryIds!.includes(skuCatMap.get(item.skuId) as string)
        const prodMatch = !hasProdRestriction
          || coupon.applicableProductIds!.includes(skuProdMap.get(item.skuId) as string)
        return catMatch && prodMatch
      })
      if (eligibleItems.length === 0) {
        const msg = hasCatRestriction && hasProdRestriction
          ? '订单商品不满足优惠券的品类与商品限制'
          : hasProdRestriction
            ? '订单商品不满足优惠券的商品限制'
            : '订单商品不满足优惠券的品类限制'
        return { success: false, message: msg }
      }
    }

    // 满减门槛 / 折扣基数：必须基于 eligibleItems（scope 内）应付金额合计，而非全单
    // ticket B9：admin 此前用 saleAmountTotal 作为基数，与 client/staff 行为不一致；
    // 见 notes/tickets/2026-05-18-coupon-binding-restriction-not-enforced.md
    const eligibleTotalRaw = eligibleItems.reduce((sum, item) => {
      const itemSale = item.saleAmount ? Number(item.saleAmount) : Number(item.unitRealPrice) * item.quantity
      return sum + Math.round(itemSale * 100) / 100
    }, 0)
    const eligibleTotal = Math.round(eligibleTotalRaw * 100) / 100

    const minSpend = parseFloat(coupon.minSpend ?? '0')
    // +0.001 兜底 JS 浮点累计误差，与 client/staff coupon.available 保持一致
    if (eligibleTotal + 0.001 < minSpend) {
      return { success: false, message: `订单金额未满足优惠券最低消费 ¥${minSpend.toFixed(2)}` }
    }
    couponDiscount = calcCouponDiscount(coupon.couponType, String(coupon.discountValue), coupon.maxDiscount ?? null, eligibleTotal)
    couponDiscount = Math.round(couponDiscount * 100) / 100

    // 把订单级券折扣按 saleAmount 比例摊到 eligibleItems 各行（与 client/staff 对齐）
    // 后端为权威源；前端提交体仍传 pre-coupon saleAmount，后端首次摊到行（不会双扣）
    // 覆盖入参 item.saleAmount / item.received 使 L1480-1521 INSERT 落库为 post-coupon
    if (couponDiscount > 0 && eligibleItems.length > 0) {
      // 浅克隆 data.items 避免污染调用方传入对象（与 L1100 内部单 / L1135 B2 拆行模式一致）
      // 否则 baseOrderData 等共享 fixture 被改后跨用例污染
      const eligibleIdx = eligibleItems.map((it) => data.items.indexOf(it))
      data = { ...data, items: data.items.map((it) => ({ ...it })) }
      eligibleItems = eligibleIdx.map((i) => data.items[i])

      let distributed = 0
      for (let i = 0; i < eligibleItems.length; i++) {
        const it = eligibleItems[i]
        const itSaleRaw = it.saleAmount ? Number(it.saleAmount) : Number(it.unitRealPrice) * it.quantity
        const itSale = Math.round(itSaleRaw * 100) / 100
        let share: number
        if (i === eligibleItems.length - 1) {
          share = Math.round((couponDiscount - distributed) * 100) / 100
        } else {
          share = Math.round(couponDiscount * (itSale / eligibleTotal) * 100) / 100
          distributed += share
        }
        const newSale = Math.max(0, Math.round((itSale - share) * 100) / 100)
        it.saleAmount = newSale.toFixed(2)
        const inputReceived = it.received != null ? Number(it.received) : null
        const finalReceived = inputReceived != null ? Math.min(inputReceived, newSale) : newSale
        it.received = finalReceived.toFixed(2)
      }
    }
  }

  const totalAmount = Math.round(Math.max(0, rawTotal - couponDiscount) * 100) / 100

  // ── 款项流水 / 部分支付基础（ticket 2026-04-24 PR-3） ─────────────
  // 充值卡从本次逐行实付中抵扣。欠款场景下，不能把未来待收部分提前拿来抵扣；
  // 无欠款时 sumItemReceived === totalAmount，口径等价于订单应付总额。
  const sumItemReceived = Math.round(data.items.reduce((sum, item) => {
    const saleAmount = item.saleAmount !== undefined
      ? Number(item.saleAmount)
      : Number(item.unitRealPrice) * item.quantity
    const received = item.received !== undefined ? Number(item.received) : saleAmount
    return sum + received
  }, 0) * 100) / 100
  const requestedPrepaidCardAmount = Number(data.prepaidCardAmount ?? 0)
  if (!Number.isFinite(requestedPrepaidCardAmount) || requestedPrepaidCardAmount < 0) {
    return { success: false, message: '充值卡抵扣金额必须为非负数' }
  }
  const prepaidCardAmount = Math.round(requestedPrepaidCardAmount * 100) / 100
  const maxPrepayable = Math.min(totalAmount, sumItemReceived)
  if (prepaidCardAmount > maxPrepayable + 0.005) {
    return { success: false, message: '充值卡抵扣金额超过应抵上限' }
  }
  // payable_amount = total_amount - 实际储值卡实付 - 待扣储值卡（待支付阶段保留现金应付）
  const payableAmount = Math.max(0, Math.round((totalAmount - prepaidCardAmount) * 100) / 100)

  // 本次收款校验：
  // - 线下：开单时一律不记款，effectiveReceived 恒为 0，**忽略入参 receivedAmount**
  //   （实际款项在「确认收款」时才写流水 + 扣储值卡）。这样既统一了"先付款后转态"不变量，
  //   也避免前端传未扣卡的应付合计在有储值卡抵扣时误触 receivedAmount > payable 的超额报错。
  // - 微信/支付宝：传 0 < v < payable → 线上首付（写 first_payment_amount，QR 收限额）；
  //   v = payable 或 undefined → 全额 QR（保持既有行为）；v = 0 显式表示挂账等扫码（与 undefined 等价处理）。
  const isOnlinePay = data.paymentMethod === '微信' || data.paymentMethod === '支付宝'
  const receivedAmount = isOnlinePay
    ? (data.receivedAmount !== undefined ? Math.round(Number(data.receivedAmount) * 100) / 100 : 0)
    : 0
  if (!Number.isFinite(receivedAmount) || receivedAmount < 0) {
    return { success: false, message: '本次收款金额无效' }
  }
  if (receivedAmount > payableAmount + 0.005) {
    return { success: false, message: '本次收款金额不能超过应付实金' }
  }

  // 线上 + receivedAmount < payable → 把"首付限额"写入 sale_orders.first_payment_amount
  // （线下场景该列保持 NULL）。
  const firstPaymentAmount: number | null =
    isOnlinePay && receivedAmount > 0 && receivedAmount + 0.005 < payableAmount
      ? Math.min(receivedAmount, payableAmount)
      : null

  // 全额储值卡抵扣（payable==0 且 prepaid>0）：无现金可收，挂"待支付"会卡死
  //   （payment_method='无' 走不了 confirmOfflinePayment），故创建事务内直接扣卡 + 结清。
  //   用户 2026-05-21 拍板：销售单/转换单全额抵扣均在提交订单时即时抵扣。
  const isFullCardCoverage = prepaidCardAmount > 0 && payableAmount === 0

  // 决策树（三端对齐"先付款、后转态记账"不变量）：
  //   - 全额储值卡抵扣：'已支付'（事务内即时扣卡 + 结算）
  //   - 微信/支付宝：'待支付'（等 payNotify 回调入账，无论首付与否）
  //   - 线下：'待支付'（开单不记款；现金 + 部分储值卡抵扣都在「确认收款」confirmOfflinePayment 入账翻态）
  // createOrder 仅全额抵扣场景产出 '已支付'，其余款项流水/状态机由确认收款 / 录入回款 / payNotify 驱动。
  const initialStatus: typeof saleOrders.$inferInsert['status'] = isFullCardCoverage ? '已支付' : '待支付'

  // 全额抵扣时 payment_method 落 '无'（现金通道无需使用，与 staff order.create 对齐）。
  const effectivePaymentMethod = isFullCardCoverage ? '无' : data.paymentMethod

  // received 创建时：全额抵扣 = prepaid（已结清）；其余一律 0（线上等 payNotify，线下等 confirmOfflinePayment）。
  // （2026-04-26 sale-order-domain-refactor：paid_amount 列已 DROP，统一用 received）
  const paidAmountSnapshot = isFullCardCoverage ? prepaidCardAmount : 0

  // 计算 document_type（售前/售后快照）：仅按下单时会员身份判——售前=非会员客，售后=会员客。
  // 复用上方会员价分流已查得的 buyerCustomerType（省一次 client_wechat_users 查询）。
  // 「成为会员那一单」下单时仍非会员客 → 售前；跃迁发生在支付后 recalcCustomerType，不影响本快照。
  const documentType: '售前' | '售后' = buyerCustomerType === '会员客' ? '售后' : '售前'

  // 事务外批量查询本次涉及 sku 的 service_fee（固定手工费）、session_count（疗程卡次数）
  // 与 is_experience（capability 权威源）。
  // 用于 sale_items 快照：service_fee 供服务完成时参与提成计算，
  // session_count 对组合套餐路径做兜底（bundleSkuToProductSku 硬编码 null，前端传来不可信），
  // is_experience 拷贝用于客户分类跃迁（per-order SUM FILTER WHERE is_experience）。
  // 充值卡剥离 SKU 化（2026-05-20）后无需 is_recharge_card 字段。
  const skuIdList = data.items.map(i => i.skuId).filter((s): s is string => !!s)
  const skuFeeMap = new Map<string, string>()
  const skuSessionMap = new Map<string, number | null>()
  const skuExperienceMap = new Map<string, boolean>()
  // 店长特别优惠行级快照源（is_manager_special 权威 = DB，不信前端）
  const skuManagerSpecialMap = new Map<string, boolean>()
  // 生美 / 销售分类行级快照源（权威 = DB，不信前端）：
  //   is_shengmei  ← product_skus.is_shengmei（护理项目 true/false，其他品类 null）
  //   sales_category ← product_categories.sales_category（按 sku 的 category）
  // 服务核销后 admin/staff「服务提成分配」页读 sale_items.sales_category 匹配提成矩阵 + 渲染徽章，
  // 早期 admin 开单只取前端 payload（硬编码 null）→ 卡核销后徽章缺失 + 提成 0%，故此处后端反查兜实。
  const skuShengmeiMap = new Map<string, boolean | null>()
  const skuSalesCategoryMap = new Map<string, (typeof saleItems.$inferInsert)['salesCategory']>()
  if (skuIdList.length > 0) {
    const skuRows = await db
      .select({
        skuId: productSkus.skuId,
        serviceFee: productSkus.serviceFee,
        sessionCount: productSkus.sessionCount,
        isExperience: productSkus.isExperience,
        isManagerSpecial: productSkus.isManagerSpecial,
        isShengmei: productSkus.isShengmei,
        salesCategory: productCategories.salesCategory,
      })
      .from(productSkus)
      .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(and(inArray(productSkus.skuId, skuIdList), isNull(productSkus.deletedAt)))
    for (const r of skuRows) {
      skuFeeMap.set(r.skuId, r.serviceFee)
      skuSessionMap.set(r.skuId, r.sessionCount)
      skuExperienceMap.set(r.skuId, r.isExperience === true)
      skuManagerSpecialMap.set(r.skuId, r.isManagerSpecial === true)
      skuShengmeiMap.set(r.skuId, r.isShengmei)
      skuSalesCategoryMap.set(r.skuId, r.salesCategory)
    }
  }

  // 充值卡剥离 SKU 化（2026-05-20）后 D4 混单守卫已删除（充值订单走独立 createRechargeOrder 入口）。

  // 2026-07-08 修复 T1：顾客档案权威（clientWechatUsers.phone/name）覆盖入参。
  // 与 staffApi order.create 对齐：sale_orders.customer_name/client_phone 是 denormalized 快照，
  // 此处保持单一权威源 = 客户档案，防前端 order-create-page.tsx:1468 的 `name || phone` fallback
  // 把手机号写入 customer_name。
  let authoritativePhone = data.clientPhone
  let authoritativeName = data.customerName
  {
    const [authCust] = await db
      .select({ phone: clientWechatUsers.phone, name: clientWechatUsers.name })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (authCust?.phone) authoritativePhone = authCust.phone
    if (authCust?.name) authoritativeName = authCust.name
  }

  // 事务：ID 生成 + 优惠券核销 + 订单 + 明细，原子提交或全部回滚
  let saleOrderId: string
  try {
    saleOrderId = await db.transaction(async (tx) => {
      // advisory lock 在事务内持有，直到 commit 才释放
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen')::bigint)
        )
        SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
            ), 0) + 1
            FROM sale_orders
            WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 4, '0'
          ) AS id
        FROM lock
      `)
      const id = (idRows as any[])[0]?.id as string
      if (!id) throw new ApiError('INVALID_STATE', '订单号生成失败')

      // 顾客维度全量待支付单互斥：业务守卫查所有待支付单（含自助单），本事务 order-gen
      // advisory lock 串行化开单使其原子；DB uq 仅兜底 opened_by IS NULL 自助单
      if (initialStatus === '待支付' && data.clientUserId) {
        const existing = await tx
          .select({ saleOrderId: saleOrders.saleOrderId })
          .from(saleOrders)
          .where(
            and(
              eq(saleOrders.clientUserId, data.clientUserId),
              eq(saleOrders.status, '待支付')
            )
          )
          .limit(1)
        if (existing.length > 0) {
          throw new ApiError('CONFLICT', `该顾客已有待支付订单 ${existing[0].saleOrderId}，请先关闭后再创建新订单`)
        }
      }

      // 部分抵扣只是预选，尚未扣减余额；仍须在同一事务内校验当前余额，
      // 以防绕过前端上限。全额抵扣由下方 deductPrepaidCardAtCreation
      // 使用 FOR UPDATE 再做一次原子校验并实际扣款。
      if (prepaidCardAmount > 0 && !isFullCardCoverage) {
        const balanceRows = await tx.execute(sql`
          SELECT card_id, balance FROM prepaid_cards
          WHERE user_id = ${data.clientUserId}
        `)
        const currentBalance = Number((balanceRows as unknown as Array<{ balance?: string | number }>)[0]?.balance)
        if (!Number.isFinite(currentBalance) || currentBalance + 0.001 < prepaidCardAmount) {
          throw new ApiError('INSUFFICIENT_BALANCE', '充值卡余额不足')
        }
      }

      await tx.insert(saleOrders).values({
        saleOrderId: id,
        status: initialStatus,
        saleOrderType: data.saleOrderType,
        documentType,
        marketName: data.marketName,
        storeId: data.storeId,
        storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
        saleOrderDatetime: nowTs(),
        clientUserId: data.clientUserId,
        clientPhone: authoritativePhone,
        customerName: authoritativeName,
        totalAmount: totalAmount.toFixed(2),
        prepaidCardAmount: (isFullCardCoverage ? prepaidCardAmount : 0).toFixed(2),
        pendingPrepaidCardAmount: (isFullCardCoverage ? 0 : prepaidCardAmount).toFixed(2),
        payableAmount: payableAmount.toFixed(2),
        received: paidAmountSnapshot.toFixed(2),
        firstPaymentAmount: firstPaymentAmount != null ? firstPaymentAmount.toFixed(2) : null,
        couponId: data.couponId ?? null,
        couponDiscount: couponDiscount > 0 ? couponDiscount.toFixed(2) : '0',
        paymentMethod: effectivePaymentMethod,
        openedBy: data.openedBy || session.employeeId,
        preferredEmployeeId: data.preferredEmployeeId || null,
        allocationStatus: '待分配',
        remark: data.remark || null,
        isActivity: data.isActivity ?? false,
        paidAt: isFullCardCoverage ? nowTs() : null,
      })

      // 开单时不写款项流水（统一"先付款、后记账"不变量）：
      //   - 线上（微信/支付宝）：由 payNotify 回调写入并翻态
      //   - 线下：由 confirmOfflinePayment「确认收款」写入现金/储值卡抵扣流水并翻态
      //   - 部分抵扣预选写 pending_prepaid_card_amount，确认收款时才扣卡并转入实付口径

      // 原子核销优惠券：WHERE coupon_id = X AND status = '未使用' 防止重用
      // 必须在 insert sale_orders 之后，因为 used_sale_order_id 有外键约束
      if (data.couponId) {
        const voidResult = await tx
          .update(userCoupons)
          .set({ status: '已使用', usedSaleOrderId: id, usedAt: nowTs() })
          .where(and(eq(userCoupons.couponId, data.couponId), eq(userCoupons.status, '未使用')))

        if ((voidResult as any).count === 0) {
          throw new ApiError('CONFLICT', '优惠券已被使用，请刷新后重试')
        }
      }

      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i]
        const saleItemId = `${id}-${String(i + 1).padStart(2, '0')}`
        const computedSaleAmount = (Number(item.unitRealPrice) * item.quantity).toFixed(2)
        const saleAmount = item.saleAmount ?? computedSaleAmount
        // 实付草稿（开单填的逐行实付）落 pending_received，**不进** received（资金铁律：
        // received/paid_sessions 只认 status='已支付' 流水）。行级 received 开单一律写 0，
        // 由下方 recalcPaidSessionsForOrder STEP1 从订单级 sale_orders.received 派生填充
        // （待支付=0；全额储值卡抵扣=prepaid 分摊）。修复"待支付可消费疗程卡" P0。
        const pendingReceived = item.received ?? saleAmount
        const received = '0.00'

        // 固定手工费快照 = product_skus.service_fee × quantity
        const skuServiceFee = Number(skuFeeMap.get(item.skuId) || 0)
        const serviceFee = (skuServiceFee * item.quantity).toFixed(2)

        // sessionCount 以服务端 productSkus.session_count 为权威（对组合套餐疗程卡兜底）。
        // sale_items.session_count / remaining_sessions 是"行总次数"维度
        // （service.complete 按次扣减 remaining_sessions），应 = sku.session_count × quantity；
        // 漏乘 quantity 会导致剩余次数显示 1/1 而非 N/N，且核销超过 1 次即被扣减守护卡住。
        const skuSessionCount = skuSessionMap.get(item.skuId) ?? item.sessionCount
        const sessionCount = skuSessionCount != null ? skuSessionCount * item.quantity : null

        // per-session 派生：unit_real_price/unit_price 存单次价（sale_amount 为权威行总额）；
        //   卡 = 行总额 / 总次数；非卡 = 行总额 / 数量（per-unit 退化）。入参 unitPrice/unitRealPrice 是 per-card 表单值。
        const psDenom = (sessionCount != null && sessionCount > 0) ? sessionCount : item.quantity
        const listTotalRow = Number(item.unitPrice) * item.quantity
        const unitRealPrice = psDenom > 0 ? (Number(saleAmount) / psDenom).toFixed(2) : Number(saleAmount).toFixed(2)
        const unitPrice = psDenom > 0 ? (listTotalRow / psDenom).toFixed(2) : Number(item.unitPrice).toFixed(2)

        // is_experience 行级快照：以服务端 product_skus.is_experience 为权威。
        // 用于客户分类跃迁 SQL（SUM(received) FILTER WHERE si.is_experience）。
        const isExperience = skuExperienceMap.get(item.skuId) ?? false

        // 店长特别优惠行级快照：以服务端 product_skus.is_manager_special 为权威
        const isManagerSpecial = skuManagerSpecialMap.get(item.skuId) ?? false

        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId: id,
          storeId: data.storeId,
          itemDirection: '购买',
          skuId: item.skuId,
          productName: item.productName,
          productType: item.productType,
          sessionCount,
          remainingSessions: sessionCount,
          unitPrice,
          quantity: item.quantity,
          unitRealPrice,
          saleAmount,
          received,
          pendingReceived,
          // 后端反查为权威：sales_category ← product_categories（前端硬编码 null，仅兜底）；
          // is_shengmei ← product_skus.is_shengmei（含 true/false/null 原值）
          salesCategory: skuSalesCategoryMap.get(item.skuId) ?? item.salesCategory ?? null,
          isShengmei: skuShengmeiMap.get(item.skuId) ?? null,
          serviceFee,
          isExperience,
          isManagerSpecial,
        })
      }

      // 充值卡剥离 SKU 化（2026-05-20）后 D4 事后兜底校验已删除（migration 0043 拆触发器）

      // 全额储值卡抵扣：事务内即时扣卡 + 写 '储值卡抵扣' 流水（与 confirmOfflinePayment 已支付分支对齐）
      let fullCardPaymentId: number | string | null = null
      if (isFullCardCoverage && data.clientUserId) {
        fullCardPaymentId = await deductPrepaidCardAtCreation(tx, {
          saleOrderId: id,
          clientUserId: data.clientUserId,
          amount: prepaidCardAmount,
          employeeId: session.employeeId,
          note: '管理后台开单-储值卡全额抵扣',
        })
      }

      // 按回款逐笔分配：全额储值卡抵扣即结清 → 捕获本次抵扣逐项可分配额 + 置待分配 + 汇总刷新（非定向）
      // 必须在 recalcPaidSessionsForOrder 之前：新 STEP1 从 receipt 聚合 received。
      if (fullCardPaymentId && prepaidCardAmount > 0) {
        await capturePaymentAllocatables(tx, {
          salePaymentId: fullCardPaymentId,
          saleOrderId: id,
          eventAmount: prepaidCardAmount,
          directedItems: null,
        })
        await refreshOrderAllocationRollup(tx, id)
      }

      // paid_sessions 统一由 recalcPaidSessionsForOrder 派生（STEP1 从 receipt 聚合 received → STEP2 floor）：
      // - 全额储值卡抵扣：received=prepaid_card_amount → paid_sessions=session_count（创建即结清）
      // - 待支付（线下/线上，received=0）：行级 received=0 → paid_sessions=0（杜绝未付款消费）
      // 不再按行级实付草稿直算 paid_sessions（旧 else 分支是"待支付可消费疗程卡" P0 资金漏洞根因：
      // 行级实付草稿现落 sale_items.pending_received，确认收款/payNotify 入账后才驱动 received→paid_sessions）。
      await recalcPaidSessionsForOrder(tx, id)

      // 全额抵扣即结清：触发积分发放 + 客户分类跃迁（与 confirmOfflinePayment 已支付分支一致）。
      if (isFullCardCoverage) {
        await settlePointsSafe(tx, id, 'admin.createOrder')
        if (data.clientUserId) {
          await recalcCustomerType(tx, data.clientUserId)
        }
      }

      return id
    })
  } catch (err: any) {
    // 业务异常（ApiError）：剥离一级前缀后直接透出真实消息。
    // 覆盖 CONFLICT(已有待支付订单 / 优惠券已被使用)、INVALID_STATE(订单号生成失败)、
    // INSUFFICIENT_BALANCE(全额抵扣余额不足) 等。
    // 修复 f4248169 把这些 throw 迁移到 ApiError（带 "<PREFIX>: " 前缀）后，
    // 旧的 err.message === / startsWith('<中文>') 匹配器全部失配，被吞成通用「创建订单失败」的回归。
    if (err instanceof ApiError) {
      const parsed = parseErrorPrefix(err.message)
      return { success: false, message: parsed?.displayMessage ?? err.message }
    }
    // 全额储值卡抵扣扣卡失败：deductPrepaidCardAtCreation 抛 plain Error（非 ApiError），
    // 消息形如 'INSUFFICIENT_BALANCE:NO_CARD: ...' / 'INSUFFICIENT_BALANCE:<余额>: ...'，
    // 需用专用正则连子标签一起剥掉（parseErrorPrefix 会残留 NO_CARD/数字子标签）。
    if (typeof err?.message === 'string' && err.message.startsWith('INSUFFICIENT_BALANCE')) {
      const stripped = err.message.replace(/^INSUFFICIENT_BALANCE:?(NO_CARD)?:?\s*/, '')
      return { success: false, message: stripped || '顾客储值卡余额不足' }
    }
    // PG 外键违反（storeId / skuId / clientUserId 不存在）
    if (pgErrorCode(err) === '23503') {
      return { success: false, message: '关联数据不存在，请检查门店、商品或顾客信息' }
    }
    // PG NOT NULL 违反（字段缺失）
    if (pgErrorCode(err) === '23502') {
      console.error('[createOrder] not_null_violation:', err)
      return { success: false, message: '订单字段缺失，请联系管理员' }
    }
    // PG 唯一约束冲突（advisory lock 下极罕见）
    if (pgErrorCode(err) === '23505') {
      return { success: false, message: '订单号冲突，请稍后重试' }
    }
    console.error('[createOrder] unexpected error:', err)
    return { success: false, message: '创建订单失败，请稍后重试' }
  }

  await logOperation(session, 'order.create', 'sale_order', saleOrderId, {
    storeId: data.storeId, totalAmount: totalAmount.toFixed(2), itemCount: data.items.length,
    couponId: data.couponId ?? null, couponDiscount: couponDiscount > 0 ? couponDiscount.toFixed(2) : null,
  })

  revalidatePath('/orders')
  return {
    success: true,
    message: '订单创建成功',
    saleOrderId,
    status: initialStatus as '待支付' | '部分支付' | '已支付',
  }
  },
)

/**
 * 转换单 — 顾客持卡折抵换购
 *
 * 业务流程：
 * 1. 锁住 convertOutSaleItemIds 对应 sale_items 行（FOR UPDATE），校验 store_id / item_direction / 状态
 * 2. 计算转出折抵金额 totalOut = sum(unit_real_price × remaining_sessions)
 *    - 仅疗程卡可折抵（含原"体验卡单品"=1 次卡）；放开后不再要求 is_experience
 * 3. 计算转入应付金额 totalIn = sum(适用价 × quantity)，店长特价 SKU 可向下改应付
 * 4. priceDiff = totalIn - totalOut
 *    - priceDiff > 0：补现（paymentMethod），sale_orders.total_amount = priceDiff，status='待支付'
 *    - priceDiff = 0：不收款，status='已支付'
 *    - priceDiff < 0：差额 UPSERT 到 prepaid_cards，INSERT card_transactions('充值')
 * 5. 原子标记转出行已耗尽：疗程卡 remaining_sessions=0
 * 6. INSERT 转出行（sale_amount/received 为负折抵，item_direction='转出'，ref_sale_item_id）
 * 7. INSERT 转入行（item_direction='转入'，sale_amount/received=转入金额）
 */
export const createConversionOrder = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
  storeId: string
  marketName: string
  /** 转换单必须实名顾客（要挂储值卡），不允许 manualPhone */
  clientUserId: string
  paymentMethod: '微信' | '支付宝' | '线下'
  preferredEmployeeId?: string
  remark?: string | null
  /** 转出：整张卡（不带数量，全部折抵） */
  convertOutSaleItemIds: string[]
  /** 转入项目（来自 Step 2 的购物车） */
  convertInItems: Array<{
    skuId: string
    productName: string
    productType: '疗程卡' | '家居产品'
    sessionCount: number | null
    unitPrice: string
    unitRealPrice?: string
    /** 店长特价行手填应付金额（转换单同销售单，后端按 DB is_manager_special 采纳） */
    saleAmount?: string
    quantity: number
    salesCategory?: '自销自耗' | '他销自耗' | '他销他耗' | '生态合作' | null
  }>
  /** 充值卡抵扣金额（仅正补差额 priceDiff > 0 时有效） */
  prepaidCardAmount?: number
  /** 转换单仅在券前为正补差额时可用的一张顾客优惠券 */
  couponId?: string | null
  /** 体验转换：转入总价由系统强制调整为旧卡划卡价值 */
  isExperienceConversion?: boolean
  /** 普通转换本次计划收款；省略表示全额 */
  receivedAmount?: number
    },
  ): Promise<{
  success: boolean
  message: string
  saleOrderId?: string
  totalIn?: number
  totalOut?: number
  priceDiff?: number
  prepaidCardCredit?: number
  /** 本单实际充值卡抵扣额 */
  prepaidCardAmount?: number
  /** 本单实际优惠券抵扣额（已按补差额封顶） */
  couponDiscount?: number
  isExperienceConversion?: boolean
  receivedAmount?: number
  remainingAmount?: number
  status?: '待支付' | '已支付'
  }> => {
  if (!isInScope(session, data.storeId)) {
    return { success: false, message: '无权在该门店创建订单' }
  }
  if (!data.clientUserId) {
    return { success: false, message: '转换单必须指定顾客' }
  }
  if (!data.convertOutSaleItemIds?.length) {
    return { success: false, message: '请选择至少一张折抵卡' }
  }
  if (!data.convertInItems?.length) {
    return { success: false, message: '请选择至少一个转入项目' }
  }
  if (Array.isArray(data.couponId)) {
    return { success: false, message: 'INVALID_PARAMS: MULTIPLE_COUPON_NOT_SUPPORTED: 一张订单仅支持一张优惠券' }
  }
  const isExperienceConversion = data.isExperienceConversion === true
  const experienceRequestedCard = Number(data.prepaidCardAmount || 0)
  const experienceRequestedReceived = Number(data.receivedAmount || 0)
  if (isExperienceConversion
      && (data.couponId
        || !Number.isFinite(experienceRequestedCard)
        || !Number.isFinite(experienceRequestedReceived)
        || experienceRequestedCard !== 0
        || experienceRequestedReceived !== 0)) {
    return { success: false, message: '体验转换不允许优惠券、储值卡抵扣或收款' }
  }

  // 查顾客基本信息（姓名快照 + phone 快照）
  const [client] = await db
    .select({
      userId: clientWechatUsers.userId,
      phone: clientWechatUsers.phone,
      name: clientWechatUsers.name,
      customerType: clientWechatUsers.customerType,
      memberLevel: clientWechatUsers.memberLevel,
    })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, data.clientUserId))
    .limit(1)
  if (!client) {
    return { success: false, message: '顾客不存在' }
  }

  // 事务：锁转出行 + 校验 + 计算金额 + 插入订单 + 插入两段 items + 储值卡补差
  let result: {
    saleOrderId: string
    totalIn: number
    totalOut: number
    priceDiff: number
    prepaidCardCredit: number
    prepaidCardAmount: number
    couponDiscount: number
    firstPaymentAmount: number | null
    initialPaymentAmount: number
    payable: number
    isExperienceConversion: boolean
    orderStatus: '待支付' | '已支付'
  }

  try {
    result = await db.transaction(async (tx) => {
      // 1. 先锁住转出候选行；service.start 使用同一把 sale_items 行锁写预扣。
      const heldRows = await tx.execute(sql`
        SELECT
          si.sale_item_id,
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
          COALESCE(si.is_shengmei, psk.is_shengmei) AS is_shengmei,
          si.service_fee,
          si.is_experience,
          so.client_user_id,
          so.sale_order_type,
          so.status AS order_status,
          pc.product_kind
        FROM sale_items si
        INNER JOIN sale_orders so ON si.sale_order_id = so.sale_order_id
        LEFT JOIN product_skus psk ON psk.sku_id = si.sku_id
        LEFT JOIN product_categories pc ON pc.category_id = psk.category_id
        WHERE si.sale_item_id IN (${sql.join(
          data.convertOutSaleItemIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        ORDER BY si.sale_item_id
        FOR UPDATE OF si
      `)

      const held = Array.from(heldRows as unknown as Iterable<Record<string, unknown>>)
      if (held.length !== data.convertOutSaleItemIds.length) {
        throw new ApiError('NOT_FOUND', 'CARD_NOT_FOUND: 部分卡不存在或已失效')
      }

      // sale_items 行锁已持有后再统计预扣，避免 service.start 在锁定与汇总之间新增预扣。
      const reservedRows = await tx.execute(sql`
        SELECT
          sit.sale_item_id,
          COALESCE(SUM(sit.session_used) FILTER (
            WHERE sit.reserved_at IS NOT NULL
              AND reserved_order.status IN ('服务中', '待客户确认')
          ), 0) AS total_reserved
        FROM service_items sit
        INNER JOIN service_orders reserved_order
          ON reserved_order.service_order_id = sit.service_order_id
        WHERE sit.sale_item_id IN (${sql.join(
          data.convertOutSaleItemIds.map((id) => sql`${id}`),
          sql`, `,
        )})
        GROUP BY sit.sale_item_id
      `)
      const reservedBySaleItemId = new Map<string, number>()
      for (const row of Array.from(reservedRows as unknown as Iterable<Record<string, unknown>>)) {
        reservedBySaleItemId.set(row.sale_item_id as string, Number(row.total_reserved ?? 0))
      }

      let totalOut = 0
      type OutItem = {
        refSaleItemId: string
        skuId: string | null
        productName: string | null
        productType: '疗程卡' | '家居产品' | null
        sessionCount: number | null
        unitPrice: string
        unitRealPrice: string
        quantity: number
        amount: number
        salesCategory: string | null
        serviceFee: number
        isExperience: boolean
        isShengmei: boolean | null
      }
      const outItems: OutItem[] = []

      for (const row of held) {
        // 归属校验：store_id / client_user_id / direction / 状态
        if (row.store_id !== data.storeId) throw new ApiError('INVALID_STATE', 'CARD_STORE_MISMATCH: 所选卡不属于当前门店')
        if (row.client_user_id !== data.clientUserId) throw new ApiError('INVALID_STATE', 'CARD_OWNER_MISMATCH: 所选卡不属于该顾客')
        const isEntitlement = row.item_direction === '购买'
          || (row.sale_order_type === '转换单' && row.item_direction === '转入')
        if (!isEntitlement) throw new ApiError('INVALID_STATE', 'CARD_DIRECTION_INVALID: 所选行不是有效疗程权益，不可折抵')
        if (row.order_status !== '已支付' && row.order_status !== '已完成') {
          throw new ApiError('INVALID_STATE', 'CARD_ORDER_STATUS_INVALID: 原订单状态不允许转换')
        }
        // 冻结闭环（Bug I）：源卡所属订单有待审批退款时禁止折抵（与 staff createConversion 对齐）
        if (await hasPendingRefund(tx, row.sale_order_id as string)) {
          throw new ApiError('INVALID_STATE', 'REFUND_IN_PROGRESS: 部分卡所属订单退款审批中，暂不可折抵')
        }

        const unit = Number(row.unit_real_price)
        const productType = row.product_type as string

        // 2026-05-21 单品合并：折抵统一按 remaining_sessions（含原"体验卡单品"=1 次卡）；家居产品不可折抵
        // 2026-08-06 预扣机制：可折抵数量 = remaining_sessions - 服务预扣（total_reserved）
        let qty = 0
        if (productType === '疗程卡') {
          const rem = Number(row.remaining_sessions ?? 0)
          const reserved = reservedBySaleItemId.get(row.sale_item_id as string) ?? 0
          if (rem <= 0) {
            throw new ApiError('INVALID_STATE', 'CARD_EXHAUSTED: 所选卡已耗尽，无法折抵')
          }
          const available = rem - reserved
          if (available <= 0) {
            throw new ApiError('INVALID_STATE', 'CARD_RESERVED: 所选卡可用次数不足（存在服务中预留）')
          }
          qty = available  // 折抵数量改为可用次数（扣除预扣）
        } else {
          throw new ApiError('INVALID_PARAMS', 'CARD_TYPE_INVALID: 所选行类型不支持折抵')
        }

        const amount = Math.round(unit * qty * 100) / 100
        totalOut += amount
        // 按折抵数量比例扣减 service_fee（负值）
        const origServiceFee = Number(row.service_fee ?? 0)
        const origQty = Number(row.quantity) || 1
        const outServiceFee = -Math.round((origServiceFee * qty / origQty) * 100) / 100

        outItems.push({
          refSaleItemId: row.sale_item_id as string,
          skuId: (row.sku_id as string) ?? null,
          productName: (row.product_name as string) ?? null,
          productType: productType as OutItem['productType'],
          sessionCount: row.session_count !== null ? Number(row.session_count) : null,
          unitPrice: String(row.unit_price),
          unitRealPrice: String(row.unit_real_price),
          quantity: qty,
          amount,
          salesCategory: (row.sales_category as string) ?? null,
          serviceFee: outServiceFee,
          isExperience: row.is_experience === true,
          isShengmei: (row.is_shengmei as boolean | null) ?? null,
        })
      }

      // 2. 加载转入 SKU 详情（price / special_price / service_fee / session_count / sales_category / capability）
      const inSkuIds = data.convertInItems.map((i) => i.skuId)
      const skuRows = await tx
        .select({
          skuId: productSkus.skuId,
          specName: productSkus.specName,
          price: productSkus.price,
          specialPrice: productSkus.specialPrice,
          serviceFee: productSkus.serviceFee,
          sessionCount: productSkus.sessionCount,
          productType: productSkus.productType,
          isExperience: productSkus.isExperience,
          isManagerSpecial: productSkus.isManagerSpecial,
          isShengmei: productSkus.isShengmei,
          marketScope: productSkus.marketScope,
          categoryId: productSkus.categoryId,
          salesCategory: productCategories.salesCategory,
          purchaseLimit: productSkus.purchaseLimit,
        })
        .from(productSkus)
        .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
        .where(and(inArray(productSkus.skuId, inSkuIds), isNull(productSkus.deletedAt)))
      const marketScopeViolation = await findNormalSkuMarketScopeViolation(data.clientUserId, skuRows)
      if (marketScopeViolation) {
        throw new ApiError('INVALID_PARAMS', normalSkuMarketScopeMessage(marketScopeViolation))
      }
      const skuMap = new Map(skuRows.map((r) => [r.skuId, r]))
      const purchaseLimitViolation = findPurchaseLimitViolation(data.convertInItems, skuRows)
      if (purchaseLimitViolation) {
        throw new ApiError('INVALID_PARAMS', `PURCHASE_LIMIT_EXCEEDED: ${purchaseLimitExceededMessage(purchaseLimitViolation)}`)
      }

      let totalIn = 0
      const inItems: Array<{
        item: (typeof data.convertInItems)[number]
        sku: typeof skuRows[number]
        amount: number
        unitPrice: string
        unitRealPrice: string
        serviceFee: number
        categoryId: string | null
      }> = []
      const buyerIsMember = isMember(client.customerType, client.memberLevel)
      for (const inItem of data.convertInItems) {
        const sku = skuMap.get(inItem.skuId)
        if (!sku) throw new ApiError('NOT_FOUND', `SKU_NOT_FOUND: 转入商品不存在 (${inItem.skuId})`)
        const quantity = inItem.quantity || 1
        const { listUnit, realUnit: applicableUnit } = resolveUnitPrice(
          { price: sku.price, specialPrice: sku.specialPrice, isExperience: sku.isExperience },
          buyerIsMember,
        )
        let amount = Math.round(applicableUnit * quantity * 100) / 100
        if (!isExperienceConversion
            && sku.isManagerSpecial === true
            && (inItem.saleAmount != null || inItem.unitRealPrice != null)) {
          const inputAmount = inItem.saleAmount != null
            ? Number(inItem.saleAmount)
            : Number(inItem.unitRealPrice) * quantity
          if (!Number.isFinite(inputAmount) || inputAmount < 0 || inputAmount > amount + 0.005) {
            throw new ApiError('INVALID_PARAMS', 'CONVERSION_MANAGER_SPECIAL_AMOUNT_INVALID: 转入项目应付金额不能高于该顾客适用价或为非法值')
          }
          amount = Math.round(inputAmount * 100) / 100
        }
        totalIn += amount
        const serviceFee = Math.round(Number(sku.serviceFee ?? 0) * quantity * 100) / 100
        const skuSessionCount = sku.sessionCount ?? inItem.sessionCount
        const sessionCount = skuSessionCount != null ? skuSessionCount * quantity : null
        const inDenom = (sessionCount != null && sessionCount > 0) ? sessionCount : quantity
        const listAmount = Math.round(listUnit * quantity * 100) / 100
        const unitPrice = inDenom > 0 ? (listAmount / inDenom).toFixed(2) : listAmount.toFixed(2)
        const unitRealPrice = inDenom > 0 ? (amount / inDenom).toFixed(2) : amount.toFixed(2)
        inItems.push({ item: inItem, sku, amount, unitPrice, unitRealPrice, serviceFee, categoryId: sku.categoryId })
      }

      // 疗程卡累计梯度价：按 category_id + spec_name 汇总本次全部转入次数，
      // 使用同组可命中的最高档位统一折算每次价格。必须先于体验转换覆盖和优惠券分摊执行。
      const treatmentTierLines = inItems.map(({ item, sku }) => ({
        categoryId: sku.categoryId,
        specName: sku.specName,
        productType: sku.productType,
        sessionCount: sku.sessionCount ?? item.sessionCount,
        quantity: item.quantity,
        isExperience: sku.isExperience,
        isManagerSpecial: sku.isManagerSpecial,
        isBundle: false,
      }))
      const treatmentTierCategoryIds = Array.from(new Set(
        treatmentTierLines
          .filter((line) =>
            line.productType === '疗程卡'
            && line.isExperience !== true
            && line.isManagerSpecial !== true
            && line.categoryId
            && line.specName
            && Number(line.sessionCount) > 0,
          )
          .map((line) => line.categoryId as string),
      ))
      if (treatmentTierCategoryIds.length > 0) {
        const tierCandidates = await tx
          .select({
            categoryId: productSkus.categoryId,
            specName: productSkus.specName,
            productType: productSkus.productType,
            price: productSkus.price,
            specialPrice: productSkus.specialPrice,
            sessionCount: productSkus.sessionCount,
            isExperience: productSkus.isExperience,
            isManagerSpecial: productSkus.isManagerSpecial,
          })
          .from(productSkus)
          .leftJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
          .where(and(
            inArray(productSkus.categoryId, treatmentTierCategoryIds),
            eq(productSkus.productType, '疗程卡'),
            eq(productSkus.isEnabled, true),
            eq(productSkus.isExperience, false),
            eq(productSkus.isManagerSpecial, false),
            isNull(productSkus.deletedAt),
          ))
        const tierAmounts = calculateTreatmentTierLineAmounts(
          treatmentTierLines,
          tierCandidates,
          buyerIsMember,
          '转换单',
        )
        inItems.forEach((row, index) => {
          const amount = tierAmounts[index]
          if (amount == null) return
          row.amount = amount
          const sessionCount = row.sku.sessionCount ?? row.item.sessionCount
          const totalSessions = sessionCount != null ? sessionCount * row.item.quantity : null
          const denom = totalSessions != null && totalSessions > 0 ? totalSessions : row.item.quantity
          row.unitRealPrice = denom > 0 ? (amount / denom).toFixed(2) : amount.toFixed(2)
        })
        totalIn = Math.round(inItems.reduce((sum, row) => sum + row.amount, 0) * 100) / 100
      }

      // 转换单优惠券只能抵扣券前的正补差额。券计算基数始终是转入项目的券前成交金额，
      // 实际抵扣额以 rawPriceDiff 封顶，避免把优惠券转化为储值卡余额。
      if (isExperienceConversion) {
        allocateExperienceConversionAmounts(inItems, totalOut)
        totalIn = Math.round(inItems.reduce((sum, row) => sum + row.amount, 0) * 100) / 100
      }
      const rawPriceDiff = Math.round((totalIn - totalOut) * 100) / 100
      let couponDiscount = 0
      if (data.couponId && !isExperienceConversion) {
        if (rawPriceDiff <= 0) {
          throw new ApiError('INVALID_STATE', 'CONVERSION_COUPON_NO_POSITIVE_DIFFERENCE: 转换单无正补差额，不能使用优惠券')
        }

        const [coupon] = await tx
          .select({
            status: userCoupons.status,
            expireAt: userCoupons.expireAt,
            userId: userCoupons.userId,
            couponType: couponTemplates.couponType,
            discountValue: sql<number>`COALESCE(${userCoupons.faceValueOverride}, ${couponTemplates.discountValue})`,
            maxDiscount: couponTemplates.maxDiscount,
            minSpend: couponTemplates.minSpend,
            isActive: couponTemplates.isActive,
            applicableStoreIds: couponTemplates.applicableStoreIds,
            applicableCategoryIds: couponTemplates.applicableCategoryIds,
            applicableProductIds: couponTemplates.applicableProductIds,
            applicableMarketIds: couponTemplates.applicableMarketIds,
          })
          .from(userCoupons)
          .innerJoin(couponTemplates, eq(userCoupons.templateId, couponTemplates.templateId))
          .where(eq(userCoupons.couponId, data.couponId))
          .limit(1)

        if (!coupon) throw new ApiError('NOT_FOUND', '优惠券不存在')
        if (coupon.userId !== data.clientUserId) throw new ApiError('PERMISSION_DENIED', '优惠券不属于该顾客')
        if (coupon.status !== '未使用') throw new ApiError('INVALID_STATE', '优惠券已被使用或已失效')
        if (coupon.expireAt < new Date()) throw new ApiError('INVALID_STATE', '优惠券已过期')
        if (!coupon.isActive) throw new ApiError('INVALID_STATE', '该优惠券模板已停用')

        if (coupon.applicableStoreIds && coupon.applicableStoreIds.length > 0
            && !coupon.applicableStoreIds.includes(data.storeId)) {
          throw new ApiError('INVALID_PARAMS', '该优惠券不适用于当前门店')
        }
        if (coupon.applicableMarketIds && coupon.applicableMarketIds.length > 0) {
          const [storeRow] = await tx
            .select({ parentId: orgNodes.parentId })
            .from(stores)
            .innerJoin(orgNodes, eq(stores.orgNodeId, orgNodes.id))
            .where(eq(stores.storeId, data.storeId))
            .limit(1)
          if (!storeRow?.parentId || !coupon.applicableMarketIds.includes(storeRow.parentId)) {
            throw new ApiError('INVALID_PARAMS', '该优惠券不适用于当前市场')
          }
        }

        const inSkuIds = inItems.map((row) => row.item.skuId)
        const [skuCatRows, skuProdRows] = await Promise.all([
          tx.select({ skuId: productSkus.skuId, categoryId: productSkus.categoryId })
            .from(productSkus)
            .where(and(inArray(productSkus.skuId, inSkuIds), isNull(productSkus.deletedAt))),
          tx.select({ skuId: mallProductSkus.skuId, productId: mallProductSkus.productId })
            .from(mallProductSkus)
            .where(inArray(mallProductSkus.skuId, inSkuIds)),
        ])
        const categoryBySku = new Map(skuCatRows.map((row) => [row.skuId, row.categoryId]))
        const productBySku = new Map(skuProdRows.map((row) => [row.skuId, row.productId]))
        const hasCategoryRestriction = !!(coupon.applicableCategoryIds && coupon.applicableCategoryIds.length > 0)
        const hasProductRestriction = !!(coupon.applicableProductIds && coupon.applicableProductIds.length > 0)
        const eligibleItems = (hasCategoryRestriction || hasProductRestriction)
          ? inItems.filter((row) => {
              const categoryMatch = !hasCategoryRestriction
                || coupon.applicableCategoryIds!.includes(categoryBySku.get(row.item.skuId) as string)
              const productMatch = !hasProductRestriction
                || coupon.applicableProductIds!.includes(productBySku.get(row.item.skuId) as string)
              return categoryMatch && productMatch
            })
          : inItems
        if (eligibleItems.length === 0) {
          throw new ApiError('INVALID_PARAMS', '该优惠券不适用于当前商品')
        }

        const eligibleTotal = Math.round(eligibleItems.reduce((sum, row) => sum + row.amount, 0) * 100) / 100
        const minSpend = Math.round((Number(coupon.minSpend) || 0) * 100) / 100
        if (eligibleTotal + 0.001 < minSpend) {
          throw new ApiError('INVALID_PARAMS', `订单金额未满足优惠券最低消费 ¥${minSpend.toFixed(2)}`)
        }
        const calculatedDiscount = calcCouponDiscount(
          coupon.couponType,
          String(coupon.discountValue),
          coupon.maxDiscount ?? null,
          eligibleTotal,
        )
        couponDiscount = Math.round(Math.min(
          Math.max(0, calculatedDiscount),
          rawPriceDiff,
        ) * 100) / 100
        if (couponDiscount <= 0) {
          throw new ApiError('INVALID_PARAMS', '该优惠券无法抵扣当前补差额')
        }

        let distributed = 0
        for (let i = 0; i < eligibleItems.length; i++) {
          const row = eligibleItems[i]
          const beforeCoupon = Math.round(row.amount * 100) / 100
          const share = i === eligibleItems.length - 1
            ? Math.round((couponDiscount - distributed) * 100) / 100
            : Math.round(couponDiscount * (beforeCoupon / eligibleTotal) * 100) / 100
          if (i < eligibleItems.length - 1) distributed += share
          row.amount = Math.max(0, Math.round((beforeCoupon - share) * 100) / 100)
          const sessionCount = row.sku.sessionCount ?? row.item.sessionCount
          const totalSessions = sessionCount != null ? sessionCount * row.item.quantity : null
          const denom = totalSessions != null && totalSessions > 0 ? totalSessions : row.item.quantity
          row.unitRealPrice = denom > 0 ? (row.amount / denom).toFixed(2) : row.amount.toFixed(2)
        }
      }

      totalIn = Math.round(inItems.reduce((sum, row) => sum + row.amount, 0) * 100) / 100
      const priceDiff = isExperienceConversion ? 0 : Math.round((totalIn - totalOut) * 100) / 100

      // 充值卡抵扣（仅正补差额 priceDiff > 0 时有效）：拒绝超额输入，不能静默截断。
      // 前端钳制仅改善体验，服务端仍以补差额和当前余额为准。
      const requestedCard = isExperienceConversion ? 0 : Number(data.prepaidCardAmount ?? 0)
      if (!Number.isFinite(requestedCard) || requestedCard < 0) {
        throw new ApiError('INVALID_PARAMS', '充值卡抵扣金额必须为非负数')
      }
      const card = Math.round(requestedCard * 100) / 100
      const maxCard = Math.max(0, priceDiff)
      if (card > maxCard + 0.005) {
        throw new ApiError('INVALID_PARAMS', '充值卡抵扣金额超过补差额')
      }
      const payable = Math.max(0, Math.round((Math.max(0, priceDiff) - card) * 100) / 100)
      let firstPaymentAmount: number | null = null
      let initialPaymentAmount = 0
      if (!isExperienceConversion && payable > 0) {
        const requested = data.receivedAmount == null ? payable : Number(data.receivedAmount)
        if (!Number.isFinite(requested) || requested < 0 || requested > payable + 0.005) {
          throw new ApiError('INVALID_PARAMS', '实付金额必须在0和应付金额之间')
        }
        initialPaymentAmount = Math.round(requested * 100) / 100
        if (initialPaymentAmount > 0 && initialPaymentAmount < payable) {
          firstPaymentAmount = initialPaymentAmount
        }
      }
      const isFullCardCoverage = card > 0 && payable === 0

      // 部分抵扣只写预选值，不扣余额；在事务中校验余额。
      // 全额抵扣由下方 deductPrepaidCardAtCreation 持行锁再次校验并扣款。
      if (card > 0 && !isFullCardCoverage) {
        const balanceRows = await tx.execute(sql`
          SELECT card_id, balance FROM prepaid_cards
          WHERE user_id = ${data.clientUserId}
        `)
        const currentBalance = Number((balanceRows as unknown as Array<{ balance?: string | number }>)[0]?.balance)
        if (!Number.isFinite(currentBalance) || currentBalance + 0.001 < card) {
          throw new ApiError('INSUFFICIENT_BALANCE', '充值卡余额不足')
        }
      }

      // 3. 生成订单号（advisory lock + 当日序号）
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen')::bigint)
        )
        SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
            ), 0) + 1
            FROM sale_orders
            WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 4, '0'
          ) AS id
        FROM lock
      `)
      const saleOrderId = (idRows as any[])[0]?.id as string
      if (!saleOrderId) throw new ApiError('INVALID_STATE', 'ORDER_ID_GEN_FAILED: 订单号生成失败')

      // 4. 计算 documentType（售前/售后）：仅按下单时会员身份判（售前=非会员客，售后=会员客）
      const documentType: '售前' | '售后' = client.customerType === '会员客' ? '售后' : '售前'

      // 5. 插入订单主表
      // 顾客补现场景：priceDiff > 0 → total_amount=priceDiff，status 按抵扣后应付决定
      //   - payable > 0（仍需付现金）：'待支付'，扣卡延后到 confirmOffline / payNotify
      //   - payable == 0 且有抵扣（全额抵扣）：事务内即时扣卡 → '已支付'，payment_method='无'
      // 其他（priceDiff <= 0）：total_amount=0 & status='已支付'
      const orderTotal = Math.max(0, priceDiff).toFixed(2)
      const orderStatus: typeof saleOrders.$inferInsert['status'] =
        priceDiff > 0 ? (payable > 0 ? '待支付' : '已支付') : '已支付'
      const orderPaid = priceDiff <= 0 || isFullCardCoverage
      const effectivePaymentMethod = isExperienceConversion || isFullCardCoverage ? '无' : data.paymentMethod

      await tx.insert(saleOrders).values({
        saleOrderId,
        status: orderStatus,
        saleOrderType: '转换单',
        documentType,
        marketName: data.marketName,
        storeId: data.storeId,
        storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
        saleOrderDatetime: nowTs(),
        clientUserId: data.clientUserId,
        clientPhone: client.phone ?? null,
        customerName: client.name ?? null,
        totalAmount: orderTotal,
        prepaidCardAmount: (isFullCardCoverage ? card : 0).toFixed(2),
        pendingPrepaidCardAmount: (isFullCardCoverage ? 0 : card).toFixed(2),
        payableAmount: payable.toFixed(2),
        received: isFullCardCoverage ? card.toFixed(2) : '0',
        paymentMethod: effectivePaymentMethod,
        openedBy: session.employeeId,
        preferredEmployeeId: data.preferredEmployeeId || null,
        couponId: data.couponId ?? null,
        couponDiscount: couponDiscount.toFixed(2),
        allocationStatus: '待分配',
        remark: data.remark || null,
        paidAt: orderPaid ? nowTs() : null,
        firstPaymentAmount: firstPaymentAmount != null ? firstPaymentAmount.toFixed(2) : null,
        isExperienceConversion,
      })

      // 必须在订单写入后再核销：user_coupons.used_sale_order_id 对 sale_orders 有即时外键约束。
      if (data.couponId) {
        const claimResult = await tx
          .update(userCoupons)
          .set({ status: '已使用', usedSaleOrderId: saleOrderId, usedAt: nowTs() })
          .where(and(
            eq(userCoupons.couponId, data.couponId),
            eq(userCoupons.userId, data.clientUserId),
            eq(userCoupons.status, '未使用'),
          ))
        if (rowsAffected(claimResult) !== 1) {
          throw new ApiError('CONFLICT', '优惠券已被使用，请刷新后重试')
        }
      }

      // 6. 转出行 + 原子扣减原卡余量
      let seq = 1
      for (const out of outItems) {
        const saleItemId = `${saleOrderId}-${String(seq).padStart(2, '0')}`
        seq++
        await tx.insert(saleItems).values({
          saleItemId,
          saleOrderId,
          storeId: data.storeId,
          itemDirection: '转出',
          refSaleItemId: out.refSaleItemId,
          skuId: out.skuId,
          productName: out.productName,
          productType: out.productType,
          sessionCount: out.sessionCount,
          unitPrice: out.unitPrice,
          quantity: out.quantity,
          unitRealPrice: out.unitRealPrice,
          saleAmount: (-out.amount).toFixed(2),
          received: (-out.amount).toFixed(2),
          salesCategory: (out.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ?? null,
          serviceFee: out.serviceFee.toFixed(2),
          // 转出行镜像原 sale_items.is_experience：负 received × is_experience=true 会冲销
          // 原订单的 trial_amount 累计，与跃迁 SQL 的"只升不降"语义一致。
          isExperience: out.isExperience,
          // 转出行镜像原 sale_items.is_shengmei（COALESCE product_skus 兜底）
          isShengmei: out.isShengmei,
        })

        // 原子扣减本次实际折抵的次数；服务中预扣仍留在源卡，供后续确认核销。
        if (out.productType === '疗程卡') {
          const upd = await tx
            .update(saleItems)
            .set({ remainingSessions: sql`${saleItems.remainingSessions} - ${out.quantity}` })
            .where(
              and(
                eq(saleItems.saleItemId, out.refSaleItemId),
                eq(saleItems.storeId, data.storeId),
                sql`COALESCE(${saleItems.remainingSessions}, 0) >= ${out.quantity}`,
              ),
            )
          if ((upd as any).count === 0) throw new ApiError('CONFLICT', 'CARD_CONCURRENT_CHANGED: 卡状态变化，请重试')
        }
      }

      // 7. 转入行：疗程卡逐张落库，group_id 仅用于展示合并与操作展开。
      for (const inRow of inItems) {
        // sessionCount 以服务端查到的 productSkus.session_count 为权威，
        // 组合套餐前端 payload 里疗程卡会丢失该字段（bundleSkuToProductSku 硬编码 null），
        // 这里兜底保证 remaining_sessions 正确，否则卡永远无法核销。
        // 每张卡是独立权益实体；家居产品仍保持 quantity 聚合行。
        const skuSessionCount = inRow.sku.sessionCount ?? inRow.item.sessionCount
        const cardCount = inRow.item.productType === '疗程卡' ? Number(inRow.item.quantity) || 1 : 1
        if (inRow.item.productType === '疗程卡'
            && (!Number.isInteger(cardCount) || cardCount <= 0
              || !Number.isInteger(skuSessionCount) || Number(skuSessionCount) <= 0)) {
          throw new ApiError('INVALID_PARAMS', 'CONVERSION_CARD_SPLIT_INVALID: 转入疗程卡次数必须能按张拆分')
        }
        const firstSeq = seq
        const groupId = inRow.item.productType === '疗程卡'
          ? `${saleOrderId}-${String(firstSeq).padStart(2, '0')}`
          : null
        const amountParts = splitMoneyByCount(inRow.amount, cardCount)
        const serviceFeeParts = splitMoneyByCount(inRow.serviceFee, cardCount)

        for (let index = 0; index < cardCount; index++) {
          const saleItemId = `${saleOrderId}-${String(seq).padStart(2, '0')}`
          seq++
          const sessionCount = skuSessionCount != null ? Number(skuSessionCount) : null
          const rowAmount = amountParts[index]
          const rowQuantity = inRow.item.productType === '疗程卡' ? 1 : inRow.item.quantity
          const rowUnitRealPrice = inRow.item.productType === '疗程卡' && sessionCount
            ? (rowAmount / sessionCount).toFixed(2)
            : inRow.unitRealPrice
          await tx.insert(saleItems).values({
            saleItemId,
            saleItemGroupId: groupId,
            saleOrderId,
            storeId: data.storeId,
            itemDirection: '转入',
            skuId: inRow.item.skuId,
            productName: inRow.item.productName,
            productType: inRow.item.productType,
            sessionCount,
            remainingSessions: sessionCount,
            unitPrice: inRow.unitPrice,
            quantity: rowQuantity,
            unitRealPrice: rowUnitRealPrice,
            saleAmount: rowAmount.toFixed(2),
            received: rowAmount.toFixed(2),
            salesCategory:
              (inRow.item.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ??
              (inRow.sku.salesCategory as typeof saleItems.$inferInsert['salesCategory']) ??
              null,
            serviceFee: serviceFeeParts[index].toFixed(2),
            // 转入行从 product_skus 快照写入 is_experience / is_shengmei
            isExperience: inRow.sku.isExperience === true,
            isShengmei: inRow.sku.isShengmei ?? null,
            isManagerSpecial: inRow.sku.isManagerSpecial === true,
          })
        }
      }

      // 8. 差额退余：priceDiff < 0 → UPSERT prepaid_cards + card_transactions
      let prepaidCardCredit = 0
      if (priceDiff < 0) {
        const creditAmount = Math.abs(priceDiff)
        prepaidCardCredit = creditAmount

        // UPSERT prepaid_cards（按 user_id 唯一；store_id 列已于 2026-04-24 DROP，卡跨店共享）
        const upsertRows = await tx.execute(sql`
          INSERT INTO prepaid_cards (card_id, user_id, balance)
          VALUES (gen_random_uuid()::text, ${data.clientUserId}, ${creditAmount.toFixed(2)})
          ON CONFLICT (user_id) DO UPDATE
            SET balance = prepaid_cards.balance + EXCLUDED.balance,
                updated_at = NOW()
          RETURNING card_id
        `)
        const cardId = (upsertRows as any[])[0]?.card_id as string
        if (!cardId) throw new ApiError('CONFLICT', 'PREPAID_CARD_UPSERT_FAILED: 储值卡入账失败，请稍后重试')

        await tx.insert(cardTransactions).values({
          cardId,
          type: '充值',
          amount: creditAmount.toFixed(2),
          refOrderId: saleOrderId,
        })
      }

      // 8b. 补差额全额抵扣（priceDiff > 0 且 payable==0）：事务内即时扣卡 + 写 '储值卡抵扣' 流水。
      //     与 8（负差额充值）互斥（全额抵扣要求 priceDiff > 0）。
      let convFullCardPaymentId: number | string | null = null
      if (isFullCardCoverage) {
        convFullCardPaymentId = await deductPrepaidCardAtCreation(tx, {
          saleOrderId,
          clientUserId: data.clientUserId,
          amount: card,
          employeeId: session.employeeId,
          note: '管理后台转换单-储值卡全额抵扣',
        })
      }

      // 按回款逐笔分配：转换单补差额全额抵扣即结清 → 捕获可分配额 + 置待分配 + 汇总刷新（非定向）
      // 必须在 recalcPaidSessionsForOrder 之前：新 STEP1 从 receipt 聚合 received。
      if (convFullCardPaymentId && card > 0) {
        await capturePaymentAllocatables(tx, {
          salePaymentId: convFullCardPaymentId,
          saleOrderId,
          eventAmount: card,
          directedItems: null,
        })
        await refreshOrderAllocationRollup(tx, saleOrderId)
      }

      // paid_sessions 写入（ticket 2026-05-19）：转换单 total_amount=差额，可能=0 → 兜底全付
      // 必须在 capture 之后：新 STEP1 从 receipt 聚合 received
      await recalcPaidSessionsForOrder(tx, saleOrderId)

      // 全额抵扣即结清：触发积分发放 + 客户分类跃迁（与 confirmOfflinePayment 已支付分支一致）。
      if (isFullCardCoverage) {
        await settlePointsSafe(tx, saleOrderId, 'admin.createConversion')
        await recalcCustomerType(tx, data.clientUserId)
      }

      return {
        saleOrderId,
        totalIn: Math.round(totalIn * 100) / 100,
        totalOut: Math.round(totalOut * 100) / 100,
        priceDiff,
        prepaidCardCredit,
        prepaidCardAmount: card,
        couponDiscount,
        firstPaymentAmount,
        initialPaymentAmount,
        payable,
        isExperienceConversion,
        orderStatus,
      }
    })
  } catch (err: any) {
    const m = err?.message as string | undefined
    if (m?.includes('CARD_NOT_FOUND')) return { success: false, message: '部分卡不存在或已失效' }
    if (m?.includes('CARD_STORE_MISMATCH')) return { success: false, message: '所选卡不属于当前门店' }
    if (m?.includes('CARD_OWNER_MISMATCH')) return { success: false, message: '所选卡不属于该顾客' }
    if (m?.includes('CARD_DIRECTION_INVALID')) return { success: false, message: '所选行不是有效疗程权益，不可折抵' }
    if (m?.includes('CARD_ORDER_STATUS_INVALID')) return { success: false, message: '原订单状态不允许转换' }
    if (m?.includes('CARD_EXHAUSTED')) return { success: false, message: '所选卡已耗尽，无法折抵' }
    if (m?.includes('CARD_RESERVED')) return { success: false, message: '所选卡可用次数不足（存在服务中预留）' }
    if (m?.includes('CARD_TYPE_INVALID')) return { success: false, message: '所选行类型不支持折抵' }
    if (m?.includes('CARD_CONCURRENT_CHANGED')) return { success: false, message: '卡状态变化，请重试' }
    if (m?.includes('ORDER_ID_GEN_FAILED')) return { success: false, message: '订单号生成失败，请稍后重试' }
    if (m?.includes('PREPAID_CARD_UPSERT_FAILED')) return { success: false, message: '储值卡入账失败，请稍后重试' }
    if (m?.includes('PURCHASE_LIMIT_EXCEEDED:')) {
      return {
        success: false,
        message: m.replace(/^INVALID_PARAMS:\s*PURCHASE_LIMIT_EXCEEDED:\s*/, '').replace(/^PURCHASE_LIMIT_EXCEEDED:\s*/, ''),
      }
    }
    // 全额抵扣即时扣卡失败（余额不足 / 无卡）
    if (m?.startsWith('INSUFFICIENT_BALANCE')) {
      const stripped = m.replace(/^INSUFFICIENT_BALANCE:?(NO_CARD)?:?\s*/, '')
      return { success: false, message: stripped || '顾客储值卡余额不足' }
    }
    if (err instanceof ApiError) {
      const parsed = parseErrorPrefix(err.message)
      return { success: false, message: parsed?.displayMessage ?? err.message }
    }
    if (m?.includes('SKU_NOT_FOUND:')) return { success: false, message: '转入商品不存在' }
    if (pgErrorCode(err) === '23503') {
      console.error('[createConversionOrder] fk_violation:', err)
      return { success: false, message: '关联数据不存在，请检查门店、商品或顾客信息' }
    }
    if (pgErrorCode(err) === '23502') {
      console.error('[createConversionOrder] not_null_violation:', err)
      return { success: false, message: '订单字段缺失，请联系管理员' }
    }
    if (pgErrorCode(err) === '23505') return { success: false, message: '订单号冲突，请稍后重试' }
    console.error('[createConversionOrder] unexpected error:', err)
    return { success: false, message: '转换单创建失败，请稍后重试' }
  }

  await logOperation(session, 'order.create_conversion', 'sale_order', result.saleOrderId, {
    storeId: data.storeId,
    saleOrderId: result.saleOrderId,
    convertOutSaleItemIds: data.convertOutSaleItemIds,
    totalIn: result.totalIn,
    totalOut: result.totalOut,
    priceDiff: result.priceDiff,
    prepaidCardCredit: result.prepaidCardCredit,
    prepaidCardAmount: result.prepaidCardAmount,
    couponDiscount: result.couponDiscount,
    receivedAmount: result.initialPaymentAmount,
    isExperienceConversion: result.isExperienceConversion,
  })

  revalidatePath('/orders')
  // 补差额抵扣后实际仍需付现金 = priceDiff - 抵扣额
  const remainingPayable = Math.max(0, Math.round((result.priceDiff - result.prepaidCardAmount) * 100) / 100)
  const plannedDebt = Math.max(0, Math.round((remainingPayable - result.initialPaymentAmount) * 100) / 100)
  const cardPrefix = result.prepaidCardAmount > 0
    ? `储值卡抵扣 ¥${result.prepaidCardAmount.toFixed(2)}，`
    : ''
  return {
    success: true,
    message:
      result.priceDiff > 0
        ? remainingPayable > 0
          ? result.initialPaymentAmount > 0
            ? `转换单已创建，${cardPrefix}本次应收 ¥${result.initialPaymentAmount.toFixed(2)}${plannedDebt > 0 ? `，剩余挂账 ¥${plannedDebt.toFixed(2)}` : ''}`
            : `转换单已创建，${cardPrefix}已挂账 ¥${remainingPayable.toFixed(2)}`
          : `转换单已完成，储值卡全额抵扣 ¥${result.prepaidCardAmount.toFixed(2)}`
        : result.priceDiff < 0
          ? `转换单已完成，差额 ¥${result.prepaidCardCredit.toFixed(2)} 已充入储值卡`
          : '转换单已完成',
    saleOrderId: result.saleOrderId,
    totalIn: result.totalIn,
    totalOut: result.totalOut,
    priceDiff: result.priceDiff,
    prepaidCardCredit: result.prepaidCardCredit,
    prepaidCardAmount: result.prepaidCardAmount,
    couponDiscount: result.couponDiscount,
    isExperienceConversion: result.isExperienceConversion,
    receivedAmount: result.initialPaymentAmount,
    remainingAmount: result.payable,
    status: result.orderStatus,
  }
  },
)

// ========== B5: 寄存单（剩余次数初始化） ==========

/**
 * 管理后台开寄存单（admin）
 *
 * 与 staffApi.order.createDeposit 语义对齐：
 *   - 复用 sale_orders + sale_items，可生成 service_orders 核销
 *   - 提交审批：received=0 / payable=0 / total=0 / payment_method='无' / status='待审批'
 *   - 审批通过后才落 paid_at、激活 paid_sessions，并按历史实收重算疗程卡实际单价
 *   - 拒绝任何抵扣（优惠券 / 储值卡 / 行级 customPrice）
 *   - 所有金额维度统计排除（dashboard / 提成 / 客单价）
 *   - 次数维度统计纳入（mgmt-product.cardHolders 持卡人数）
 *   - 仅 manager 角色（沿用 'sale_order:create' 权限）
 *
 * 输入：
 *   storeId / marketName / clientUserId（必填）+ items[{skuId, quantity}] + remark
 */
export const createDepositOrder = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
      storeId: string
      marketName: string
      clientUserId: string
      preferredEmployeeId?: string
      remark?: string | null
      items: Array<{
        skuId: string
        quantity: number
        // 该行历史实收金额（老顾客这张卡当时实际收了多少钱）。可选，默认 0。
        // >0 时写一条 sale_order_payments('回款',线下,ref=该行) 流水，total_amount 仍保持 0
        // （次数全开 + 统计排除不变）。
        received?: number
      }>
    },
  ): Promise<{ success: boolean; message: string; saleOrderId?: string; itemCount?: number }> => {
    if (!isInScope(session, data.storeId)) {
      return { success: false, message: '无权在该门店创建订单' }
    }
    if (!data.clientUserId) {
      return { success: false, message: '寄存单必须指定顾客' }
    }
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return { success: false, message: '寄存单至少需要 1 个商品' }
    }
    for (const it of data.items) {
      if (!it || !it.skuId) return { success: false, message: 'items 缺少 skuId' }
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
        return { success: false, message: 'items.quantity 必须为正整数' }
      }
      if (it.received != null && (!Number.isFinite(it.received) || it.received < 0)) {
        return { success: false, message: 'items.received 必须为非负数' }
      }
    }

    // 查顾客（client_identity_rule：bound_store_id 即可，openid 可空）
    const [client] = await db
      .select({
        userId: clientWechatUsers.userId,
        phone: clientWechatUsers.phone,
        name: clientWechatUsers.name,
        boundStoreId: clientWechatUsers.boundStoreId,
      })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (!client) {
      return { success: false, message: '顾客不存在' }
    }
    if (!client.boundStoreId) {
      return { success: false, message: '顾客未绑定门店' }
    }

    // 拉 SKU 信息（充值卡剥离 SKU 化后，寄存单输入只剩普通商品）
    const skuIds = [...new Set(data.items.map(i => i.skuId))]
    const skuRows = await db
      .select({
        skuId: productSkus.skuId,
        productType: productSkus.productType,
        specName: productSkus.specName,
        price: productSkus.price,
        specialPrice: productSkus.specialPrice,
        sessionCount: productSkus.sessionCount,
        isShengmei: productSkus.isShengmei,
        isExperience: productSkus.isExperience,
        marketScope: productSkus.marketScope,
        salesCategory: productCategories.salesCategory,
        productKind: productCategories.productKind,
      })
      .from(productSkus)
      .innerJoin(productCategories, eq(productSkus.categoryId, productCategories.categoryId))
      .where(and(inArray(productSkus.skuId, skuIds), isNull(productSkus.deletedAt)))
    if (skuRows.length !== skuIds.length) {
      return { success: false, message: '部分商品不存在或已下架' }
    }
    const marketScopeViolation = await findNormalSkuMarketScopeViolation(data.clientUserId, skuRows)
    if (marketScopeViolation) {
      return { success: false, message: normalSkuMarketScopeMessage(marketScopeViolation) }
    }
    const skuMap = new Map(skuRows.map(s => [s.skuId, s]))

    // 寄存单疗程卡与家居产品均逐张/件写入 sale_items；页面按行组聚合显示。
    // 这样每个实体均有独立 sale_item_id，可单独转换、核销或提货。
    const buildDepositItem = (sku: (typeof skuRows)[number], quantity: number, received: number) => {
      const basePrice = Number(sku.specialPrice || sku.price)
      const sessionCount = sku.productType === '家居产品'
        ? null
        : (sku.sessionCount != null ? Number(sku.sessionCount) * quantity : null)
      const totalSaleCents = Math.round(basePrice * quantity * 100)
      const saleAmount = Math.round(totalSaleCents) / 100
      const denom = sessionCount != null && sessionCount > 0 ? sessionCount : quantity
      const unitPrice = denom > 0 ? (saleAmount / denom).toFixed(2) : saleAmount.toFixed(2)
      return {
        sku,
        quantity,
        sessionCount,
        saleAmount: saleAmount.toFixed(2),
        received: Math.round(received * 100) / 100,
        unitPrice,
        unitRealPrice: unitPrice,
      }
    }

    const depositItems: Array<ReturnType<typeof buildDepositItem> & { depositGroupKey: string }> = []
    for (const [inputIndex, item] of data.items.entries()) {
      const sku = skuMap.get(item.skuId)!
      const received = Math.round((Number(item.received) || 0) * 100) / 100
      // 金额按分均摊，最后一件吸收尾差，确保标价和历史实收的合计不变。
      const saleAmountCents = Math.round(Number(sku.specialPrice || sku.price) * item.quantity * 100)
      const receivedCents = Math.round(received * 100)
      const saleAmountPerEntity = Math.trunc(saleAmountCents / item.quantity)
      const receivedPerEntity = Math.trunc(receivedCents / item.quantity)
      for (let i = 0; i < item.quantity; i++) {
        const isLast = i === item.quantity - 1
        const entitySaleAmount = (saleAmountPerEntity + (isLast ? saleAmountCents % item.quantity : 0)) / 100
        const entityReceived = (receivedPerEntity + (isLast ? receivedCents % item.quantity : 0)) / 100
        const entity = buildDepositItem(sku, 1, entityReceived)
        depositItems.push({
          ...entity,
          saleAmount: entitySaleAmount.toFixed(2),
          depositGroupKey: `deposit-${inputIndex}`,
        })
      }
    }

    // 在事务内生成订单号 + 写 sale_orders + sale_items
    let saleOrderId: string
    try {
      saleOrderId = await db.transaction(async (tx) => {
        const idRows = await tx.execute(sql`
          WITH lock AS (
            SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen')::bigint)
          )
          SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
            LPAD(
              (SELECT COALESCE(MAX(
                CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
              ), 0) + 1
              FROM sale_orders
              WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
              )::TEXT, 4, '0'
            ) AS id
          FROM lock
        `)
        const id = (idRows as any[])[0]?.id as string
        if (!id) throw new ApiError('INVALID_STATE', '订单号生成失败')

        const now = new Date()
        await tx.insert(saleOrders).values({
          saleOrderId: id,
          status: '待审批',
          saleOrderType: '寄存单',
          documentType: '售后',
          marketName: data.marketName,
          storeId: data.storeId,
          storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
          saleOrderDatetime: nowTs(),
          clientUserId: data.clientUserId,
          clientPhone: client.phone || null,
          customerName: client.name || null,
          totalAmount: '0',
          prepaidCardAmount: '0',
          payableAmount: '0',
          received: '0',
          paymentMethod: '无',
          openedBy: session.employeeId || null,
          preferredEmployeeId: data.preferredEmployeeId || null,
          couponId: null,
          couponDiscount: '0',
          remark: data.remark || null,
          allocationStatus: '待分配',
        })

        // 生成 sale_item 流水号序列
        const dateStr = shanghaiYmd(now)
        const maxRows = await tx.execute(sql`
          SELECT sale_item_id FROM sale_items
          WHERE sale_item_id LIKE ${`XSLSH-WX-${dateStr}%`}
          ORDER BY sale_item_id DESC LIMIT 1
        `)
        let seq = 1
        const lastRow = (maxRows as any[])[0]
        if (lastRow && lastRow.sale_item_id) {
          seq = parseInt(String(lastRow.sale_item_id).slice(-4)) + 1
        }

        // 收集需要写实收流水的行（received>0），循环后统一 INSERT sale_order_payments + 更新 received
        const preparedItems = depositItems.map((item, index) => ({
          ...item,
          saleItemId: `XSLSH-WX-${dateStr}${String(seq + index).padStart(4, '0')}`,
        }))
        const groupIdByKey = new Map<string, string>()
        for (const item of preparedItems) {
          if (!groupIdByKey.has(item.depositGroupKey)) groupIdByKey.set(item.depositGroupKey, item.saleItemId)
        }

        const receiptRows: Array<{ saleItemId: string; received: number }> = []
        for (const item of preparedItems) {
          const sku = item.sku
          const saleItemId = item.saleItemId
          if (item.received > 0) receiptRows.push({ saleItemId, received: item.received })

          await tx.insert(saleItems).values({
            saleItemId,
            saleItemGroupId: groupIdByKey.get(item.depositGroupKey)!,
            saleOrderId: id,
            storeId: data.storeId,
            itemDirection: '购买',
            skuId: sku.skuId,
            productName: sku.specName,
            productType: sku.productType,
            sessionCount: item.sessionCount,
            remainingSessions: item.sessionCount,
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            unitRealPrice: item.unitRealPrice,
            saleAmount: item.saleAmount,
            received: '0',
            salesCategory: sku.salesCategory ?? null,
            serviceFee: '0',
            isShengmei: sku.isShengmei ?? null,
            isExperience: sku.isExperience === true,
          })
        }

        // 历史实收录入：对 received>0 的行写一条待审批 '回款'(线下) 流水（ref=该行，targeted）。
        // 审批通过前不计入 sale_orders.received、不落 paid_sessions，避免未审批寄存单可被核销。
        if (receiptRows.length > 0) {
          for (const r of receiptRows) {
            await tx.insert(saleOrderPayments).values({
              saleOrderId: id,
              changeType: '回款',
              amount: r.received.toFixed(2),
              paymentMethod: '线下',
              externalTxnId: null,
              status: '待审批',
              sourceEnd: 'admin',
              operatorEmployeeId: session.employeeId,
              refSaleItemId: r.saleItemId,
              note: DEPOSIT_RECEIPT_NOTE,
            })
          }
        }

        return id
      })
    } catch (err: any) {
      if (err instanceof ApiError) {
        return { success: false, message: err.message }
      }
      return { success: false, message: err?.message || '寄存单创建失败' }
    }

    await logOperation(
      session,
      'order.createDeposit',
      'sale_order',
      saleOrderId,
      {
        _v: 1,
        clientUserId: data.clientUserId,
        status: '待审批',
        itemCount: depositItems.length,
        totalSessionCount: depositItems.reduce((acc, it) => acc + (it.sessionCount ?? 0), 0),
      },
    )

    revalidatePath('/orders')
    return {
      success: true,
      message: `寄存单已提交审批（${depositItems.length} 项）`,
      saleOrderId,
      itemCount: depositItems.length,
    }
  },
)

export const approveDepositOrder = withPermission(
  'sale_order:deposit_approve',
  async (session, saleOrderId: string): Promise<{ success: boolean; message: string }> => {
    assertCanApproveDepositOrder(session)
    if (!saleOrderId) {
      throw new ApiError('INVALID_PARAMS', '缺少寄存单 ID')
    }

    let approvedReceived = '0'
    await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`
        SELECT sale_order_id, status, sale_order_type, store_id
        FROM sale_orders
        WHERE sale_order_id = ${saleOrderId}
        FOR UPDATE
      `)
      const order = (lockedRows as unknown as Array<{
        sale_order_id: string
        status: string
        sale_order_type: string
        store_id: string
      }>)[0]
      if (!order) {
        throw new ApiError('NOT_FOUND', '寄存单不存在')
      }
      if (order.sale_order_type !== '寄存单') {
        throw new ApiError('INVALID_STATE', '只有寄存单需要审批')
      }
      if (order.status !== '待审批') {
        throw new ApiError('INVALID_STATE', `当前状态"${order.status}"不允许审批`)
      }
      if (!isInScope(session, order.store_id)) {
        throw new ApiError('PERMISSION_DENIED', '无权审批该门店寄存单')
      }

      const approvedAt = nowTs()
      await tx.execute(sql`
        UPDATE sale_order_payments
        SET status = '已支付',
            paid_at = ${approvedAt},
            audit_employee_id = ${session.employeeId},
            audit_at = ${approvedAt}
        WHERE sale_order_id = ${saleOrderId}
          AND change_type = '回款'
          AND note = ${DEPOSIT_RECEIPT_NOTE}
          AND status = '待审批'
      `)

      const updatedRows = await tx.execute(sql`
        UPDATE sale_orders
        SET status = '已支付',
            paid_at = ${approvedAt},
            audited_at = ${approvedAt},
            audited_by = ${session.employeeId},
            received = (
              SELECT COALESCE(SUM(amount), 0)::numeric(10, 2)
              FROM sale_order_payments
              WHERE sale_order_id = ${saleOrderId}
                AND change_type IN ('首次支付', '回款', '储值卡抵扣')
                AND status = '已支付'
            ),
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId}
          AND status = '待审批'
        RETURNING received
      `)
      const updated = (updatedRows as unknown as Array<{ received: string }>)[0]
      if (!updated) {
        throw new ApiError('CONFLICT', '寄存单状态已变化，请刷新后重试')
      }
      approvedReceived = updated.received ?? '0'

      // 审批通过后才激活寄存单次数与实际单价。
      await recalcPaidSessionsForOrder(tx, saleOrderId)
      await recomputeDepositRealPrice(tx, saleOrderId)
    })

    await logTransition(session, 'order.approveDeposit', 'sale_order', saleOrderId, '待审批', '已支付', {
      received: approvedReceived,
    })
    revalidatePath('/orders')
    revalidatePath(`/orders/${saleOrderId}`)
    return { success: true, message: '寄存单审批通过' }
  },
)

export const rejectDepositOrder = withPermission(
  'sale_order:deposit_approve',
  async (
    session,
    saleOrderId: string,
    reason: string,
  ): Promise<{ success: boolean; message: string }> => {
    assertCanApproveDepositOrder(session)
    if (!saleOrderId) {
      throw new ApiError('INVALID_PARAMS', '缺少寄存单 ID')
    }
    const auditReason = String(reason || '').trim()
    if (!auditReason) {
      throw new ApiError('INVALID_PARAMS', '请输入驳回原因')
    }
    if (auditReason.length > 500) {
      throw new ApiError('INVALID_PARAMS', '驳回原因不能超过 500 字')
    }

    await db.transaction(async (tx) => {
      const lockedRows = await tx.execute(sql`
        SELECT sale_order_id, status, sale_order_type, store_id
        FROM sale_orders
        WHERE sale_order_id = ${saleOrderId}
        FOR UPDATE
      `)
      const order = (lockedRows as unknown as Array<{
        sale_order_id: string
        status: string
        sale_order_type: string
        store_id: string
      }>)[0]
      if (!order) {
        throw new ApiError('NOT_FOUND', '寄存单不存在')
      }
      if (order.sale_order_type !== '寄存单') {
        throw new ApiError('INVALID_STATE', '只有寄存单需要审批')
      }
      if (order.status !== '待审批') {
        throw new ApiError('INVALID_STATE', `当前状态"${order.status}"不允许驳回`)
      }
      if (!isInScope(session, order.store_id)) {
        throw new ApiError('PERMISSION_DENIED', '无权审批该门店寄存单')
      }

      const rejectedAt = nowTs()
      await tx.execute(sql`
        UPDATE sale_order_payments
        SET status = '已作废',
            audit_employee_id = ${session.employeeId},
            audit_at = ${rejectedAt},
            audit_remark = ${auditReason}
        WHERE sale_order_id = ${saleOrderId}
          AND change_type = '回款'
          AND note = ${DEPOSIT_RECEIPT_NOTE}
          AND status = '待审批'
      `)

      const updatedRows = await tx.execute(sql`
        UPDATE sale_orders
        SET status = '已作废',
            audited_at = ${rejectedAt},
            audited_by = ${session.employeeId},
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId}
          AND status = '待审批'
        RETURNING sale_order_id
      `)
      if ((updatedRows as unknown as Array<{ sale_order_id: string }>).length === 0) {
        throw new ApiError('CONFLICT', '寄存单状态已变化，请刷新后重试')
      }
    })

    await logTransition(session, 'order.rejectDeposit', 'sale_order', saleOrderId, '待审批', '已作废', {
      reason: auditReason,
    })
    revalidatePath('/orders')
    revalidatePath(`/orders/${saleOrderId}`)
    return { success: true, message: '寄存单已驳回' }
  },
)

// ========== 旧系统充值金转入（WorkFine 充值金迁移） ==========

/**
 * 旧系统(WorkFine)充值金转入：把顾客在旧系统的充值金余额等额导入新系统储值卡
 *
 * 与 createRechargeOrder（cards.ts）的区别：旧系统已收过钱 → 1:1 等额、不打折、不限额、
 * 不走 matchTier 档位；直接建 status='已支付' 的充值单（不经待支付 → confirmOfflinePayment），
 * 即时入账 balance += amount。remark / 流水 note 打专用标记「旧系统充值金转入」便于查账识别
 * （充值单本就不计营收，无需改统计 SQL）。
 *
 * 转入单本质是普通充值单：将来退款天然走员工端 card.createRefund/approveRefund（与任何充值单一致）。
 * received=amount（非 0）+ 配一条「首次支付」流水，维护 received=Σ流水（资金不变量 I1），
 * 保证将来退款 refunded_amount ≤ received，不触发 cron 资金巡检告警。
 */
export const createPrepaidInflow = withPermission(
  'sale_order:create',
  async (
    session,
    data: {
      clientUserId: string
      storeId: string
      amount: number
      remark?: string | null
      requestId?: string // 幂等 token：重复提交 / 重试携带同值，后端据此去重防重复入账
    },
  ): Promise<{ success: boolean; message: string; saleOrderId?: string }> => {
    if (!data.clientUserId) return { success: false, message: '请选择顾客' }
    if (!data.storeId) return { success: false, message: '请选择入账门店' }
    const amt = Number(data.amount)
    if (!Number.isFinite(amt) || amt <= 0) return { success: false, message: '转入金额无效' }
    // 浮点容差：与 matchTier 同口径，最多保留 2 位小数
    if (Math.abs(Math.round(amt * 100) - amt * 100) > 1e-6) {
      return { success: false, message: '转入金额最多保留 2 位小数' }
    }
    if (amt > 99999999.99) return { success: false, message: '转入金额超出上限' } // NUMERIC(10,2) 上界保护
    if (!isInScope(session, data.storeId)) return { success: false, message: '无权在该门店转入' }

    // 顾客 + documentType 快照
    const [client] = await db
      .select({
        userId: clientWechatUsers.userId,
        name: clientWechatUsers.name,
        phone: clientWechatUsers.phone,
        customerType: clientWechatUsers.customerType,
      })
      .from(clientWechatUsers)
      .where(eq(clientWechatUsers.userId, data.clientUserId))
      .limit(1)
    if (!client) return { success: false, message: '顾客不存在' }
    const documentType: '售前' | '售后' = client.customerType === '会员客' ? '售后' : '售前'

    // 门店 + marketName 快照（跨两级 org_nodes 取上级 market，同 createRechargeOrder）
    const storeRows = (await db.execute(sql`
      SELECT s.store_id, pm.name AS market_name
      FROM stores s
      LEFT JOIN org_nodes sn ON s.org_node_id = sn.id
      LEFT JOIN org_nodes pm ON sn.parent_id = pm.id
      WHERE s.store_id = ${data.storeId}
      LIMIT 1
    `)) as unknown as Array<{ store_id: string; market_name: string | null }>
    if (storeRows.length === 0) return { success: false, message: '入账门店不存在' }
    const marketName = storeRows[0].market_name || ''
    const note = data.remark ? `${LEGACY_INFLOW_NOTE}｜${data.remark}` : LEGACY_INFLOW_NOTE
    // 幂等键：前端每次提交生成 requestId，重复提交 / 重试携带同值 → 据此去重防重复入账
    const inflowRef = data.requestId ? `card-inflow-${data.requestId}` : null

    let saleOrderId: string
    try {
      saleOrderId = await db.transaction(async (tx) => {
        // 顾客级 advisory lock：串行化同顾客的并发转入（双击 / 重试），先于订单号锁获取
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'card_inflow:' + data.clientUserId})::bigint)`)
        // 幂等短路：同一 requestId 已成功转入则复用既有订单，不重复建单 / 不重复 += balance（防重复入账核心）
        if (inflowRef) {
          const dupRows = (await tx.execute(sql`
            SELECT ref_order_id FROM card_transactions WHERE external_ref = ${inflowRef} LIMIT 1
          `)) as unknown as Array<{ ref_order_id: string }>
          if (dupRows.length > 0) return dupRows[0].ref_order_id as string
        }
        const idRows = await tx.execute(sql`
          WITH lock AS (
            SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen')::bigint)
          )
          SELECT 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') ||
            LPAD(
              (SELECT COALESCE(MAX(
                CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
              ), 0) + 1
              FROM sale_orders
              WHERE sale_order_id LIKE 'FY-XSD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
              )::TEXT, 4, '0'
            ) AS id
          FROM lock
        `)
        const id = (idRows as unknown as Array<{ id: string }>)[0]?.id
        if (!id) throw new ApiError('INVALID_STATE', '订单号生成失败')

        // 转入单：直接 '已支付'，total=payable=received=amt（1:1），prepaid=0，线下，paid_at=now
        // 不加待支付并发守卫（uq_sale_orders_client_pending 现仅约束 opened_by IS NULL 自助单，迁移不应被无关待支付单卡住）
        await tx.insert(saleOrders).values({
          saleOrderId: id,
          status: '已支付',
          saleOrderType: '充值单',
          documentType,
          marketName,
          storeId: data.storeId,
          storeName: sql<string>`(SELECT store_name FROM stores WHERE store_id = ${data.storeId})`,
          saleOrderDatetime: nowTs(),
          clientUserId: data.clientUserId,
          clientPhone: client.phone || '',
          customerName: client.name || '',
          totalAmount: amt.toFixed(2),
          prepaidCardAmount: '0',
          payableAmount: amt.toFixed(2),
          received: amt.toFixed(2),
          firstPaymentAmount: null,
          couponId: null,
          couponDiscount: '0',
          paymentMethod: '线下',
          openedBy: session.employeeId,
          preferredEmployeeId: null,
          allocationStatus: '待分配',
          remark: note,
          paidAt: nowTs(),
        })

        // 首次支付流水（线下 / external_txn_id=NULL / 已支付）：维护 received=Σ流水（资金不变量 I1）
        await tx.insert(saleOrderPayments).values({
          saleOrderId: id,
          changeType: '首次支付',
          amount: amt.toFixed(2),
          paymentMethod: '线下',
          externalTxnId: null,
          status: '已支付',
          sourceEnd: 'admin',
          operatorEmployeeId: session.employeeId,
          note,
          paidAt: nowTs(),
        })

        // 充值入账（复用 applyRechargeOnOrderPaid：balance += total + card_transactions 充值）。
        // 转入传 card-inflow-{requestId} 幂等键，使「不同订单号的重试」也能去重防重复入账。
        await applyRechargeOnOrderPaid(tx, id, inflowRef ?? undefined)

        return id
      })
    } catch (err: any) {
      const msg = err?.message || '转入失败'
      return { success: false, message: msg.replace(/^[A-Z_]+:\s*/, '') }
    }

    await logOperation(session, 'sale_order.prepaid_inflow', 'sale_order', saleOrderId, {
      clientUserId: data.clientUserId,
      storeId: data.storeId,
      amount: amt,
      legacy: true,
    })

    revalidatePath('/orders')
    revalidatePath(`/customers/${data.clientUserId}`)

    return { success: true, message: '转入成功', saleOrderId }
  },
)

// ========== 录入回款（ticket 2026-04-24 多次回款 PR-B） ==========

/**
 * 管理后台录入回款（admin 线下/储值卡回款）
 *
 * 设计对齐：staffApi.order.createRepayment（ticket-2 PR-A，staff 实现）
 *   - 双写：1 条 FY-HKD 凭证单 sale_orders 行 + 1~2 条 sale_order_payments 流水行
 *   - 线下：payments.change_type='回款' payment_method='线下' external_txn_id=银行回执 status='已支付' source_end='admin'
 *   - 储值卡：事务内锁 prepaid_cards.balance → 扣减 → INSERT card_transactions + payments.change_type='储值卡抵扣'
 *   - 基于 SUM(payments) 重算原单 paid_amount / prepaid_card_amount，付清翻 '已支付'
 *   - admin 端不接受线上支付（微信/支付宝），paymentMethod 限定 '线下' / '储值卡'
 *   - 幂等：本 ticket 简化，依赖前端防重复提交；'线下' external_txn_id 仅作审计凭证，不建唯一键
 *
 * 返回：{ success: true, data: { repaymentOrderId } } 或 { success: false, error: { code, message } }
 */
// 注：'use server' 文件不允许 export type/const 非函数（Next.js 限制）。
// 原 RecordPaymentResult 类型直接内联到 recordPayment 返回类型上。

// getRepayable：查询原单各购买子项的应付/已收/可回款额，供 record-payment-dialog 按子项录入。
export const getRepayable = withPermission(
  'sale_order:record_payment',
  async (
    session,
    saleOrderId: string,
  ): Promise<{
    mode: 'items' | 'order'
    items: Array<{ saleItemId: string; productName: string; saleAmount: string; received: string; refundedAmount: string; isRefunded: boolean; remaining: string }>
    remainingPayable: number
    cardBalance: number | null
    clientUserId: string | null
  }> => {
    const [order] = await db
      .select({
        storeId: saleOrders.storeId,
        status: saleOrders.status,
        totalAmount: saleOrders.totalAmount,
        prepaidCardAmount: saleOrders.prepaidCardAmount,
        payableAmount: saleOrders.payableAmount,
        received: saleOrders.received,
        clientUserId: saleOrders.clientUserId,
        saleOrderType: saleOrders.saleOrderType,
        isExperienceConversion: saleOrders.isExperienceConversion,
      })
      .from(saleOrders)
      .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
      .limit(1)
    if (!order) throw new Error('NOT_FOUND: 订单不存在或无权访问')
    if (!['部分支付', '待支付'].includes(order.status)) {
      throw new Error(`INVALID_STATE: 当前状态"${order.status}"不允许回款`)
    }
    if (order.isExperienceConversion) {
      throw new Error('INVALID_STATE: EXPERIENCE_CONVERSION_REPAYMENT_FORBIDDEN: 体验转换不允许补款')
    }

    const rows = await db
      .select()
      .from(saleItems)
      .where(and(eq(saleItems.saleOrderId, saleOrderId), eq(saleItems.itemDirection, '购买')))
    const refundMap = await getPerItemRefundedMap(saleOrderId)
    const items = rows.map((r) => {
      const refunded = refundMap.get(r.saleItemId) || 0
      // 已退行可回款额=0（行级口径，与 client/staff 一致）；received 为净额
      const remaining = refunded > 0 ? 0 : Math.round((Number(r.saleAmount) - Number(r.received)) * 100) / 100
      return {
        saleItemId: r.saleItemId,
        productName: r.productName || '-',
        saleAmount: r.saleAmount,
        received: r.received,
        refundedAmount: refunded.toFixed(2),
        isRefunded: refunded > 0,
        remaining: Math.max(0, remaining).toFixed(2),
      }
    })

    // 欠款 = total − received（= settleTarget − received，与 status 结清判定一致）。
    // received 按 I1 含储值卡抵扣，须用总额减；旧口径 payable(扣卡) − received(含卡) 会让含卡部分支付单算成无欠款。
    const remainingPayable = Math.round((Number(order.totalAmount) - Number(order.received)) * 100) / 100

    let cardBalance: number | null = null
    if (order.clientUserId) {
      const [card] = await db
        .select({ balance: prepaidCards.balance })
        .from(prepaidCards)
        .where(eq(prepaidCards.userId, order.clientUserId))
        .limit(1)
      cardBalance = card ? Number(card.balance) : 0
    }

    return {
      mode: order.saleOrderType === '转换单' ? 'order' : 'items',
      items,
      remainingPayable,
      cardBalance,
      clientUserId: order.clientUserId ?? null,
    }
  },
)

export const recordPayment = withPermission(
  'sale_order:record_payment',
  async (
    session,
    input: {
  saleOrderId: string
  repayAmount?: number
  paymentMethod: '线下' | '储值卡'
  externalTxnId?: string
  prepaidCardAmount?: number
  // 按子项定向回款：每行现金 repayAmount + 储值卡 prepaidCardAmount，写带 ref_sale_item_id 的 payment 行。
  // 未传时退回订单级单行（ref=null，按比例分摊），向后兼容。
  items?: Array<{ saleItemId: string; repayAmount?: number; prepaidCardAmount?: number }>
  note?: string
  // 前端为「本次回款意向」生成的幂等键（重试/误点复用同一值）；储值卡抵扣场景用作扣卡 external_ref 防重复扣卡。
  idempotencyKey?: string
    },
  ): Promise<
    | { success: true; data: { repaymentOrderId: string; refStatus: OrderStatus; refPaidAmount: string; refPrepaidCardAmount: string; idempotent?: boolean } }
    | { success: false; error: { code: string; message: string } }
  > => {
  // 入参归一 + 基本校验（Zod 在前端/Action 边界均可使用；此处做防御校验避免直接被调用时绕过）
  const saleOrderId = String(input.saleOrderId || '').trim()
  if (!saleOrderId) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '订单号不能为空' } }
  }
  const paymentMethod = input.paymentMethod
  if (paymentMethod !== '线下' && paymentMethod !== '储值卡') {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '支付方式仅支持 线下 / 储值卡' } }
  }

  // items[] 优先：归一化各子项金额并合计为订单级 repayAmount / prepaidCardAmount
  const repayItems = Array.isArray(input.items) && input.items.length > 0
    ? input.items
        .map((it) => ({
          saleItemId: String(it.saleItemId || ''),
          repayAmount: Math.round(Number(it.repayAmount || 0) * 100) / 100,
          prepaidCardAmount: Math.round(Number(it.prepaidCardAmount || 0) * 100) / 100,
        }))
        .filter((it) => it.saleItemId && (it.repayAmount > 0 || it.prepaidCardAmount > 0))
    : null
  const hasItems = !!(repayItems && repayItems.length > 0)

  // 已退行不可回款（行级口径，与 client/staff 一致）：按子项回款校验所选行未退款；
  // 整单回款遇订单有退款则要求按子项（避免非定向分摊误充已退行）
  const recordRefundMap = await getPerItemRefundedMap(saleOrderId)
  const orderHasRefund = [...recordRefundMap.values()].some((v) => Number(v) > 0)
  if (hasItems) {
    for (const it of repayItems!) {
      if ((recordRefundMap.get(it.saleItemId) || 0) > 0) {
        return { success: false, error: { code: 'INVALID_STATE', message: `子项 ${it.saleItemId} 已退款，不可再回款` } }
      }
    }
  } else if (orderHasRefund) {
    return { success: false, error: { code: 'INVALID_STATE', message: '本单存在已退款项目，请按子项回款未退款的项目' } }
  }

  const repayAmount = hasItems
    ? Math.round(repayItems!.reduce((s, it) => s + it.repayAmount, 0) * 100) / 100
    : Math.round(Number(input.repayAmount || 0) * 100) / 100
  const prepaidCardAmount = hasItems
    ? Math.round(repayItems!.reduce((s, it) => s + it.prepaidCardAmount, 0) * 100) / 100
    : Math.round(Number(input.prepaidCardAmount || 0) * 100) / 100
  if (!Number.isFinite(repayAmount) || repayAmount < 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '回款金额无效' } }
  }
  if (!Number.isFinite(prepaidCardAmount) || prepaidCardAmount < 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '储值卡抵扣金额无效' } }
  }
  const totalThisTime = Math.round((repayAmount + prepaidCardAmount) * 100) / 100
  if (totalThisTime <= 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '回款金额与储值卡抵扣不能都为 0' } }
  }

  // 储值卡付款方式下不应再传 repayAmount（语义是纯储值卡回款）
  if (paymentMethod === '储值卡' && repayAmount > 0) {
    return {
      success: false,
      error: {
        code: 'INVALID_PARAMS',
        message: '储值卡付款方式不应传回款金额（请通过储值卡抵扣字段传递）',
      },
    }
  }

  // externalTxnId 可选（保留作审计凭证：银行回执号/扫码流水号）。
  // 线下不再强制：线下现金行写 external_txn_id=NULL，不受 uq_sop_txn（partial WHERE NOT NULL）
  // 与 chk_sop_method_txn（仅约束微信/支付宝）约束。
  const externalTxnId = input.externalTxnId?.trim() || null

  // 幂等键（2026-06-29 防重复扣卡）：前端为本次回款意向生成 idempotencyKey，重试/误点复用同一值。
  // 仅储值卡抵扣场景（prepaidCardAmount>0）用作扣卡 external_ref —— 纯现金回款由 uq_sop_txn 守护、不需此键。
  // 缺失时退回旧 repaymentOrderId-based external_ref（向后兼容老前端，仅放弃幂等保护）。
  const idempotencyKey = input.idempotencyKey?.trim() || null
  const repayIdempRef = idempotencyKey && prepaidCardAmount > 0
    ? `card-repay-${saleOrderId}-${idempotencyKey}`
    : null

  // 事务：锁原单 + 校验 + 扣卡 + 插凭证单 + 插 payments + 重算原单
  let result: { repaymentOrderId: string; refStatus: OrderStatus; refPaidAmount: string; refPrepaidCardAmount: string; idempotent?: boolean }
  try {
    result = await db.transaction(async (tx) => {
      // 1) 锁原单 + 校验
      const lockRes = await tx.execute(sql`
        SELECT * FROM sale_orders WHERE sale_order_id = ${saleOrderId} FOR UPDATE
      `)
      const lockedRows = lockRes as unknown as any[]
      if (lockedRows.length === 0) {
        throw new ApiError('NOT_FOUND', 'REF_ORDER_NOT_FOUND: 原订单不存在')
      }
      const locked = lockedRows[0]

      // scope 保护：admin 跨门店免检；manager / finance 等 scoped 角色按 storeId 校验
      if (!isInScope(session, locked.store_id)) {
        throw new ApiError('PERMISSION_DENIED', 'OUT_OF_SCOPE: 该订单不在你的可见门店范围内')
      }

      // 寄存单 / 历史订单(legacy)是「一次性初始化」单，禁止任何事后资金变更 —— 不支持回款
      if (locked.sale_order_type === '寄存单') {
        throw new ApiError('INVALID_STATE', '寄存单不支持回款')
      }
      if (locked.legacy_source === 'workfine') {
        throw new ApiError('INVALID_STATE', '历史订单不支持回款')
      }
      if (locked.is_experience_conversion === true) {
        throw new ApiError('INVALID_STATE', 'EXPERIENCE_CONVERSION_REPAYMENT_FORBIDDEN: 体验转换不允许补款')
      }

      // 冻结闭环（Bug I）：订单有待审批退款时禁止回款（与 staff createRepayment 对齐，防 received 在 create→approve 间漂移）
      if (await hasPendingRefund(tx, saleOrderId)) {
        throw new ApiError('INVALID_STATE', 'REFUND_IN_PROGRESS: 该订单退款审批中，暂不可回款')
      }

      if (!['部分支付', '待支付'].includes(locked.status)) {
        throw new Error(`INVALID_STATE:${locked.status}`)
      }

      if (!locked.client_user_id && prepaidCardAmount > 0) {
        throw new ApiError('CLIENT_NOT_REGISTERED', '顾客未注册小程序，无法使用储值卡抵扣')
      }

      // 幂等预检（2026-06-29 防重复扣卡）：锁原单后查同 idempotencyKey 的 card-repay 扣款是否已落库。
      // 命中 → 整笔回款已处理（余额已扣、流水已记），直接返回当前状态、跳过本次扣卡/payments/received 全部逻辑。
      // 行锁（上面 SELECT ... FOR UPDATE）串行化同单请求，两次重试无竞态：第二次拿到锁时首次已 COMMIT 可见。
      if (repayIdempRef) {
        const dupRes = await tx.execute(sql`
          SELECT 1 FROM card_transactions WHERE external_ref = ${repayIdempRef} LIMIT 1
        `)
        if ((dupRes as unknown as Array<unknown>).length > 0) {
          return {
            repaymentOrderId: '',
            refStatus: locked.status as OrderStatus,
            refPaidAmount: Number(locked.received || 0).toFixed(2),
            refPrepaidCardAmount: Number(locked.prepaid_card_amount || 0).toFixed(2),
            idempotent: true,
          }
        }
      }

      // 2) 计算欠款：total - received（= settleTarget - received，与下方结清判定 line 3558 一致）。
      // received 按 I1 含储值卡抵扣，须用总额减；旧口径 payable(扣卡) − received(含卡) 会让含卡部分支付单
      // 算成无欠款 → 超额校验误拒。2026-04-26 sale-order-domain-refactor：paid_amount 列已 DROP，改用 received。
      // payable + prepaid 在「回款新增储值卡抵扣」时会破裂（见下方结清判定注释），故直接锚 total 单调正确。
      const origTotal = Number(locked.total_amount || 0)
      const origPaid = Number(locked.received || 0)
      const remainingPayable = Math.round((origTotal - origPaid) * 100) / 100

      // 3) 超额校验
      if (totalThisTime > remainingPayable + 0.001) {
        throw new ApiError('CONFLICT', `OVERPAY:${remainingPayable.toFixed(2)}: 本次回款金额超过订单欠款`)
      }

      // 3b) 按子项校验：逐项 (现金+储值卡) ≤ 该行可回款额(sale_amount - received)
      if (hasItems) {
        const itemRowsRes = await tx.execute(sql`
          SELECT sale_item_id, sale_amount::numeric AS sale_amount, received::numeric AS received
            FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买'
        `)
        const itemRows = itemRowsRes as unknown as any[]
        const itemMap = new Map(itemRows.map((r) => [r.sale_item_id, r]))
        for (const it of repayItems!) {
          const row = itemMap.get(it.saleItemId)
          if (!row) throw new ApiError('INVALID_PARAMS', `OVERPAY_ITEM:${it.saleItemId}:NOT_FOUND: 回款明细行不存在于该订单`)
          const itemRemaining = Math.round((Number(row.sale_amount) - Number(row.received)) * 100) / 100
          const itemThis = Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100
          if (itemThis > itemRemaining + 0.001) {
            throw new ApiError('CONFLICT', `OVERPAY_ITEM:${it.saleItemId}:${itemRemaining.toFixed(2)}: 该明细行回款金额超过可回款额`)
          }
        }
      }

      // 4) 生成 FY-HKD 凭证单号（advisory lock + 当日序号，前缀 FY-HKD-WX-YYMMDDNNNN）
      const idRows = await tx.execute(sql`
        WITH lock AS (
          SELECT pg_advisory_xact_lock(hashtext('sale_order_id_gen')::bigint)
        )
        SELECT 'FY-HKD-WX-' || to_char(NOW(), 'YYMMDD') ||
          LPAD(
            (SELECT COALESCE(MAX(
              CAST(NULLIF(SUBSTRING(sale_order_id FROM '.{4}$'), '') AS INTEGER)
            ), 0) + 1
            FROM sale_orders
            WHERE sale_order_id LIKE 'FY-HKD-WX-' || to_char(NOW(), 'YYMMDD') || '%'
            )::TEXT, 4, '0'
          ) AS id
        FROM lock
      `)
      const repaymentOrderId = (idRows as unknown as any[])[0]?.id as string
      if (!repaymentOrderId) throw new ApiError('INVALID_STATE', 'ORDER_ID_GEN_FAILED: 回款单号生成失败')

      // 5) 储值卡抵扣：锁余额 + 扣减 + 写 card_transactions
      if (prepaidCardAmount > 0) {
        const balRes = await tx.execute(sql`
          SELECT card_id, balance FROM prepaid_cards
          WHERE user_id = ${locked.client_user_id} FOR UPDATE
        `)
        const balRows = balRes as unknown as any[]
        if (balRows.length === 0) {
          throw new Error('INSUFFICIENT_BALANCE:NO_CARD')
        }
        const currentBalance = Number(balRows[0].balance)
        if (currentBalance + 0.001 < prepaidCardAmount) {
          throw new Error(`INSUFFICIENT_BALANCE:${currentBalance.toFixed(2)}`)
        }
        const cardId = balRows[0].card_id as string
        await tx.execute(sql`
          UPDATE prepaid_cards
          SET balance = balance - ${prepaidCardAmount.toFixed(2)}::numeric,
              updated_at = NOW()
          WHERE card_id = ${cardId}
        `)
        // ref_order_id 指向原销售单（FK 约束要求 ref_order_id 必须存在于 sale_orders；
        // 回款凭证单 FY-HKD 不再 INSERT 到 sale_orders，故用 saleOrderId 满足 FK）。
        // 幂等 external_ref：优先用前端 idempotencyKey 派生的稳定键（重试命中同一键 → 上方预检整笔跳过 / 唯一约束兜底）；
        // 缺失 idempotencyKey 时退回 repaymentOrderId-based（向后兼容，仅放弃幂等保护）。
        await tx.insert(cardTransactions).values({
          cardId,
          type: '扣款',
          amount: (-prepaidCardAmount).toFixed(2),
          refOrderId: saleOrderId,
          externalRef: repayIdempRef ?? `card-repay-${repaymentOrderId}`,
        })
      }

      // 2026-04-26 sale-order-domain-refactor：
      //   不再 INSERT FY-HKD 回款单（saleOrderType='回款单' 已删除），
      //   "回款"语义完全由 sale_order_payments[change_type='回款'] 表达。
      //   repaymentOrderId 仍生成（FY-HKD 编号格式保留用作业务流水编号 / 操作日志主键）。

      // 7) 向原销售单写 payments 流水 —— 款项记录合并为「一笔现金流动」，不按子项拆行：
      //    现金合并 1 行 '回款'（ref=null）+ 储值卡合并 1 行 '储值卡抵扣'（ref=null）。
      //    repayAmount / prepaidCardAmount 已是各子项合计（见上方 2799-2804）。
      //    子项定向（钱精确落选中卡）改由下方 7b 更新 sale_items.pending_received 承载，
      //    不再靠 payment.ref_sale_item_id —— 这样多子项回款共用一个交易号也不会撞 uq_sop_txn。
      // 回款事件主流水行 id（现金行优先；纯储值卡回款取储值卡抵扣行）—— 按回款逐笔分配的归属键
      let cashPaymentId: number | string | null = null
      let cardPaymentId: number | string | null = null
      if (repayAmount > 0) {
        const cashIns = await tx.insert(saleOrderPayments).values({
          saleOrderId,
          changeType: '回款',
          amount: repayAmount.toFixed(2),
          paymentMethod,
          externalTxnId,
          status: '已支付',
          sourceEnd: 'admin',
          paidAt: nowTs(),
          operatorEmployeeId: session.employeeId,
          note: input.note?.trim() || '管理后台录入回款',
        }).returning({ id: saleOrderPayments.id })
        cashPaymentId = cashIns[0]?.id ?? null
      }
      if (prepaidCardAmount > 0) {
        const cardIns = await tx.insert(saleOrderPayments).values({
          saleOrderId,
          changeType: '储值卡抵扣',
          amount: prepaidCardAmount.toFixed(2),
          paymentMethod: '储值卡',
          externalTxnId: null,
          status: '已支付',
          sourceEnd: 'admin',
          paidAt: nowTs(),
          operatorEmployeeId: session.employeeId,
          note: '管理后台录入回款-储值卡抵扣',
        }).returning({ id: saleOrderPayments.id })
        cardPaymentId = cardIns[0]?.id ?? null
      }
      // 线下/储值卡回款均即时已支付：现金行优先为主流水行，纯储值卡取抵扣行
      const primaryPaymentId = cashPaymentId || cardPaymentId

      // 7b) 子项定向：把「本次每张卡补多少」覆盖写入 sale_items.pending_received
      //     （2026-06-27 营业额分配重构：pending_received = 本次逐项实付，不再累加 received+refunded+delta）。
      //     非定向 capture 读 pending_received 作为权重；定向 capture 用 directedItems 不读此值。
      //     无 items[] 的订单级回款（hasItems=false）不动 pending，退回 untargeted 比例分摊（向后兼容）。
      if (hasItems) {
        const repayValues = sql.join(
          repayItems!.map(
            (it) =>
              sql`(${it.saleItemId}::varchar, ${(Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100).toFixed(2)}::numeric)`,
          ),
          sql`, `,
        )
        await tx.execute(sql`
          WITH repay (sale_item_id, delta) AS (VALUES ${repayValues})
          UPDATE sale_items si
          SET pending_received = COALESCE(rp.delta, 0),
              updated_at = NOW()
          FROM (SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买') ai
          LEFT JOIN repay rp ON rp.sale_item_id = ai.sale_item_id
          WHERE si.sale_item_id = ai.sale_item_id
        `)
      }

      // 8) 重算原单 received / refunded_amount / prepaid_card_amount + status
      //    2026-04-26 sale-order-domain-refactor：paid_amount 列已 DROP，统一改用 received
      //    received            = Σ(amount WHERE status='已支付' AND change_type IN ('首次支付','回款','储值卡抵扣'))
      //                            ※ 与 staff confirmOffline / createRepayment 跨端字面对齐；
      //                              received 含储值卡抵扣，paid_sessions SQL settled = received - refunded 才能取到上限。
      //    refunded_amount     = -Σ(amount WHERE status='已支付' AND change_type='退款')
      //    prepaid_card_amount = Σ(amount WHERE status='已支付' AND change_type='储值卡抵扣')
      const sumRes = await tx.execute(sql`
        SELECT
          COALESCE(SUM(CASE WHEN status = '已支付' AND change_type IN ('首次支付','回款','储值卡抵扣')
                            THEN amount::numeric ELSE 0 END), 0) AS new_received,
          COALESCE(SUM(CASE WHEN status = '已支付' AND change_type = '储值卡抵扣'
                            THEN amount::numeric ELSE 0 END), 0) AS new_prepaid,
          COALESCE(-SUM(CASE WHEN status = '已支付' AND change_type = '退款'
                            THEN amount::numeric ELSE 0 END), 0) AS new_refunded
        FROM sale_order_payments
        WHERE sale_order_id = ${saleOrderId}
      `)
      const sumRow = (sumRes as unknown as any[])[0]
      const newReceived = Math.round(Number(sumRow.new_received) * 100) / 100
      const newPrepaid = Math.round(Number(sumRow.new_prepaid) * 100) / 100
      const newRefunded = Math.round(Number(sumRow.new_refunded) * 100) / 100
      const settled = newReceived
      // 结清判定基准 = total_amount（固定锚）。received 含现金 + 储值卡抵扣（I1），达 total 即结清。
      // 原用 payable + origPrepaidSnapshot 在「回款新增储值卡抵扣」时破裂（payable 不随 prepaid 减少，
      // 多笔储值卡回款后 origPayable + origPrepaid > total 误判部分支付）。改锚 total 单调正确。
      // 充值单不进回款路径（一次性付清），total 锚无副作用。
      const settleTarget = Math.round(origTotal * 100) / 100
      const targetStatus: OrderStatus = settled + 0.001 >= settleTarget ? '已支付' : '部分支付'
      // paid_at 写北京墙钟字面（见 lib/db-time）：结清→NOW()；未结清→保留原值（paid_at = paid_at 无害）。
      // 原 ISO 字符串内插会让 postgres.js 走 UTC 字面落库（早 8h）；改 SQL 片段根治。
      const paidAtExpr = targetStatus === '已支付' ? nowTs() : sql`paid_at`

      const updRes = await tx.execute(sql`
        UPDATE sale_orders
        SET status = ${targetStatus},
            received = ${newReceived.toFixed(2)}::numeric,
            refunded_amount = ${newRefunded.toFixed(2)}::numeric,
            prepaid_card_amount = ${newPrepaid.toFixed(2)}::numeric,
            pending_prepaid_card_amount = 0,
            payable_amount = CASE
              WHEN sale_order_type IN ('销售单', '内部单', '转换单')
                THEN GREATEST(total_amount - ${newPrepaid.toFixed(2)}::numeric, 0)
              ELSE payable_amount
            END,
            paid_at = ${paidAtExpr},
            updated_at = NOW()
        WHERE sale_order_id = ${saleOrderId} AND status = ${locked.status}
      `)
      if (rowsAffected(updRes) === 0) {
        throw new ApiError('CONFLICT', 'CONCURRENT_CHANGED: 订单状态已变更，请刷新后重试')
      }

      // 9) customer_type 跃迁（仅在本次回款使订单结清，即翻为'已支付'时触发）
      // 与 staff confirmOffline / payNotify 三端对齐，保证 admin 财务补录回款
      // 也能驱动客户分类升级（修复 audit-15 P0-15-01 admin 三资金触发点跃迁缺失）。
      if (targetStatus === '已支付' && locked.client_user_id) {
        await recalcCustomerType(tx, locked.client_user_id)
      }

      // 10) 积分发放（修复 audit-15 P0-15-01：admin recordPayment 触发点缺失）
      //     无论本次是否结清都尝试 settle：链净额差值法天然幂等，
      //     可正确处理"分次回款只发增量积分"的场景
      await settlePointsSafe(tx, saleOrderId, 'admin.recordPayment')

      // 12) 按回款逐笔分配：捕获本次回款逐项可分配额 + 置回款待分配 + 汇总刷新订单分配状态。
      //     items[] 定向回款 → 逐项金额（现金+储值卡）即可分配额；否则非定向按剩余应付比例摊。
      //     必须在 recalcPaidSessionsForOrder 之前：新 STEP1 从 receipt 聚合 received。
      const directedForCapture = repayItems
        ? repayItems.map((it) => ({
            saleItemId: it.saleItemId,
            amount: Math.round((it.repayAmount + it.prepaidCardAmount) * 100) / 100,
          }))
        : null
      await capturePaymentAllocatables(tx, {
        salePaymentId: primaryPaymentId,
        saleOrderId,
        eventAmount: totalThisTime,
        directedItems: directedForCapture,
      })
      await refreshOrderAllocationRollup(tx, saleOrderId)

      // 11) paid_sessions 重算（ticket 2026-05-19）：received 增长 → paid_sessions 单调上升
      //     必须在 capture 之后：新 STEP1 从 receipt 聚合 received
      await recalcPaidSessionsForOrder(tx, saleOrderId)

      return {
        repaymentOrderId,
        refStatus: targetStatus,
        refPaidAmount: newReceived.toFixed(2),
        refPrepaidCardAmount: newPrepaid.toFixed(2),
      }
    })
  } catch (err: any) {
    const msg = err?.message as string | undefined
    if (msg?.includes('REF_ORDER_NOT_FOUND')) {
      return { success: false, error: { code: 'REF_ORDER_NOT_FOUND', message: '原订单不存在' } }
    }
    // 状态机拒绝（保留原行为：行 1895 throw new Error(`INVALID_STATE:${locked.status}`) 仍生效）
    if (msg?.startsWith('INVALID_STATE:') && !msg.includes('ORDER_ID_GEN_FAILED')) {
      const status = msg.split(':')[1] || ''
      return {
        success: false,
        error: { code: 'INVALID_STATE', message: `订单当前状态"${status}"不允许回款` },
      }
    }
    if (msg?.includes('CLIENT_NOT_REGISTERED')) {
      return { success: false, error: { code: 'CLIENT_NOT_REGISTERED', message: '顾客未注册小程序，无法使用储值卡抵扣' } }
    }
    const overpayItemMatch = msg?.match(/OVERPAY_ITEM:([^:]+):(.+)/)
    if (overpayItemMatch) {
      const itemId = overpayItemMatch[1]
      const detail = overpayItemMatch[2]
      return {
        success: false,
        error: detail === 'NOT_FOUND'
          ? { code: 'INVALID_PARAMS', message: `子项 ${itemId} 不属于本订单` }
          : { code: 'OVERPAY', message: `子项 ${itemId} 回款额超过该行可回款额（剩余 ¥${detail}）` },
      }
    }
    const overpayMatch = msg?.match(/OVERPAY:([\d.]+)/)
    if (overpayMatch) {
      const remaining = overpayMatch[1] || '0.00'
      return {
        success: false,
        error: { code: 'OVERPAY', message: `本次回款金额超过订单欠款（剩余 ¥${remaining}）` },
      }
    }
    if (msg?.includes('INSUFFICIENT_BALANCE:NO_CARD')) {
      return { success: false, error: { code: 'INSUFFICIENT_BALANCE', message: '顾客无储值卡账户' } }
    }
    if (msg?.startsWith('INSUFFICIENT_BALANCE:')) {
      const balance = msg.split(':')[1] || '0.00'
      return {
        success: false,
        error: { code: 'INSUFFICIENT_BALANCE', message: `储值卡余额不足（当前 ¥${balance}）` },
      }
    }
    if (msg?.includes('CONCURRENT_CHANGED')) {
      return { success: false, error: { code: 'CONCURRENT_CHANGED', message: '订单状态已变更，请刷新后重试' } }
    }
    if (msg?.includes('ORDER_ID_GEN_FAILED')) {
      return { success: false, error: { code: 'ORDER_ID_GEN_FAILED', message: '回款单号生成失败，请稍后重试' } }
    }
    if (pgErrorCode(err) === '23505') {
      // 款项合并后该路径已不再 INSERT sale_orders（单号段只 SELECT），唯一现实的 23505 = uq_sop_txn
      //（同订单同通道二次填相同交易号）。废弃旧「订单号冲突」措辞。
      return {
        success: false,
        error: {
          code: 'CONFLICT',
          message: pgErrorConstraint(err) === 'uq_sop_txn'
            ? '该交易号已在本订单录入过，请勿对同一笔款重复使用同一流水号'
            : '数据冲突，请刷新后重试',
        },
      }
    }
    console.error('[recordPayment] unexpected error:', err)
    // 兜底收口：任意 DB 错误（23xxx 等）只给通用提示，不回显原始 SQL（避免 Failed query 泄露前端）；
    // 非 DB 错误才保留 err.message 便于排查。
    if (pgErrorCode(err)) {
      return { success: false, error: { code: 'UNKNOWN', message: '录入回款失败：数据冲突或约束校验未通过，请刷新后重试' } }
    }
    return { success: false, error: { code: 'UNKNOWN', message: `录入回款失败：${err?.message || String(err)}` } }
  }

  // 幂等命中：首次回款已处理（余额已扣、操作日志已记），本次为重复提交 → 直接返回当前状态，
  // 不重复记日志 / 不 revalidate（首次成功已 revalidate）。
  if (result.idempotent) {
    return { success: true, data: result }
  }

  await logOperation(session, 'order.record_payment', 'sale_order', saleOrderId, {
    repaymentOrderId: result.repaymentOrderId,
    repayAmount: repayAmount.toFixed(2),
    paymentMethod,
    externalTxnId,
    prepaidCardAmount: prepaidCardAmount.toFixed(2),
    refStatus: result.refStatus,
    note: input.note?.trim() || null,
  })

  revalidatePath('/orders')
  revalidatePath(`/orders/${saleOrderId}`)
  return { success: true, data: result }
  },
)

// ========== 小程序码生成 ==========

const WX_CLIENT_APPID = process.env.WX_CLIENT_APPID || 'wx811eb4ded3dfba3f'
const WX_CLIENT_SECRET = process.env.WX_CLIENT_SECRET
const WXACODE_ENV_VERSION = process.env.WXACODE_ENV_VERSION || 'release'

let cachedToken: string | null = null
let tokenExpiresAt = 0

async function getClientAccessToken(forceRefresh = false): Promise<string> {
  if (!WX_CLIENT_SECRET) {
    throw new ApiError('INVALID_STATE', '未配置 WX_CLIENT_SECRET 环境变量')
  }
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_CLIENT_APPID}&secret=${WX_CLIENT_SECRET}`
  const res = await fetch(url)
  const data = await res.json()
  if (data.errcode) {
    throw new ApiError('INVALID_STATE', `获取微信 access_token 失败: ${data.errcode} ${data.errmsg}`)
  }
  cachedToken = data.access_token
  tokenExpiresAt = Date.now() + (data.expires_in - 300) * 1000
  return cachedToken!
}

/** 生成客户端小程序码，返回 base64 data URL */
export const generateOrderWxacode = withPermission(
  'sale_order:list',
  async (_session, saleOrderId: string): Promise<{ success: boolean; dataUrl?: string; message?: string }> => {
  if (!WX_CLIENT_SECRET) {
    return { success: false, message: '未配置小程序密钥' }
  }

  try {
    let token = await getClientAccessToken()
    let buffer = await requestWxacode(token, saleOrderId, 'pagesOrder/scan-pay/scan-pay')

    // 响应小于 1000 字节可能是错误 JSON
    if (buffer.byteLength < 1000) {
      const text = new TextDecoder().decode(buffer)
      try {
        const errData = JSON.parse(text)
        if (errData.errcode === 42001 || errData.errcode === 40001) {
          token = await getClientAccessToken(true)
          buffer = await requestWxacode(token, saleOrderId, 'pagesOrder/scan-pay/scan-pay')
          if (buffer.byteLength < 1000) {
            const retryErr = JSON.parse(new TextDecoder().decode(buffer))
            return { success: false, message: `生成失败: ${retryErr.errcode} ${retryErr.errmsg}` }
          }
        } else if (errData.errcode) {
          return { success: false, message: `生成失败: ${errData.errcode} ${errData.errmsg}` }
        }
      } catch {
        // 不是 JSON，当作正常图片
      }
    }

    const base64 = Buffer.from(buffer).toString('base64')
    return { success: true, dataUrl: `data:image/png;base64,${base64}` }
  } catch (err: any) {
    return { success: false, message: err.message || '生成小程序码失败' }
  }
  },
)

async function requestWxacode(token: string, scene: string, page: string): Promise<ArrayBuffer> {
  const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scene,
      page,
      check_path: false,
      env_version: WXACODE_ENV_VERSION,
      width: 430,
      auto_color: false,
      line_color: { r: 212, g: 167, b: 106 },
    }),
  })
  return res.arrayBuffer()
}
