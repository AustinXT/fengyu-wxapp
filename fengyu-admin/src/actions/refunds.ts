'use server'

import { db } from '@/db'
import { rowsAffected } from '@/lib/pg-rows'
import { saleOrders, saleItems, saleOrderPayments } from '@db/order'
import { productSkus } from '@db/product'
import { stores } from '@db/org'
import { staffWechatUsers, clientWechatUsers } from '@db/user'
import { and, desc, asc, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { revalidatePath } from 'next/cache'
import { scopeCondition, isInScope } from '@/lib/permissions'
import { withPermission, withAnyPermission } from '@/lib/with-permission'
import { assertOrderInScope } from '@/lib/scope-assert'
import { logOperation } from '@/lib/operation-log'
import { ApiError } from '@/lib/api-error'
import { determineMemberLevel, isDowngrade, type MemberLevel } from '../../../db/utils/member-level'
import { getMemberThreshold } from '@/lib/member-threshold'
import { getPointsToYuanRate } from '@/lib/system-config'
import { nowTs } from '@/lib/db-time'
import {
  buildRefundDetails,
  calculateUnusedQuantity,
  capRefundAmounts,
  computeItemOverpayRemainders,
  computeOverpayRemainder,
  isHandlingFeeInvalidForRefund,
  isZeroCashPaidSessionRefund,
  resolveRefundPaymentMethod,
  splitRefundByOriginalPayment,
  type RefundSourceItem,
} from '@/lib/refund'
import { cascadeRefund, notifyRefundCreated, notifyRefundResult } from '@/lib/refund-cascade'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { recalcPaidSessionsForOrder } from '@/lib/paid-sessions'
import { reconcileAllocationStatusAfterRefund } from '@/lib/payment-allocatable'
import type {
  OrderStatus,
  PaymentMethod,
  ProductType,
  SaleOrder,
  SaleOrderPayment,
  SalesCategory,
} from '@/lib/types'

// drizzle 0.45 alias() 返回 PgTableWithColumns<Required<Update<any,...>>>，与 .leftJoin() 期望签名不兼容；cast 回原表类型解锁 build
const operatorAlias = alias(staffWechatUsers, 'sop_operator') as unknown as typeof staffWechatUsers
const auditorAlias = alias(staffWechatUsers, 'sop_auditor') as unknown as typeof staffWechatUsers

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
//
// 退款不再创建 saleOrders[type='退款单']；改为写 sale_order_payments[change_type='退款']
// 行（refund_reason / ref_sale_item_id / session_count / audit_* 字段直接挂在主表）。
// "退款单"语义完全由 (sop.change_type='退款') 行表达。
// ─────────────────────────────────────────────────────────────────────────────

export interface RefundableItem {
  saleItemId: string
  productName: string
  productType: ProductType | null
  /** 当前 SKU 的展示单位；SKU 删除或历史数据缺失时按商品类型回退。 */
  unit: string
  unitRealPrice: number
  saleAmount: number
  unusedQuantity: number
  refundableAmount: number
  overpayRefundable: number
  quantity: number
  sessionCount: number | null
  remainingSessions: number | null
  pickedUpQuantity: number | null
}

export interface GetRefundableResult {
  items: RefundableItem[]
  origTotalAmount: number
  origPrepaidCardAmount: number
  origPaymentMethod: PaymentMethod
  /** 原订单顾客 ID；用于退款表单调用 estimateRefundOverdraft */
  clientUserId: string | null
  /** 行级多收余数合计；具体归属见 items[].overpayRefundable */
  overpayRefundable: number
  /** 净已收 = received − refundedAmount，前端展示「已收上限」用 */
  netReceived: number
}

export type CreateRefundResult =
  | {
      success: true
      data: {
        /** 主退款流水 ID（sale_order_payments.id），用于审批入口 */
        refundPaymentId: number
        refundByCard: number
        refundByOrigin: number
        finalRefundAmount: number
      }
    }
  | { success: false; error: { code: string; message: string } }

export type ApproveRefundResult =
  | {
      success: true
      data: {
        refundByCard: number
        refundByOrigin: number
        cascade: {
          voidedAllocations: number
          voidedCommissions: number
          refundedCoupons: number
          reversedPoints: number
          rolledBackPickups: number
        }
      }
    }
  | { success: false; error: { code: string; message: string } }

export type RejectRefundResult =
  | { success: true }
  | { success: false; error: { code: string; message: string } }

/**
 * 退款列表条目（聚合自 sale_order_payments[change_type='退款']）。
 *
 * 旧字段 saleOrderId 在 5→3 重构后已无独立"退款单 ID"，列表与详情统一以
 * sale_order_payments.id（主键）作为退款流水 ID。
 */
export interface RefundListItem {
  /** sale_order_payments.id（主键，退款流水 ID） */
  refundPaymentId: number
  /** 关联的原销售单 ID（即 sop.sale_order_id） */
  refSaleOrderId: string
  /** 退款流水状态（'待审批'/'已支付'/'已作废'）→ 前端映射展示 */
  status: '待审批' | '已支付' | '已作废' | '已退款' | '待支付'
  marketName: string | null
  storeId: string | null
  storeName: string | null
  customerName: string | null
  clientPhone: string | null
  /** 原始 sop.amount（负数） */
  amount: string
  refundReason: string | null
  refSaleItemId: string | null
  sessionCount: number | null
  /** 当前退款关联 SKU 的展示单位。 */
  unit: string
  /** 操作人（发起人） */
  operatorEmployeeId: string | null
  operatorName: string | null
  /** 审批人 */
  auditEmployeeId: string | null
  auditorName: string | null
  auditAt: string | null
  auditRemark: string | null
  paymentMethod: string
  createdAt: string
  paidAt: string | null
}

export interface RefundListFilters {
  /** 兼容旧前端：'待审批' / '已支付'（已通过）/ '已关闭'（驳回 = '已作废'）*/
  status?: '待审批' | '已支付' | '已关闭'
  page?: number
  pageSize?: number
}

export interface RefundListResult {
  refunds: RefundListItem[]
  total: number
  page: number
  pageSize: number
}

export interface RefundDetailResult {
  refund: RefundListItem
  origOrder: SaleOrder | null
  /** 同一原单上、所有 change_type='退款' 的流水（发起+审批+其他历史退款） */
  payments: SaleOrderPayment[]
}

export interface EstimateOverdraftResult {
  currentLevel: MemberLevel | null
  recomputedLevel: MemberLevel | null
  willDowngrade: boolean
  lockedUntilStatus: 'none' | 'in_lock' | 'expired'
  upgradedAt: string | null
  usedCouponValue: number
  usedPointsValue: number
  currentBenefitsValue: number
  newBenefitsValue: number
  benefitValueDiff: number
  /** 建议扣除额（元） = MIN(usedCouponValue + usedPointsValue, benefitValueDiff, refundAmount) */
  suggestedOverdraftDeduction: number
  detail: {
    usedCoupons: Array<{ couponId: string; templateId: string; discountValue: number; usedAt: string }>
    usedPoints: number
    grantedPoints: number
    pointsToYuanRate: number
  }
}

type RefundTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function reconcileOrderStatusAfterRefund(tx: RefundTx, saleOrderId: string): Promise<void> {
  await tx.execute(sql`
    WITH receipt_refunds AS (
      SELECT spir.sale_item_id,
             COALESCE(ABS(SUM(spir.amount::numeric)), 0) AS refunded
        FROM sale_payment_item_receipts spir
        JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
       WHERE spir.sale_order_id = ${saleOrderId}
         AND sop.sale_order_id = ${saleOrderId}
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
       WHERE sop.sale_order_id = ${saleOrderId}
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
       WHERE si.sale_order_id = ${saleOrderId}
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
     WHERE so.sale_order_id = ${saleOrderId}
       AND target.status IS NOT NULL
       AND so.status IN ('已支付', '已完成', '部分支付', '已退款')
       AND so.status IS DISTINCT FROM target.status
  `)
}

// ─────────────────────────────────────────────────────────────────────────────
// getRefundable：查询原单可退明细
// ─────────────────────────────────────────────────────────────────────────────

// 读：提单人（refund_create）和审批人（refund_approve）任一即可
export const getRefundable = withAnyPermission(
  ['sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, saleOrderId: string): Promise<GetRefundableResult> => {
  const [order] = await db
    .select({
      storeId: saleOrders.storeId,
      status: saleOrders.status,
      saleOrderType: saleOrders.saleOrderType,
      totalAmount: saleOrders.totalAmount,
      prepaidCardAmount: saleOrders.prepaidCardAmount,
      paymentMethod: saleOrders.paymentMethod,
      clientUserId: saleOrders.clientUserId,
      received: saleOrders.received,
      refundedAmount: saleOrders.refundedAmount,
    })
    .from(saleOrders)
    .where(and(eq(saleOrders.saleOrderId, saleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)

  if (!order) {
    throw new Error('NOT_FOUND: 原订单不存在或无权访问')
  }
  if (order.saleOrderType !== '销售单') {
    throw new Error('INVALID_STATE: 仅销售单支持退款')
  }
  if (!['已支付', '已完成', '部分支付'].includes(order.status)) {
    throw new Error(`INVALID_STATE: 当前状态"${order.status}"不允许退款`)
  }

  const rows = await db
    .select({
      item: saleItems,
      skuUnit: productSkus.unit,
    })
    .from(saleItems)
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .where(and(eq(saleItems.saleOrderId, saleOrderId), eq(saleItems.itemDirection, '购买')))

  // 先建 RefundSourceItem[]（computeOverpayRemainder 入参），再派生展示用 RefundableItem[]
  const srcItems: RefundSourceItem[] = rows.map(({ item }) => ({
    sale_item_id: item.saleItemId,
    sku_id: item.skuId,
    product_name: item.productName,
    product_type: item.productType as ProductType | null,
    session_count: item.sessionCount,
    remaining_sessions: item.remainingSessions,
    paid_sessions: item.paidSessions,
    unit_price: item.unitPrice,
    quantity: item.quantity,
    unit_real_price: item.unitRealPrice,
    sale_amount: item.saleAmount,
    received: item.received,
    picked_up_quantity: item.pickedUpQuantity,
    sales_category: item.salesCategory as SalesCategory | null,
    service_fee: item.serviceFee,
  }))

  const itemOverpayById = computeItemOverpayRemainders(srcItems)
  const items: RefundableItem[] = srcItems.map((src, index) => {
    const unused = calculateUnusedQuantity(src)
    const unitRealPrice = Number(src.unit_real_price)
    const refundableAmount = Math.round(unitRealPrice * unused * 100) / 100
    const overpayRefundable = Math.max(0, Number(itemOverpayById.get(src.sale_item_id) || 0))

    return {
      saleItemId: src.sale_item_id,
      productName: src.product_name || '-',
      productType: src.product_type,
      unit: rows[index].skuUnit ?? (src.product_type === '家居产品' ? '盒' : '次'),
      unitRealPrice,
      saleAmount: Number(src.sale_amount || 0),
      unusedQuantity: unused,
      refundableAmount,
      overpayRefundable,
      quantity: src.quantity,
      sessionCount: src.session_count,
      remainingSessions: src.remaining_sessions,
      pickedUpQuantity: src.picked_up_quantity,
    }
  })

  // 多收余数（overpay）：按 sale_item 行级 received 归属，汇总字段只供老前端展示。
  const overpayRefundable = computeOverpayRemainder(
    { received: order.received, refundedAmount: order.refundedAmount },
    srcItems,
  )
  const netReceived = Math.max(0, Number(order.received || 0) - Number(order.refundedAmount || 0))

  return {
    items,
    origTotalAmount: Number(order.totalAmount),
    origPrepaidCardAmount: Number(order.prepaidCardAmount),
    origPaymentMethod: order.paymentMethod as PaymentMethod,
    clientUserId: order.clientUserId ?? null,
    overpayRefundable,
    netReceived,
  }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// estimateRefundOverdraft：退款预判 + 超额权益扣除建议（读端，无副作用）
// ─────────────────────────────────────────────────────────────────────────────

interface LevelBenefitConfig {
  points?: number
  couponTemplateIds?: string[]
  messageTitle?: string
  messageBody?: string
}

async function loadUpgradeBenefitsMap(): Promise<Record<string, LevelBenefitConfig>> {
  try {
    const rows = await db.execute<{ value: string }>(sql`
      SELECT value FROM system_configs WHERE key = 'member_level_benefits' LIMIT 1
    `)
    const raw = (rows as unknown as Array<{ value: string }>)[0]?.value
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, LevelBenefitConfig>
  } catch {
    return {}
  }
}

function benefitsValue(
  cfg: LevelBenefitConfig | undefined,
  pointRate: number,
  tplValueById: Record<string, number>,
): number {
  if (!cfg) return 0
  const points = Number(cfg.points || 0) * pointRate
  const coupons = (cfg.couponTemplateIds || []).reduce(
    (sum, id) => sum + (tplValueById[id] || 0),
    0,
  )
  return points + coupons
}

// 读：提单人和审批人都需要估算超额信息
export const estimateRefundOverdraft = withAnyPermission(
  ['sale_order:refund_create', 'sale_order:refund_approve'],
  async (
    _session,
    params: {
      userId: string
      refundAmount: number
      originalSaleOrderId: string
    },
  ): Promise<EstimateOverdraftResult> => {
  const refundAmount = Math.max(0, Number(params.refundAmount) || 0)

  const [user] = await db
    .select({
      memberLevel: clientWechatUsers.memberLevel,
      memberLevelUpgradedAt: clientWechatUsers.memberLevelUpgradedAt,
      memberLevelLockedUntil: clientWechatUsers.memberLevelLockedUntil,
    })
    .from(clientWechatUsers)
    .where(eq(clientWechatUsers.userId, params.userId))
    .limit(1)

  const currentLevel = (user?.memberLevel ?? null) as MemberLevel | null
  const upgradedAt = user?.memberLevelUpgradedAt ?? null
  const lockedUntil = user?.memberLevelLockedUntil ?? null
  const now = new Date()
  const lockedUntilStatus: 'none' | 'in_lock' | 'expired' = !lockedUntil
    ? 'none'
    : new Date(lockedUntil) > now
      ? 'in_lock'
      : 'expired'

  const pointRate = await getPointsToYuanRate()
  const emptyDetail = { usedCoupons: [], usedPoints: 0, grantedPoints: 0, pointsToYuanRate: pointRate }

  if (!currentLevel) {
    return {
      currentLevel: null,
      recomputedLevel: null,
      willDowngrade: false,
      lockedUntilStatus,
      upgradedAt: upgradedAt ? upgradedAt.toISOString() : null,
      usedCouponValue: 0,
      usedPointsValue: 0,
      currentBenefitsValue: 0,
      newBenefitsValue: 0,
      benefitValueDiff: 0,
      suggestedOverdraftDeduction: 0,
      detail: emptyDetail,
    }
  }

  // 滚动 12 月消费；2026-04-26 sale-order-domain-refactor：
  //   - paid_amount 列已 DROP，统一改用 received - refunded_amount
  //   - saleOrderType 5→3：'退款单'/'回款单' 已迁至 sale_order_payments
  const spendRows = await db.execute<{ spend: string }>(sql`
    SELECT COALESCE(SUM(GREATEST((received::numeric) - (refunded_amount::numeric), 0)), 0) AS spend
    FROM sale_orders
    WHERE client_user_id = ${params.userId}
      AND sale_order_type IN ('销售单','转换单')
      AND received > 0
      AND paid_at >= (NOW() - INTERVAL '12 months')
  `)
  const currentSpend = Number((spendRows as unknown as Array<{ spend: string | number }>)[0]?.spend || 0)
  const projectedSpend = Math.max(0, currentSpend - refundAmount)

  const threshold = await getMemberThreshold()
  const recomputedLevel = determineMemberLevel(projectedSpend, threshold)

  const willDowngrade =
    isDowngrade(currentLevel, recomputedLevel) && lockedUntilStatus !== 'in_lock'

  const benefitsMap = await loadUpgradeBenefitsMap()
  const currentCfg = benefitsMap[currentLevel]
  const newCfg = recomputedLevel ? benefitsMap[recomputedLevel] : undefined
  const allTemplateIds = Array.from(
    new Set([...(currentCfg?.couponTemplateIds || []), ...(newCfg?.couponTemplateIds || [])]),
  )
  const tplRows = allTemplateIds.length
    ? ((await db.execute<{ template_id: string; discount_value: string }>(sql`
        SELECT template_id, discount_value FROM coupon_templates
        WHERE template_id IN (${sql.join(allTemplateIds.map((id) => sql`${id}`), sql`, `)})
      `)) as unknown as Array<{ template_id: string; discount_value: string }>)
    : []
  const tplValueById: Record<string, number> = {}
  for (const r of tplRows) tplValueById[r.template_id] = Number(r.discount_value || 0)

  const currentBenefitsValue = benefitsValue(currentCfg, pointRate, tplValueById)
  const newBenefitsValue = benefitsValue(newCfg, pointRate, tplValueById)
  const benefitValueDiff = Math.max(0, currentBenefitsValue - newBenefitsValue)

  if (!willDowngrade) {
    return {
      currentLevel,
      recomputedLevel,
      willDowngrade: false,
      lockedUntilStatus,
      upgradedAt: upgradedAt ? upgradedAt.toISOString() : null,
      usedCouponValue: 0,
      usedPointsValue: 0,
      currentBenefitsValue,
      newBenefitsValue,
      benefitValueDiff,
      suggestedOverdraftDeduction: 0,
      detail: emptyDetail,
    }
  }

  const upgradedAtThreshold = upgradedAt ?? new Date(0)
  const couponKeyPrefix = `cpn-up-${params.userId}-${currentLevel}-`

  const usedCouponRows = (await db.execute<{
    coupon_id: string
    template_id: string
    discount_value: string
    used_at: Date
  }>(sql`
    SELECT uc.coupon_id, uc.template_id, ct.discount_value, uc.used_at
    FROM user_coupons uc
    JOIN coupon_templates ct ON ct.template_id = uc.template_id
    WHERE uc.user_id = ${params.userId}
      AND uc.coupon_id LIKE ${couponKeyPrefix + '%'}
      AND uc.status = '已使用'
      AND uc.used_at >= ${upgradedAtThreshold}
  `)) as unknown as Array<{
    coupon_id: string
    template_id: string
    discount_value: string
    used_at: Date
  }>

  const usedCouponValue = usedCouponRows.reduce((s, r) => s + Number(r.discount_value || 0), 0)

  const externalRef = `member-upgrade-${params.userId}-${currentLevel}`
  const grantedRows = (await db.execute<{ granted: string }>(sql`
    SELECT COALESCE(SUM(amount), 0) AS granted
    FROM point_transactions
    WHERE user_id = ${params.userId} AND external_ref = ${externalRef}
  `)) as unknown as Array<{ granted: string }>
  const grantedPoints = Number(grantedRows[0]?.granted || 0)

  const usedRows = (await db.execute<{ used: string }>(sql`
    SELECT COALESCE(SUM(-amount), 0) AS used
    FROM point_transactions
    WHERE user_id = ${params.userId}
      AND amount < 0
      AND created_at >= ${upgradedAtThreshold}
  `)) as unknown as Array<{ used: string }>
  const usedPointsSince = Number(usedRows[0]?.used || 0)
  const usedUpgradePoints = Math.min(grantedPoints, usedPointsSince)
  const usedPointsValue = usedUpgradePoints * pointRate

  const suggestedOverdraftDeduction = Math.max(
    0,
    Math.min(
      Math.round((usedCouponValue + usedPointsValue) * 100) / 100,
      Math.round(benefitValueDiff * 100) / 100,
      refundAmount,
    ),
  )

  return {
    currentLevel,
    recomputedLevel,
    willDowngrade: true,
    lockedUntilStatus,
    upgradedAt: upgradedAt ? upgradedAt.toISOString() : null,
    usedCouponValue: Math.round(usedCouponValue * 100) / 100,
    usedPointsValue: Math.round(usedPointsValue * 100) / 100,
    currentBenefitsValue: Math.round(currentBenefitsValue * 100) / 100,
    newBenefitsValue: Math.round(newBenefitsValue * 100) / 100,
    benefitValueDiff: Math.round(benefitValueDiff * 100) / 100,
    suggestedOverdraftDeduction,
    detail: {
      usedCoupons: usedCouponRows.map((r) => ({
        couponId: r.coupon_id,
        templateId: r.template_id,
        discountValue: Number(r.discount_value || 0),
        usedAt: r.used_at ? new Date(r.used_at).toISOString() : '',
      })),
      usedPoints: usedUpgradePoints,
      grantedPoints,
      pointsToYuanRate: pointRate,
    },
  }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// createRefund：发起退款（写 sale_order_payments[change_type='退款', status='待审批']）
// ─────────────────────────────────────────────────────────────────────────────

export const createRefund = withPermission(
  'sale_order:refund_create',
  async (
    session,
    input: {
  refSaleOrderId: string
  items: Array<{ saleItemId: string; refundQuantity?: number; includeOverpay?: boolean }>
  refundReason: string
  handlingFee?: number
  /** 若 true，则按建议扣除超额权益；默认 true */
  applyOverdraftDeduction?: boolean
  /** 兼容旧前端：true 时把所选真实明细自身的行级余数并入退款；新前端应使用 items[].includeOverpay */
  includeOverpay?: boolean
    },
  ): Promise<CreateRefundResult> => {
  const refSaleOrderId = String(input.refSaleOrderId || '').trim()
  if (!refSaleOrderId) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '缺少原销售单号' } }
  }
  // items 允许为空：仅当 includeOverpay=true（多收余数单独退）。overpayRefundable>0 实质性校验在下方。
  if (!Array.isArray(input.items) || (input.items.length === 0 && !input.includeOverpay)) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '退款明细不能为空' } }
  }
  const refundReason = String(input.refundReason || '').trim()
  if (!refundReason) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '退款原因不能为空' } }
  }

  const [origOrder] = await db
    .select()
    .from(saleOrders)
    .where(and(eq(saleOrders.saleOrderId, refSaleOrderId), scopeCondition(session, saleOrders.storeId)))
    .limit(1)

  if (!origOrder) {
    return { success: false, error: { code: 'NOT_FOUND', message: '原订单不存在或无权访问' } }
  }
  // 历史订单（WorkFine 核对补登）不支持退款（无 sale_items 天然无可退项，补显式拦截防绕过）
  if (origOrder.legacySource === 'workfine') {
    return { success: false, error: { code: 'INVALID_STATE', message: '历史订单不支持退款' } }
  }
  if (origOrder.saleOrderType !== '销售单') {
    if (origOrder.saleOrderType === '充值单') {
      return {
        success: false,
        error: {
          code: 'INVALID_STATE',
          message: '该订单为充值卡订单，退款请在员工端 → 充值卡 → 退款审批 发起',
        },
      }
    }
    return { success: false, error: { code: 'INVALID_STATE', message: '仅销售单支持退款' } }
  }
  if (!['已支付', '已完成', '部分支付'].includes(origOrder.status)) {
    return {
      success: false,
      error: { code: 'INVALID_STATE', message: `原订单状态"${origOrder.status}"不允许退款` },
    }
  }
  if (!isInScope(session, origOrder.storeId)) {
    return { success: false, error: { code: 'PERMISSION_DENIED', message: '无权操作该门店订单' } }
  }

  // in-flight 唯一性：同一原单只允许一笔 status='待审批' 的退款
  const inflight = await db
    .select({ id: saleOrderPayments.id })
    .from(saleOrderPayments)
    .where(
      and(
        eq(saleOrderPayments.saleOrderId, refSaleOrderId),
        eq(saleOrderPayments.changeType, '退款'),
        eq(saleOrderPayments.status, '待审批'),
      ),
    )
    .limit(1)
  if (inflight.length > 0) {
    return { success: false, error: { code: 'CONFLICT', message: '存在未完结退款申请，请先处理' } }
  }

  // P 前置校验（Bug P）：有未终结服务单（待服务/服务中/待客户确认）时禁止退款，否则退款压低 paid_sessions
  // 会让该服务单 confirm 卡死、员工提成丢失（孤儿服务单）。两端镜像 staff order.js。
  const openSvcRows = await db.execute(sql`
    SELECT 1 FROM service_orders so2
      JOIN service_items sit ON sit.service_order_id = so2.service_order_id
      JOIN sale_items si ON si.sale_item_id = sit.sale_item_id
     WHERE si.sale_order_id = ${refSaleOrderId} AND so2.status IN ('待服务','服务中','待客户确认') LIMIT 1
  `)
  if ((openSvcRows as unknown as unknown[]).length > 0) {
    return { success: false, error: { code: 'INVALID_STATE', message: '该订单有未完成的服务单，请先完成或取消后再退款' } }
  }

  const origRows = await db
    .select()
    .from(saleItems)
    .where(and(eq(saleItems.saleOrderId, refSaleOrderId), eq(saleItems.itemDirection, '购买')))

  const sourceItems: RefundSourceItem[] = origRows.map((r) => ({
    sale_item_id: r.saleItemId,
    sku_id: r.skuId,
    product_name: r.productName,
    product_type: r.productType as ProductType | null,
    session_count: r.sessionCount,
    remaining_sessions: r.remainingSessions,
    paid_sessions: r.paidSessions,
    unit_price: r.unitPrice,
    quantity: r.quantity,
    unit_real_price: r.unitRealPrice,
    sale_amount: r.saleAmount,
    received: r.received,
    picked_up_quantity: r.pickedUpQuantity,
    sales_category: r.salesCategory as SalesCategory | null,
    service_fee: r.serviceFee,
  }))

  const itemOverpayById = computeItemOverpayRemainders(sourceItems)
  const requestItems = input.items.map((it) => ({
    saleItemId: String(it.saleItemId || ''),
    refundQuantity: it.refundQuantity,
    includeOverpay: it.includeOverpay === true,
  }))
  if (input.includeOverpay) {
    if (requestItems.length === 0) {
      const candidates = sourceItems
        .filter((it) => Math.max(0, Number(itemOverpayById.get(it.sale_item_id) || 0)) > 0)
      if (candidates.length === 1) {
        requestItems.push({
          saleItemId: candidates[0].sale_item_id,
          refundQuantity: 0,
          includeOverpay: true,
        })
      } else if (candidates.length > 1) {
        return {
          success: false,
          error: { code: 'INVALID_PARAMS', message: '多收余数需选择所属商品子项后退款' },
        }
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
    return { success: false, error: { code: 'INVALID_PARAMS', message: '退款明细不能为空' } }
  }

  let refundDetails: ReturnType<typeof buildRefundDetails>['refundDetails']
  let totalRefund: number
  try {
    const built = buildRefundDetails(sourceItems, requestItems)
    refundDetails = built.refundDetails
    totalRefund = built.totalRefund
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('INVALID_PARAMS:')) {
      return { success: false, error: { code: 'INVALID_PARAMS', message: msg.replace(/^INVALID_PARAMS:\s*/, '') } }
    }
    if (msg.startsWith('INVALID_STATE:')) {
      return { success: false, error: { code: 'INVALID_STATE', message: msg.replace(/^INVALID_STATE:\s*/, '') } }
    }
    return { success: false, error: { code: 'UNKNOWN', message: msg } }
  }

  const fee = Math.max(0, Number(input.handlingFee) || 0)
  // 修复（Bug R 手续费虚留次数）：fee ≥ 疗程卡单次价时 recalcPaidSessions 会多留 floor(fee/price) 次。
  // 限制 fee < 最小正价疗程卡单次价，保证 paid_sessions 推导无偏；0 元赠送项/家居不受影响。两端镜像 staff order.js。
  if (isHandlingFeeInvalidForRefund(refundDetails, fee)) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '手续费不能超过单次服务价格' } }
  }
  const isZeroCashItemRefund = isZeroCashPaidSessionRefund(refundDetails, fee, totalRefund)
  let finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
  if (finalRefundAmount <= 0 && !isZeroCashItemRefund) {
    return { success: false, error: { code: 'INVALID_STATE', message: '无可退项' } }
  }

  // 退款上限 = max(sale_order_payments 流水净额, origOrder.received)（与 staffApi createRefund 对齐）。
  // 部分支付订单按未使用次数×unit_real_price 算出的退款额可能远超实付，需封顶；流水净额含储值卡抵扣，
  // received 兜底（流水缺失单），取 max 避免误拒。
  // 超限处理（2026-06-24 调整）：疗程卡强制整卡全退、数量不可调 → 截断退款额到 cap（仅退已付、整卡仍作废）；
  // 家居数量可调 → 仍拒绝让店长减少退款数量。详见下方 if 分支。
  const paymentsNetRows = await db.execute<{ net: string }>(sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS net
    FROM sale_order_payments
    WHERE sale_order_id = ${refSaleOrderId} AND status = '已支付'
  `)
  const paymentsNet = Number(
    (paymentsNetRows as unknown as Array<{ net: string | number }>)[0]?.net || 0,
  )
  // 修复（Bug A 重复退款）：received 是不减的毛实收，必须减去 refundedAmount 得净可退；
  // 否则全额退后 refundCap 仍 = received → 可无限重复全额退款。paymentsNet 已含退款负数。两端镜像 staff order.js。
  const refundCap = Math.max(paymentsNet, Number(origOrder.received || 0) - Number(origOrder.refundedAmount || 0))
  if (finalRefundAmount > refundCap + 0.001) {
    // 疗程卡强制整卡全退、退款数量不可调（buildRefundDetails）：部分支付订单整卡值 > 净已收时，
    // 直接拒绝会导致永远无法退款。改为截断到 cap（只退已付部分）、仍作废整卡（数量不变），
    // 逐项 refundAmount 等比缩到 targetGross，保 note/级联冲销/STEP1.5 净额扣减一致。两端镜像 staff order.js。
    // 家居产品数量可调，无疗程卡项时仍拒绝，让店长减少退款数量（保持数量↔金额自洽）。
    const hasCourseCard = refundDetails.some((d) => d.productType === '疗程卡')
    if (!hasCourseCard) {
      return {
        success: false,
        error: { code: 'INVALID_STATE', message: '退款金额超过订单可退余额，请减少退款数量' },
      }
    }
    const targetGross = Math.max(0, Math.round((refundCap + fee) * 100) / 100)
    totalRefund = capRefundAmounts(refundDetails, totalRefund, targetGross)
    finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
    if (finalRefundAmount <= 0 && !isZeroCashItemRefund) {
      return { success: false, error: { code: 'INVALID_STATE', message: '无可退项' } }
    }
  }

  const overpayAmount = Math.round(
    Math.min(
      totalRefund,
      refundDetails.reduce((sum, d) => sum + Math.max(0, Number(d.overpayAmount || 0)), 0),
    ) * 100,
  ) / 100

  const applyOverdraft = input.applyOverdraftDeduction !== false
  let overdraftDeduction = 0
  if (finalRefundAmount > 0 && applyOverdraft && origOrder.clientUserId) {
    const estimate = await estimateRefundOverdraft({
      userId: origOrder.clientUserId,
      refundAmount: finalRefundAmount,
      originalSaleOrderId: refSaleOrderId,
    })
    if (estimate.willDowngrade && estimate.suggestedOverdraftDeduction > 0) {
      overdraftDeduction = estimate.suggestedOverdraftDeduction
    }
  }

  const adjustedRefundAmount = Math.max(
    0,
    Math.round((finalRefundAmount - overdraftDeduction) * 100) / 100,
  )

  const origPrepaidCardAmount = Number(origOrder.prepaidCardAmount || 0)
  const origTotalAmount = Number(origOrder.totalAmount || 0)
  const { refundByCard, refundByOrigin } = splitRefundByOriginalPayment(
    adjustedRefundAmount,
    origPrepaidCardAmount,
    origTotalAmount,
  )

  const refundPaymentMethod = resolveRefundPaymentMethod(origOrder.paymentMethod)

  // 部分退款时关联具体 sale_item（多行退款时取首行；整单退款保留 null）。
  // 历史 overpay 哨兵行不计入（refSaleItemId='OVERPAY' 非真实品项，写入会违反 FK）。
  const realDetails = refundDetails.filter((d) => !d.isOverpay)
  const primaryRefSaleItemId = realDetails.length === 1 ? realDetails[0].refSaleItemId : null
  const primarySessionCount =
    realDetails.length === 1 ? realDetails[0].sessionCount ?? realDetails[0].quantity : null

  // 整单全退判定（Bug Q/M）：所有购买项都在本次退款且全退 → cascade 通道3（券）才回滚
  const isWholeOrderRefund = sourceItems.length > 0 && sourceItems.every((oi) =>
    refundDetails.some((d) => d.refSaleItemId === oi.sale_item_id && d.isFullItemRefund),
  )
  // note 存 JSON（含展示字段 + 逐 item 明细），approveRefund 据此逐 item 级联（Bug Q/M）。两端对齐 staff note。
  const paymentNote = JSON.stringify({
    refundByCard,
    refundByOrigin,
    handlingFee: fee,
    overdraftDeduction,
    isWholeOrderRefund,
    overpayAmount,
    items: refundDetails.map((d) => ({
      refSaleItemId: d.refSaleItemId,
      quantity: d.quantity,
      refundAmount: d.refundAmount,
      productType: d.productType,
      saleAmount: d.saleAmount,
      isFullItemRefund: d.isFullItemRefund,
      overpayAmount: d.overpayAmount || 0,
      isOverpay: d.isOverpay === true,
    })),
  })

  let refundPaymentId: number
  try {
    refundPaymentId = await db.transaction(async (tx) => {
      // 主流水：按整笔金额写一行 status='待审批'，approveRefund 时按拆分（储值卡+原通道）做实际扣减。
      // chk_sop_amount_sign 要求退款 amount<=0；0 元退项也走同一审批流水。
      const totalAmountSign = -adjustedRefundAmount

      const [paymentRow] = await tx
        .insert(saleOrderPayments)
        .values({
          saleOrderId: refSaleOrderId,
          changeType: '退款',
          amount: totalAmountSign.toFixed(2),
          paymentMethod:
            refundByCard > 0 && refundByOrigin === 0 ? '储值卡' : refundPaymentMethod,
          externalTxnId: null,
          status: '待审批',
          sourceEnd: 'admin',
          operatorEmployeeId: session.employeeId,
          note: paymentNote || null,
          refundReason,
          refSaleItemId: primaryRefSaleItemId,
          sessionCount: primarySessionCount,
        })
        .returning({ id: saleOrderPayments.id })

      if (!paymentRow) throw new ApiError('INVALID_STATE', 'PAYMENT_INSERT_FAILED: 退款流水写入失败')

      return paymentRow.id
    })
    // ✅ Bug G12：通知移出事务 —— 避免 CloudBase 消息推送/DB 瞬态抖动时 INSERT messages 失败回滚整笔退款。
    // 事务已提交，通知失败只记日志，不影响退款主流程。
    try {
      await notifyRefundCreated(db, {
        paymentId: refundPaymentId,
        saleOrderId: refSaleOrderId,
        storeId: origOrder.storeId,
        operatorId: session.employeeId,
        amount: adjustedRefundAmount,
        customerName: origOrder.customerName,
      })
    } catch (notifyErr) {
      console.error('[createRefund] notifyRefundCreated failed:', notifyErr)
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // 修复（Bug S）：drizzle 0.45 把 pg 错误码包进 err.cause；用 pgErrorCode/pgErrorConstraint 读取，否则永不命中 → 落 UNKNOWN
    if (pgErrorCode(err) === '23505' && pgErrorConstraint(err) === 'uq_sop_status_audit') {
      return { success: false, error: { code: 'CONFLICT', message: '存在未完结退款申请，请先处理' } }
    }
    if (msg.includes('PAYMENT_INSERT_FAILED')) {
      return { success: false, error: { code: 'INVALID_STATE', message: '退款流水写入失败' } }
    }
    console.error('[createRefund] unexpected error:', err)
    return { success: false, error: { code: 'UNKNOWN', message: '创建退款失败，请稍后重试' } }
  }

  await logOperation(session, 'refund.create', 'sale_order_payment', String(refundPaymentId), {
    refSaleOrderId,
    finalRefundAmount: finalRefundAmount.toFixed(2),
    adjustedRefundAmount: adjustedRefundAmount.toFixed(2),
    refundByCard: refundByCard.toFixed(2),
    refundByOrigin: refundByOrigin.toFixed(2),
    handlingFee: fee.toFixed(2),
    overdraftDeduction: overdraftDeduction.toFixed(2),
    refundReason,
  })

  revalidatePath('/refunds')
  revalidatePath(`/orders/${refSaleOrderId}`)
  return {
    success: true,
    data: { refundPaymentId, refundByCard, refundByOrigin, finalRefundAmount },
  }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// approveRefund：审批通过 — CAS 翻状态 + 5 通道 cascade + 重算原单
// ─────────────────────────────────────────────────────────────────────────────

// 写：审批通过（仅 manager 持有 refund_approve）
// 2026-06-24 退款联级重构：移除「原路退款经拉卡拉退回」逻辑——全部走线下退款，
// 不调拉卡拉/微信原路退款接口；非储值卡部分（refundByOrigin）由门店线下退现金。

export const approveRefund = withPermission(
  'sale_order:refund_approve',
  async (session, refundPaymentId: number | string): Promise<ApproveRefundResult> => {
  const idNum = Number(refundPaymentId)
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '缺少退款流水 ID' } }
  }

  // 预读：取 sop（用于 cascade params + scope 校验 + 拆分回款）
  const [pre] = await db
    .select({
      payment: saleOrderPayments,
      orderStoreId: saleOrders.storeId,
      orderClientUserId: saleOrders.clientUserId,
      orderTotalAmount: saleOrders.totalAmount,
      orderPrepaidCardAmount: saleOrders.prepaidCardAmount,
      orderSaleOrderType: saleOrders.saleOrderType,
      orderReceived: saleOrders.received,
      orderRefundedAmount: saleOrders.refundedAmount,
    })
    .from(saleOrderPayments)
    .leftJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .where(eq(saleOrderPayments.id, idNum))
    .limit(1)

  if (!pre || !pre.payment) {
    return { success: false, error: { code: 'NOT_FOUND', message: '退款记录不存在' } }
  }
  if (pre.payment.changeType !== '退款') {
    return { success: false, error: { code: 'INVALID_STATE', message: '该流水非退款类型' } }
  }
  if (pre.payment.status !== '待审批') {
    return {
      success: false,
      error: { code: 'INVALID_STATE', message: `当前状态"${pre.payment.status}"不允许审批` },
    }
  }
  if (!pre.orderStoreId || !pre.payment.saleOrderId) {
    return { success: false, error: { code: 'NOT_FOUND', message: '原销售单不存在' } }
  }
  // 跨端守卫：充值单退款必须走员工端（按"退剩余余额"扣 prepaid_cards.balance），
  // admin 销售单退款链路（cascadeRefund + splitRefundByOriginalPayment）会让余额完全不动
  if (pre.orderSaleOrderType === '充值单') {
    return {
      success: false,
      error: {
        code: 'INVALID_STATE',
        message: '充值卡退款请在员工端审批（员工端 → 充值卡 → 退款审批）',
      },
    }
  }
  // scope 守卫：assertOrderInScope 统一三端语义（详见 lib/scope-assert.ts）
  try {
    await assertOrderInScope(session, pre.payment.saleOrderId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('PERMISSION_DENIED:')) {
      return { success: false, error: { code: 'PERMISSION_DENIED', message: '无权操作该门店退款' } }
    }
    throw err
  }

  const refSaleOrderId = pre.payment.saleOrderId
  const refundAmount = Math.abs(Number(pre.payment.amount || 0))

  // G 复校：审批前重算可退余额（本笔仍待审批，SUM 已支付自动排除），防 create→approve 间余额变化导致超退。两端镜像 staff order.js。
  const capNowRes = await db.execute<{ net: string }>(sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS net FROM sale_order_payments
    WHERE sale_order_id = ${refSaleOrderId} AND status = '已支付'
  `)
  const paymentsNetNow = Number((capNowRes as unknown as Array<{ net: string | number }>)[0]?.net || 0)
  const refundCapNow = Math.max(paymentsNetNow, Number(pre.orderReceived || 0) - Number(pre.orderRefundedAmount || 0))
  if (refundAmount > refundCapNow + 0.001) {
    return { success: false, error: { code: 'INVALID_STATE', message: '订单可退余额已变化，请刷新后重新发起退款' } }
  }

  const origPrepaidCardAmount = Number(pre.orderPrepaidCardAmount || 0)
  const origTotalAmount = Number(pre.orderTotalAmount || 0)
  const { refundByCard, refundByOrigin } = splitRefundByOriginalPayment(
    refundAmount,
    origPrepaidCardAmount,
    origTotalAmount,
  )

  let cascade = {
    voidedAllocations: 0,
    voidedCommissions: 0,
    refundedCoupons: 0,
    revokedShareGiftCoupons: 0,
    reversedPoints: 0,
    rolledBackPickups: 0,
  }

  try {
    cascade = await db.transaction(async (tx) => {
      // paid_at / audit_at 写北京墙钟字面（见 lib/db-time）：原 new Date().toISOString() 落 UTC 字面早 8h。

      // 1) CAS 翻状态 + 同一条 UPDATE 写审批人：仅 '待审批' → '已支付'
      const updRes = await tx.execute(sql`
        UPDATE sale_order_payments
           SET status = '已支付',
               paid_at = ${nowTs()},
               audit_employee_id = ${session.employeeId},
               audit_at = ${nowTs()}
         WHERE id = ${idNum} AND status = '待审批'
      `)
      if (rowsAffected(updRes) === 0) {
        throw new ApiError('CONFLICT', 'CONCURRENT_CHANGED: 退款状态已变更，请刷新后重试')
      }

      // 3) 重算原单 refunded_amount = -SUM(已支付退款 amount)
      // CAS-EXEMPT: 仅累加 refunded_amount，status 由其他路径（recordPayment 等）另行 CAS
      await tx.execute(sql`
        UPDATE sale_orders so
           SET refunded_amount = COALESCE((
                 SELECT -SUM(sop.amount::numeric) FROM sale_order_payments sop
                 WHERE sop.sale_order_id = so.sale_order_id
                   AND sop.change_type = '退款'
                   AND sop.status = '已支付'
               ), 0),
               updated_at = NOW()
         WHERE so.sale_order_id = ${refSaleOrderId}
      `)

      // 4) 储值卡回冲通道（已退役 2026-06-28）：
      //    退款策略改为「全部走现金」（splitRefundByOriginalPayment 恒返回 refundByCard=0），
      //    故 refundByCard 恒为 0、回冲分支永不触发，余额完全不动。
      //    退款只动金额不扣 remaining_sessions —— 退后可消费次数由 paid_sessions 闸门约束，
      //    service.js 核销条件 (已用+本次)≤paid_sessions 自动拦截已退次数；与 staff/clientApi 一致。
      //    退款次数上限已在 createRefund 处由 calculateUnusedQuantity≤remaining 约束。
      //    两端镜像 staff order.js。若未来恢复按储值卡占比拆分退款，在此重建回冲逻辑。
      const refSaleItemId = pre.payment.refSaleItemId ?? null
      const sessionCount = pre.payment.sessionCount ?? null

      // 5) 级联回滚（Bug Q/M）：从 note.items 读本次退款明细，逐 item 级联，仅全退 item 作废分配/提成
      let cascadeItems: Array<{ saleItemId: string; sessionCount: number | null; refundAmount: number | null; isFullItemRefund: boolean; isOverpay?: boolean }> = []
      let cascadeWholeOrder = false
      try {
        const noteObj = pre.payment.note ? JSON.parse(pre.payment.note) : null
        if (noteObj && Array.isArray(noteObj.items)) {
          cascadeItems = noteObj.items.map(
            (it: { refSaleItemId: string; quantity: number; refundAmount?: number; isFullItemRefund?: boolean; isOverpay?: boolean }) => ({
              saleItemId: it.refSaleItemId,
              sessionCount: it.quantity,
              refundAmount: it.refundAmount ?? null,
              isFullItemRefund: !!it.isFullItemRefund,
              isOverpay: it.isOverpay === true,
            }),
          )
          cascadeWholeOrder = !!noteObj.isWholeOrderRefund
        }
      } catch {
        cascadeItems = []
      }
      // 兜底（老退款行无 note.items）：用 refSaleItemId 单 item；为空则 cascade 内部兜底整单
      if (cascadeItems.length === 0 && refSaleItemId) {
        cascadeItems = [{ saleItemId: refSaleItemId, sessionCount, refundAmount, isFullItemRefund: true }]
      }
      const result = await cascadeRefund(tx, {
        saleOrderId: refSaleOrderId,
        refundPaymentId: idNum,
        items: cascadeItems,
        isWholeOrderRefund: cascadeWholeOrder,
        refundReason: pre.payment.refundReason ?? '',
      })

      // 5.1) paid_sessions 重算（ticket 2026-05-19，D3=A）：refunded_amount 增长 → settled 下降
      // 若新 paid_sessions < 已消费次数，抛 CONFLICT 阻止退款
      await recalcPaidSessionsForOrder(tx, refSaleOrderId)
      await reconcileAllocationStatusAfterRefund(tx, refSaleOrderId)
      await reconcileOrderStatusAfterRefund(tx, refSaleOrderId)

      // 6) 重算顾客历史消费档位
      if (pre.orderClientUserId) {
        await refreshSpendingTierTx(tx, pre.orderClientUserId)
      }

      // 7) 通知发起人审批通过（Bug C；自审降噪）
      if (pre.payment.operatorEmployeeId && pre.payment.operatorEmployeeId !== session.employeeId) {
        await notifyRefundResult(tx, {
          paymentId: idNum,
          saleOrderId: refSaleOrderId,
          recipientEmployeeId: pre.payment.operatorEmployeeId,
          approved: true,
          amount: refundAmount,
        })
      }

      return result
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('CONCURRENT_CHANGED')) {
      return { success: false, error: { code: 'CONFLICT', message: '退款状态已变更，请刷新后重试' } }
    }
    if (msg.includes('INSUFFICIENT_SESSIONS')) {
      return { success: false, error: { code: 'INVALID_STATE', message: '剩余次数不足，无法退款' } }
    }
    if (msg.includes('CARD_UPSERT_FAILED')) {
      return { success: false, error: { code: 'INVALID_STATE', message: '储值卡回冲失败' } }
    }
    if (msg.includes('PAID_SESSIONS_UNDERFLOW')) {
      return { success: false, error: { code: 'CONFLICT', message: '该订单已有消费次数，本次退款会使已支付次数低于已消费次数，请先取消相关服务单回滚消费再退款' } }
    }
    console.error('[approveRefund] unexpected error:', err)
    return { success: false, error: { code: 'UNKNOWN', message: '审批退款失败，请稍后重试' } }
  }

  // 2026-06-24 全部走线下退款：不再调拉卡拉原路退款。
  // 2026-06-28 退款全走现金（refundByCard 恒为 0），全额由门店线下退现金，不再回冲储值卡余额。

  await logOperation(session, 'refund.approve', 'sale_order_payment', String(idNum), {
    refSaleOrderId,
    refundByCard: refundByCard.toFixed(2),
    refundByOrigin: refundByOrigin.toFixed(2),
    cascade,
  })

  revalidatePath('/refunds')
  revalidatePath(`/refunds/${idNum}`)
  if (refSaleOrderId) revalidatePath(`/orders/${refSaleOrderId}`)
  revalidatePath('/allocations')
  return { success: true, data: { refundByCard, refundByOrigin, cascade } }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// rejectRefund：驳回退款 — CAS '待审批' → '已作废' + 写审批意见
// ─────────────────────────────────────────────────────────────────────────────

// 写：驳回（仅 manager 持有 refund_approve）
export const rejectRefund = withPermission(
  'sale_order:refund_approve',
  async (
    session,
    refundPaymentId: number | string,
    rejectedReason: string,
  ): Promise<RejectRefundResult> => {
  const idNum = Number(refundPaymentId)
  const reason = String(rejectedReason || '').trim()
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '缺少退款流水 ID' } }
  }
  if (!reason) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '驳回原因不能为空' } }
  }

  const [pre] = await db
    .select({
      payment: saleOrderPayments,
      orderStoreId: saleOrders.storeId,
      orderSaleOrderType: saleOrders.saleOrderType,
    })
    .from(saleOrderPayments)
    .leftJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .where(eq(saleOrderPayments.id, idNum))
    .limit(1)

  if (!pre || !pre.payment) {
    return { success: false, error: { code: 'NOT_FOUND', message: '退款记录不存在' } }
  }
  if (pre.payment.changeType !== '退款') {
    return { success: false, error: { code: 'INVALID_STATE', message: '该流水非退款类型' } }
  }
  if (pre.payment.status !== '待审批') {
    return {
      success: false,
      error: { code: 'INVALID_STATE', message: `当前状态"${pre.payment.status}"不允许驳回` },
    }
  }
  if (!pre.orderStoreId || !pre.payment.saleOrderId) {
    return { success: false, error: { code: 'NOT_FOUND', message: '原销售单不存在' } }
  }
  // 跨端守卫：充值单退款必须走员工端，admin 不允许驳回（保持与 approveRefund 对称）
  if (pre.orderSaleOrderType === '充值单') {
    return {
      success: false,
      error: {
        code: 'INVALID_STATE',
        message: '充值卡退款请在员工端审批（员工端 → 充值卡 → 退款审批）',
      },
    }
  }
  // scope 守卫：assertOrderInScope 统一三端语义
  try {
    await assertOrderInScope(session, pre.payment.saleOrderId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.startsWith('PERMISSION_DENIED:')) {
      return { success: false, error: { code: 'PERMISSION_DENIED', message: '无权操作该门店退款' } }
    }
    throw err
  }

  const refSaleOrderId = pre.payment.saleOrderId

  try {
    await db.transaction(async (tx) => {
      const updRes = await tx.execute(sql`
        UPDATE sale_order_payments
           SET status = '已作废',
               audit_employee_id = ${session.employeeId},
               audit_at = ${nowTs()},
               audit_remark = ${reason}
         WHERE id = ${idNum} AND status = '待审批'
      `)
      if (rowsAffected(updRes) === 0) {
        throw new ApiError('CONFLICT', 'CONCURRENT_CHANGED: 退款状态已变更，请刷新后重试')
      }

      // 通知发起人驳回（Bug C；自审降噪）
      if (pre.payment.operatorEmployeeId && pre.payment.operatorEmployeeId !== session.employeeId) {
        await notifyRefundResult(tx, {
          paymentId: idNum,
          saleOrderId: refSaleOrderId,
          recipientEmployeeId: pre.payment.operatorEmployeeId,
          approved: false,
          reason,
          amount: Math.abs(Number(pre.payment.amount || 0)),
        })
      }
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('CONCURRENT_CHANGED')) {
      return { success: false, error: { code: 'CONFLICT', message: '退款状态已变更，请刷新后重试' } }
    }
    console.error('[rejectRefund] unexpected error:', err)
    return { success: false, error: { code: 'UNKNOWN', message: '驳回失败，请稍后重试' } }
  }

  await logOperation(session, 'refund.reject', 'sale_order_payment', String(idNum), {
    refSaleOrderId,
    rejectedReason: reason,
  })

  revalidatePath('/refunds')
  revalidatePath(`/refunds/${idNum}`)
  if (refSaleOrderId) revalidatePath(`/orders/${refSaleOrderId}`)
  return { success: true }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// listRefunds：退款流水列表（聚合 sale_order_payments[change_type='退款']）
// ─────────────────────────────────────────────────────────────────────────────

// 读：提单人和审批人都需要看流水
export const listRefunds = withAnyPermission(
  ['sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, filters: RefundListFilters = {}): Promise<RefundListResult> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? (filters.pageSize as number) : 20
  const offset = (page - 1) * pageSize

  // 旧 UI 状态映射：'已关闭' → '已作废'（驳回）；其他原值透传
  const sopStatus =
    filters.status === '已关闭'
      ? '已作废'
      : filters.status === '已支付'
        ? '已支付'
        : filters.status === '待审批'
          ? '待审批'
          : null

  const conditions: (SQL | undefined)[] = [
    eq(saleOrderPayments.changeType, '退款'),
    scopeCondition(session, saleOrders.storeId),
  ]
  if (sopStatus) {
    conditions.push(
      eq(saleOrderPayments.status, sopStatus as typeof saleOrderPayments.status.enumValues[number]),
    )
  }
  const whereClause = and(...conditions)

  const [countRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(saleOrderPayments)
    .leftJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .where(whereClause)
  const total = countRow?.count ?? 0

  // 2026-07-08 修复 T1：与 orders.ts 对齐，left join clientWechatUsers 做 name/phone 兜底。
  const rows = await db
    .select({
      payment: saleOrderPayments,
      order: saleOrders,
      storeName: stores.storeName,
      operatorName: operatorAlias.name,
      auditorName: auditorAlias.name,
      custName: clientWechatUsers.name,
      custPhone: clientWechatUsers.phone,
      skuUnit: productSkus.unit,
      refundProductType: saleItems.productType,
    })
    .from(saleOrderPayments)
    .leftJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(operatorAlias, eq(saleOrderPayments.operatorEmployeeId, operatorAlias.employeeId))
    .leftJoin(auditorAlias, eq(saleOrderPayments.auditEmployeeId, auditorAlias.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .leftJoin(saleItems, eq(saleOrderPayments.refSaleItemId, saleItems.saleItemId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .where(whereClause)
    .orderBy(desc(saleOrderPayments.createdAt))
    .limit(pageSize)
    .offset(offset)

  const refunds: RefundListItem[] = rows.map((r) => mapRefundRow(r))

  return { refunds, total, page, pageSize }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// getRefundById：退款流水详情（按 sale_order_payments.id）
// ─────────────────────────────────────────────────────────────────────────────

// 读：审批页详情，提单人和审批人都要看
export const getRefundById = withAnyPermission(
  ['sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, refundPaymentId: number | string): Promise<RefundDetailResult | null> => {
  const idNum = Number(refundPaymentId)
  if (!Number.isFinite(idNum) || idNum <= 0) return null

  // 2026-07-08 修复 T1：与 getRefunds 对齐，left join clientWechatUsers 做 name/phone 兜底。
  const rows = await db
    .select({
      payment: saleOrderPayments,
      order: saleOrders,
      storeName: stores.storeName,
      operatorName: operatorAlias.name,
      auditorName: auditorAlias.name,
      custName: clientWechatUsers.name,
      custPhone: clientWechatUsers.phone,
      skuUnit: productSkus.unit,
      refundProductType: saleItems.productType,
    })
    .from(saleOrderPayments)
    .leftJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(operatorAlias, eq(saleOrderPayments.operatorEmployeeId, operatorAlias.employeeId))
    .leftJoin(auditorAlias, eq(saleOrderPayments.auditEmployeeId, auditorAlias.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .leftJoin(saleItems, eq(saleOrderPayments.refSaleItemId, saleItems.saleItemId))
    .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
    .where(
      and(
        eq(saleOrderPayments.id, idNum),
        eq(saleOrderPayments.changeType, '退款'),
        scopeCondition(session, saleOrders.storeId),
      ),
    )
    .limit(1)

  if (rows.length === 0) return null
  const base = mapRefundRow(rows[0])

  // 原销售单只读视图
  let origOrder: SaleOrder | null = null
  if (base.refSaleOrderId && rows[0].order) {
    const o = rows[0].order
    // 2026-07-08 修复 T1：与 orders.ts 对齐，left join clientWechatUsers 做 name/phone 兜底。
    origOrder = {
      saleOrderId: o.saleOrderId,
      status: o.status as OrderStatus,
      saleOrderType: o.saleOrderType as SaleOrder['saleOrderType'],
      documentType: o.documentType as SaleOrder['documentType'],
      refSaleOrderId: o.refSaleOrderId,
      legacySource: o.legacySource ?? null,
      marketName: o.marketName,
      storeId: o.storeId,
      saleOrderDatetime: o.saleOrderDatetime.toISOString(),
      clientUserId: o.clientUserId,
      clientPhone: rows[0].custPhone || o.clientPhone || null,
      customerName: rows[0].custName || o.customerName || null,
      totalAmount: o.totalAmount,
      prepaidCardAmount: o.prepaidCardAmount ?? '0',
      received: o.received ?? '0',
      refundedAmount: o.refundedAmount ?? '0',
      paymentMethod: o.paymentMethod as PaymentMethod,
      openedBy: o.openedBy,
      preferredEmployeeId: o.preferredEmployeeId,
      paidAt: o.paidAt?.toISOString() ?? null,
      allocationStatus: o.allocationStatus as SaleOrder['allocationStatus'],
      couponId: o.couponId,
      couponDiscount: o.couponDiscount,
      remark: o.remark,
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      storeName: rows[0].storeName ?? undefined,
    }
  }

  // 同一原单下所有退款流水（历史 + 当前）
  let payments: SaleOrderPayment[] = []
  if (base.refSaleOrderId) {
    const payRows = await db
      .select({
        payment: saleOrderPayments,
        operatorName: operatorAlias.name,
        skuUnit: productSkus.unit,
        refundProductType: saleItems.productType,
      })
      .from(saleOrderPayments)
      .leftJoin(operatorAlias, eq(saleOrderPayments.operatorEmployeeId, operatorAlias.employeeId))
      .leftJoin(saleItems, eq(saleOrderPayments.refSaleItemId, saleItems.saleItemId))
      .leftJoin(productSkus, eq(saleItems.skuId, productSkus.skuId))
      .where(
        and(
          eq(saleOrderPayments.saleOrderId, base.refSaleOrderId),
          eq(saleOrderPayments.changeType, '退款'),
        ),
      )
      .orderBy(asc(saleOrderPayments.createdAt))

    payments = payRows.map((r) => ({
      id: r.payment.id,
      saleOrderId: r.payment.saleOrderId,
      changeType: r.payment.changeType as SaleOrderPayment['changeType'],
      amount: r.payment.amount,
      paymentMethod: r.payment.paymentMethod as SaleOrderPayment['paymentMethod'],
      externalTxnId: r.payment.externalTxnId,
      status: r.payment.status as SaleOrderPayment['status'],
      sourceEnd: r.payment.sourceEnd as SaleOrderPayment['sourceEnd'],
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
      auditAt: r.payment.auditAt ? r.payment.auditAt.toISOString() : null,
      auditRemark: r.payment.auditRemark ?? null,
    }))
  }

  return {
    refund: base,
    origOrder,
    payments,
  }
  },
)

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

function mapRefundRow(r: {
  payment: typeof saleOrderPayments.$inferSelect
  order: typeof saleOrders.$inferSelect | null
  storeName: string | null
  operatorName: string | null
  auditorName: string | null
  custName?: string | null
  custPhone?: string | null
  skuUnit?: string | null
  refundProductType?: string | null
}): RefundListItem {
  return {
    refundPaymentId: r.payment.id,
    refSaleOrderId: r.payment.saleOrderId,
    status: r.payment.status as RefundListItem['status'],
    marketName: r.order?.marketName ?? null,
    storeId: r.order?.storeId ?? null,
    storeName: r.storeName,
    // 顾客档案权威 > sale_orders 兜底（防 client_wechat_users.name='' 的旧数据被原样展示）
    customerName: r.custName || r.order?.customerName || null,
    clientPhone: r.custPhone || r.order?.clientPhone || null,
    amount: r.payment.amount,
    refundReason: r.payment.refundReason ?? null,
    refSaleItemId: r.payment.refSaleItemId ?? null,
    sessionCount: r.payment.sessionCount ?? null,
    unit: r.skuUnit ?? (r.refundProductType === '家居产品' ? '盒' : '次'),
    operatorEmployeeId: r.payment.operatorEmployeeId ?? null,
    operatorName: r.operatorName,
    auditEmployeeId: r.payment.auditEmployeeId ?? null,
    auditorName: r.auditorName,
    auditAt: r.payment.auditAt ? r.payment.auditAt.toISOString() : null,
    auditRemark: r.payment.auditRemark ?? null,
    paymentMethod: r.payment.paymentMethod,
    createdAt: r.payment.createdAt.toISOString(),
    paidAt: r.payment.paidAt?.toISOString() ?? null,
  }
}

/**
 * 重算顾客历史消费档位（事务内调用，退款会减少累计消费）
 *
 * 2026-04-26 sale-order-domain-refactor：原 paid_amount 列已 DROP，统一改用
 * received - refunded_amount；类型限定为 5→3 后的 3 值。
 *
 * spending_tier 档位边界为固定值（含 '1990-1W' 档下界 1990），不随
 * system_configs.new_member_threshold 变化；门槛只影响 customer_type / member_level。
 */
async function refreshSpendingTierTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  clientUserId: string,
): Promise<void> {
  if (!clientUserId) return

  await tx.execute(sql`
    UPDATE client_wechat_users
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
         WHERE client_user_id = ${clientUserId}
           AND status IN ('已支付', '已完成')
           AND sale_order_type IN ('销售单','转换单')
       ) t
     WHERE user_id = ${clientUserId}
  `)
}
