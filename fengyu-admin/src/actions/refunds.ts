'use server'

import { db } from '@/db'
import { rowsAffected } from '@/lib/pg-rows'
import { saleOrders, saleItems, saleOrderPayments } from '@db/order'
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
import {
  buildRefundDetails,
  calculateUnusedQuantity,
  resolveRefundPaymentMethod,
  splitRefundByOriginalPayment,
  type RefundSourceItem,
} from '@/lib/refund'
import { cascadeRefund } from '@/lib/refund-cascade'
import { recalcPaidSessionsForOrder } from '@/lib/paid-sessions'
import * as lakalaClient from '@/lib/lakala-client'
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
  skuSpecName: string
  productType: ProductType | null
  unitRealPrice: number
  unusedQuantity: number
  refundableAmount: number
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
    .select()
    .from(saleItems)
    .where(and(eq(saleItems.saleOrderId, saleOrderId), eq(saleItems.itemDirection, '购买')))

  const items: RefundableItem[] = rows.map((r) => {
    const src: RefundSourceItem = {
      sale_item_id: r.saleItemId,
      sku_id: r.skuId,
      product_name: r.productName,
      sku_spec_name: r.skuSpecName,
      product_type: r.productType as ProductType | null,
      session_count: r.sessionCount,
      remaining_sessions: r.remainingSessions,
      unit_price: r.unitPrice,
      quantity: r.quantity,
      unit_real_price: r.unitRealPrice,
      picked_up_quantity: r.pickedUpQuantity,
      sales_category: r.salesCategory as SalesCategory | null,
      service_fee: r.serviceFee,
    }
    const unused = calculateUnusedQuantity(src)
    const unitRealPrice = Number(r.unitRealPrice)
    const refundableAmount = Math.round(unitRealPrice * unused * 100) / 100

    return {
      saleItemId: r.saleItemId,
      productName: r.productName || '-',
      skuSpecName: r.skuSpecName || '',
      productType: r.productType as ProductType | null,
      unitRealPrice,
      unusedQuantity: unused,
      refundableAmount,
      quantity: r.quantity,
      sessionCount: r.sessionCount,
      remainingSessions: r.remainingSessions,
      pickedUpQuantity: r.pickedUpQuantity,
    }
  })

  return {
    items,
    origTotalAmount: Number(order.totalAmount),
    origPrepaidCardAmount: Number(order.prepaidCardAmount),
    origPaymentMethod: order.paymentMethod as PaymentMethod,
    clientUserId: order.clientUserId ?? null,
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
        WHERE template_id = ANY(${allTemplateIds}::text[])
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
  items: Array<{ saleItemId: string; refundQuantity: number }>
  refundReason: string
  handlingFee?: number
  /** 若 true，则按建议扣除超额权益；默认 true */
  applyOverdraftDeduction?: boolean
    },
  ): Promise<CreateRefundResult> => {
  const refSaleOrderId = String(input.refSaleOrderId || '').trim()
  if (!refSaleOrderId) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '缺少原销售单号' } }
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
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

  const origRows = await db
    .select()
    .from(saleItems)
    .where(and(eq(saleItems.saleOrderId, refSaleOrderId), eq(saleItems.itemDirection, '购买')))

  const sourceItems: RefundSourceItem[] = origRows.map((r) => ({
    sale_item_id: r.saleItemId,
    sku_id: r.skuId,
    product_name: r.productName,
    sku_spec_name: r.skuSpecName,
    product_type: r.productType as ProductType | null,
    session_count: r.sessionCount,
    remaining_sessions: r.remainingSessions,
    unit_price: r.unitPrice,
    quantity: r.quantity,
    unit_real_price: r.unitRealPrice,
    picked_up_quantity: r.pickedUpQuantity,
    sales_category: r.salesCategory as SalesCategory | null,
    service_fee: r.serviceFee,
  }))

  let refundDetails: ReturnType<typeof buildRefundDetails>['refundDetails']
  let totalRefund: number
  try {
    const built = buildRefundDetails(sourceItems, input.items)
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
  const finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
  if (finalRefundAmount <= 0) {
    return { success: false, error: { code: 'INVALID_STATE', message: '无可退项' } }
  }

  // 退款上限 = max(sale_order_payments 流水净额, origOrder.received)（与 staffApi createRefund 对齐）。
  // 部分支付订单按未使用次数×unit_real_price 算出的退款额可能远超实付，需封顶；流水净额含储值卡抵扣，
  // received 兜底（流水缺失单），取 max 避免误拒。超限直接拒绝（不截断金额），保持退款数量与金额自洽。
  const paymentsNetRows = await db.execute<{ net: string }>(sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS net
    FROM sale_order_payments
    WHERE sale_order_id = ${refSaleOrderId} AND status = '已支付'
  `)
  const paymentsNet = Number(
    (paymentsNetRows as unknown as Array<{ net: string | number }>)[0]?.net || 0,
  )
  const refundCap = Math.max(paymentsNet, Number(origOrder.received || 0))
  if (finalRefundAmount > refundCap + 0.001) {
    return {
      success: false,
      error: { code: 'INVALID_STATE', message: '退款金额超过订单可退余额，请减少退款数量' },
    }
  }

  const applyOverdraft = input.applyOverdraftDeduction !== false
  let overdraftDeduction = 0
  if (applyOverdraft && origOrder.clientUserId) {
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

  // 部分退款时关联具体 sale_item（多行退款时取首行；整单退款保留 null）
  const primaryRefSaleItemId = refundDetails.length === 1 ? refundDetails[0].refSaleItemId : null
  const primarySessionCount =
    refundDetails.length === 1 ? refundDetails[0].sessionCount ?? refundDetails[0].quantity : null

  const noteLines: string[] = [`reason=${refundReason}`]
  if (fee > 0) noteLines.push(`fee=${fee.toFixed(2)}`)
  if (overdraftDeduction > 0) noteLines.push(`overdraft=${overdraftDeduction.toFixed(2)}`)
  const paymentNote = noteLines.join('; ')

  let refundPaymentId: number
  try {
    refundPaymentId = await db.transaction(async (tx) => {
      // 主流水：按整笔金额写一行 status='待审批'，approveRefund 时按拆分（储值卡+原通道）做实际扣减。
      // chk_sop_amount_sign 要求 amount<0；paymentMethod 取储值卡（如全额）或原通道兜底
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const pgErr = err as { code?: string; constraint?: string }
    if (pgErr.code === '23505' && pgErr.constraint === 'uq_sop_status_audit') {
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
/**
 * [联调待启用] admin 退款审批通过后，把"原通道部分"经拉卡拉退回。
 *
 * **默认关闭**（`LAKALA_REFUND_ENABLED !== 'true'`）→ 直接 no-op，不影响现有退款流（DB cascade 照常）。
 * 之所以默认关：退款无法在 SIT 实证（需一笔真实已支付单），且 origin 引用映射需联调确认。
 *
 * 联调开启 checklist：
 *  1. admin 运行时 env 设 `LAKALA_REFUND_ENABLED=true` + 完整 `LAKALA_*`（私钥/平台证书/商户号）。
 *  2. 字段路径在聚合主扫迁移（2026-05-29）后已澄清：payNotify 把扁平回调 body 完整存进
 *     `external_trade_info` JSONB，顶层字段 `acc_trade_no`（微信 transaction_id / 支付宝交易号）
 *     用作 `origin_trade_no`；`trade_no`（拉卡拉交易流水）为兜底；`log_no`（对账单流水）→ `origin_log_no`。
 *  3. origin_out_trade_no 用 `sale_orders.lakala_out_order_no`（聚合主扫商户流水号，含 _unixSec 后缀）兜底。
 *  4. requestIp 必须改用 admin 操作人真实 IP（风控必送），现用 env 占位。
 *  5. 处理 requestRefund 返回 trade_state：SUCCESS=同步成功；PROCESSING/INIT/TIMEOUT=异步，
 *     需 cron poll-lakala-refunds（queryRefund 推进，仍为 follow-up）。
 */
async function refundViaLakalaIfEnabled(opts: {
  refundPaymentId: number
  saleOrderId: string
  refundByOriginFen: number
  paymentMethod: string
  requestIp: string
}): Promise<{ attempted: boolean; tradeState?: string; error?: string }> {
  if (process.env.LAKALA_REFUND_ENABLED !== 'true') return { attempted: false }
  if (opts.refundByOriginFen <= 0) return { attempted: false }
  if (opts.paymentMethod !== '微信' && opts.paymentMethod !== '支付宝') return { attempted: false }
  if (!lakalaClient.isReady()) return { attempted: false, error: 'LAKALA_NOT_READY' }

  // 取原支付的受单信息 + 收银台 out_order_no + 门店拉卡拉商户号
  const [row] = await db
    .select({
      tradeInfo: saleOrderPayments.externalTradeInfo,
      outOrderNo: saleOrders.lakalaOutOrderNo,
      merchantNo: stores.lakalaMerchantNo,
      termNo: stores.lakalaTermNo,
    })
    .from(saleOrderPayments)
    .innerJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .leftJoin(stores, eq(stores.storeId, saleOrders.storeId))
    .where(
      and(
        eq(saleOrderPayments.saleOrderId, opts.saleOrderId),
        sql`${saleOrderPayments.changeType} IN ('首次支付','回款')`,
        sql`${saleOrderPayments.externalTxnId} IS NOT NULL`,
      ),
    )
    .orderBy(asc(saleOrderPayments.id))
    .limit(1)

  if (!row || !row.merchantNo || !row.termNo) return { attempted: false, error: 'NO_LAKALA_MERCHANT' }
  const tradeInfo = (row.tradeInfo || {}) as Record<string, string>
  try {
    const res = await lakalaClient.requestRefund({
      merchantNo: row.merchantNo,
      termNo: row.termNo,
      outTradeNo: `refund-${opts.refundPaymentId}`,
      refundAmountFen: opts.refundByOriginFen,
      // 聚合主扫迁移后字段路径已澄清（2026-05-29）：扁平 body 顶层直接取
      originTradeNo: tradeInfo.acc_trade_no || tradeInfo.trade_no,
      originLogNo: tradeInfo.log_no,
      originOutTradeNo: row.outOrderNo || undefined,
      requestIp: opts.requestIp,
    })
    return { attempted: true, tradeState: res.tradeState }
  } catch (e) {
    return { attempted: true, error: e instanceof Error ? e.message : String(e) }
  }
}

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
    reversedPoints: 0,
    rolledBackPickups: 0,
  }

  try {
    cascade = await db.transaction(async (tx) => {
      const nowIso = new Date().toISOString()

      // 1) CAS 翻状态 + 同一条 UPDATE 写审批人：仅 '待审批' → '已支付'
      const updRes = await tx.execute(sql`
        UPDATE sale_order_payments
           SET status = '已支付',
               paid_at = ${nowIso},
               audit_employee_id = ${session.employeeId},
               audit_at = ${nowIso}
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

      // 4) 储值卡回冲（Model X：退款只动金额，不扣 remaining_sessions —— 退后可消费次数
      //    由 paid_sessions 闸门约束，service.js 核销条件 (已用+本次)≤paid_sessions 自动拦截已退次数；
      //    与 staff/clientApi 一致。退款次数上限已在 createRefund 处由 calculateUnusedQuantity≤remaining 约束。）
      const refSaleItemId = pre.payment.refSaleItemId ?? null
      const sessionCount = pre.payment.sessionCount ?? null

      if (refundByCard > 0 && pre.orderClientUserId) {
        const refOrderTag = `refund-payment-${idNum}`
        const dupRes = await tx.execute(sql`
          SELECT 1 FROM card_transactions
          WHERE ref_order_id = ${refOrderTag} AND type = '充值' LIMIT 1
        `)
        if ((dupRes as unknown as unknown[]).length === 0) {
          const newCardId = `FY-CARD-${Date.now()}${Math.floor(Math.random() * 1000)
            .toString()
            .padStart(3, '0')}`
          const upsertRes = await tx.execute(sql`
            INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
            VALUES (${newCardId}, ${pre.orderClientUserId}, ${refundByCard.toFixed(2)}::numeric, NOW(), NOW())
            ON CONFLICT (user_id) DO UPDATE
              SET balance = prepaid_cards.balance + EXCLUDED.balance, updated_at = NOW()
            RETURNING card_id
          `)
          const cardId = (upsertRes as unknown as Array<{ card_id: string }>)[0]?.card_id
          if (!cardId) throw new ApiError('INVALID_STATE', 'CARD_UPSERT_FAILED: 储值卡回冲失败')

          await tx.execute(sql`
            INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
            VALUES (${cardId}, '充值', ${refundByCard.toFixed(2)}::numeric, ${refOrderTag}, NOW())
          `)
        }
      }

      // 5) 5 通道 cascade
      const result = await cascadeRefund(tx, {
        saleOrderId: refSaleOrderId,
        saleItemId: refSaleItemId,
        sessionCount,
        refundReason: pre.payment.refundReason ?? '',
      })

      // 5.1) paid_sessions 重算（ticket 2026-05-19，D3=A）：refunded_amount 增长 → settled 下降
      // 若新 paid_sessions < 已消费次数，抛 CONFLICT 阻止退款
      await recalcPaidSessionsForOrder(tx, refSaleOrderId)

      // 6) 重算顾客历史消费档位
      if (pre.orderClientUserId) {
        await refreshSpendingTierTx(tx, pre.orderClientUserId)
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

  // [联调待启用] DB 退款已提交，经拉卡拉把原通道金额退回（flag 默认关 → no-op）。
  // best-effort：拉卡拉调用失败不回滚已提交的 DB 退款，记录待人工跟进。
  const lakalaRefund = await refundViaLakalaIfEnabled({
    refundPaymentId: idNum,
    saleOrderId: refSaleOrderId,
    refundByOriginFen: Math.round(refundByOrigin * 100),
    paymentMethod: pre.payment.paymentMethod,
    requestIp: process.env.LAKALA_REFUND_REQUEST_IP || '', // TODO[联调]：改用 admin 操作人真实 IP
  })
  if (lakalaRefund.attempted && lakalaRefund.error) {
    console.error('[approveRefund] 拉卡拉退款调用失败（DB 退款已提交，需人工跟进）:', refSaleOrderId, lakalaRefund.error)
  }

  await logOperation(session, 'refund.approve', 'sale_order_payment', String(idNum), {
    refSaleOrderId,
    refundByCard: refundByCard.toFixed(2),
    refundByOrigin: refundByOrigin.toFixed(2),
    cascade,
  })

  revalidatePath('/refunds')
  revalidatePath(`/refunds/${idNum}`)
  if (refSaleOrderId) revalidatePath(`/orders/${refSaleOrderId}`)
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
      const nowIso = new Date().toISOString()
      const updRes = await tx.execute(sql`
        UPDATE sale_order_payments
           SET status = '已作废',
               audit_employee_id = ${session.employeeId},
               audit_at = ${nowIso},
               audit_remark = ${reason}
         WHERE id = ${idNum} AND status = '待审批'
      `)
      if (rowsAffected(updRes) === 0) {
        throw new ApiError('CONFLICT', 'CONCURRENT_CHANGED: 退款状态已变更，请刷新后重试')
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

  const rows = await db
    .select({
      payment: saleOrderPayments,
      order: saleOrders,
      storeName: stores.storeName,
      operatorName: operatorAlias.name,
      auditorName: auditorAlias.name,
    })
    .from(saleOrderPayments)
    .leftJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(operatorAlias, eq(saleOrderPayments.operatorEmployeeId, operatorAlias.employeeId))
    .leftJoin(auditorAlias, eq(saleOrderPayments.auditEmployeeId, auditorAlias.employeeId))
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

  const rows = await db
    .select({
      payment: saleOrderPayments,
      order: saleOrders,
      storeName: stores.storeName,
      operatorName: operatorAlias.name,
      auditorName: auditorAlias.name,
    })
    .from(saleOrderPayments)
    .leftJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(operatorAlias, eq(saleOrderPayments.operatorEmployeeId, operatorAlias.employeeId))
    .leftJoin(auditorAlias, eq(saleOrderPayments.auditEmployeeId, auditorAlias.employeeId))
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
    origOrder = {
      saleOrderId: o.saleOrderId,
      status: o.status as OrderStatus,
      saleOrderType: o.saleOrderType as SaleOrder['saleOrderType'],
      documentType: o.documentType as SaleOrder['documentType'],
      refSaleOrderId: o.refSaleOrderId,
      marketName: o.marketName,
      storeId: o.storeId,
      saleOrderDatetime: o.saleOrderDatetime.toISOString(),
      clientUserId: o.clientUserId,
      clientPhone: o.clientPhone,
      customerName: o.customerName,
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
      })
      .from(saleOrderPayments)
      .leftJoin(operatorAlias, eq(saleOrderPayments.operatorEmployeeId, operatorAlias.employeeId))
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
}): RefundListItem {
  return {
    refundPaymentId: r.payment.id,
    refSaleOrderId: r.payment.saleOrderId,
    status: r.payment.status as RefundListItem['status'],
    marketName: r.order?.marketName ?? null,
    storeId: r.order?.storeId ?? null,
    storeName: r.storeName,
    customerName: r.order?.customerName ?? null,
    clientPhone: r.order?.clientPhone ?? null,
    amount: r.payment.amount,
    refundReason: r.payment.refundReason ?? null,
    refSaleItemId: r.payment.refSaleItemId ?? null,
    sessionCount: r.payment.sessionCount ?? null,
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
