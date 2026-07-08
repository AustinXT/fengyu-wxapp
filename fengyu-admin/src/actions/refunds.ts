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
import { nowTs } from '@/lib/db-time'
import {
  buildRefundDetails,
  calculateUnusedQuantity,
  capRefundAmounts,
  resolveRefundPaymentMethod,
  splitRefundByOriginalPayment,
  type RefundSourceItem,
} from '@/lib/refund'
import { cascadeRefund, notifyRefundCreated, notifyRefundResult } from '@/lib/refund-cascade'
import { pgErrorCode, pgErrorConstraint } from '@/lib/pg-error'
import { recalcPaidSessionsForOrder } from '@/lib/paid-sessions'
import type {
  OrderStatus,
  PaymentMethod,
  ProductType,
  SaleOrder,
  SaleOrderPayment,
  SalesCategory,
} from '@/lib/types'


const operatorAlias = alias(staffWechatUsers, 'sop_operator') as unknown as typeof staffWechatUsers
const auditorAlias = alias(staffWechatUsers, 'sop_auditor') as unknown as typeof staffWechatUsers









export interface RefundableItem {
  saleItemId: string
  productName: string
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
  
  clientUserId: string | null
}

export type CreateRefundResult =
  | {
      success: true
      data: {
        
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


export interface RefundListItem {
  
  refundPaymentId: number
  
  refSaleOrderId: string
  
  status: '待审批' | '已支付' | '已作废' | '已退款' | '待支付'
  marketName: string | null
  storeId: string | null
  storeName: string | null
  customerName: string | null
  clientPhone: string | null
  
  amount: string
  refundReason: string | null
  refSaleItemId: string | null
  sessionCount: number | null
  
  operatorEmployeeId: string | null
  operatorName: string | null
  
  auditEmployeeId: string | null
  auditorName: string | null
  auditAt: string | null
  auditRemark: string | null
  paymentMethod: string
  createdAt: string
  paidAt: string | null
}

export interface RefundListFilters {
  
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
  
  suggestedOverdraftDeduction: number
  detail: {
    usedCoupons: Array<{ couponId: string; templateId: string; discountValue: number; usedAt: string }>
    usedPoints: number
    grantedPoints: number
    pointsToYuanRate: number
  }
}






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
      product_type: r.productType as ProductType | null,
      session_count: r.sessionCount,
      remaining_sessions: r.remainingSessions,
      paid_sessions: r.paidSessions,
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





export const createRefund = withPermission(
  'sale_order:refund_create',
  async (
    session,
    input: {
  refSaleOrderId: string
  items: Array<{ saleItemId: string; refundQuantity: number }>
  refundReason: string
  handlingFee?: number
  
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
  
  
  const cardUnitPrices = refundDetails.filter((d) => d.productType === '疗程卡').map((d) => Number(d.unitRealPrice))
  if (cardUnitPrices.length > 0 && fee >= Math.min(...cardUnitPrices)) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '手续费不能超过单次服务价格' } }
  }
  let finalRefundAmount = Math.max(0, Math.round((totalRefund - fee) * 100) / 100)
  if (finalRefundAmount <= 0) {
    return { success: false, error: { code: 'INVALID_STATE', message: '无可退项' } }
  }

  
  
  
  
  
  const paymentsNetRows = await db.execute<{ net: string }>(sql`
    SELECT COALESCE(SUM(amount), 0)::numeric AS net
    FROM sale_order_payments
    WHERE sale_order_id = ${refSaleOrderId} AND status = '已支付'
  `)
  const paymentsNet = Number(
    (paymentsNetRows as unknown as Array<{ net: string | number }>)[0]?.net || 0,
  )
  
  
  const refundCap = Math.max(paymentsNet, Number(origOrder.received || 0) - Number(origOrder.refundedAmount || 0))
  if (finalRefundAmount > refundCap + 0.001) {
    
    
    
    
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
    if (finalRefundAmount <= 0) {
      return { success: false, error: { code: 'INVALID_STATE', message: '无可退项' } }
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

  
  const primaryRefSaleItemId = refundDetails.length === 1 ? refundDetails[0].refSaleItemId : null
  const primarySessionCount =
    refundDetails.length === 1 ? refundDetails[0].sessionCount ?? refundDetails[0].quantity : null

  
  const isWholeOrderRefund = sourceItems.length > 0 && sourceItems.every((oi) =>
    refundDetails.some((d) => d.refSaleItemId === oi.sale_item_id && d.isFullItemRefund),
  )
  
  const paymentNote = JSON.stringify({
    refundByCard,
    refundByOrigin,
    handlingFee: fee,
    overdraftDeduction,
    isWholeOrderRefund,
    items: refundDetails.map((d) => ({
      refSaleItemId: d.refSaleItemId,
      quantity: d.quantity,
      refundAmount: d.refundAmount,
      productType: d.productType,
      isFullItemRefund: d.isFullItemRefund,
    })),
  })

  let refundPaymentId: number
  try {
    refundPaymentId = await db.transaction(async (tx) => {
      
      
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

      
      await notifyRefundCreated(tx, {
        paymentId: paymentRow.id,
        saleOrderId: refSaleOrderId,
        storeId: origOrder.storeId,
        operatorId: session.employeeId,
        amount: adjustedRefundAmount,
        customerName: origOrder.customerName,
      })

      return paymentRow.id
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    
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









export const approveRefund = withPermission(
  'sale_order:refund_approve',
  async (session, refundPaymentId: number | string): Promise<ApproveRefundResult> => {
  const idNum = Number(refundPaymentId)
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return { success: false, error: { code: 'INVALID_PARAMS', message: '缺少退款流水 ID' } }
  }

  
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
  
  
  if (pre.orderSaleOrderType === '充值单') {
    return {
      success: false,
      error: {
        code: 'INVALID_STATE',
        message: '充值卡退款请在员工端审批（员工端 → 充值卡 → 退款审批）',
      },
    }
  }
  
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
    reversedPoints: 0,
    rolledBackPickups: 0,
  }

  try {
    cascade = await db.transaction(async (tx) => {
      

      
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

      
      
      
      
      
      
      
      const refSaleItemId = pre.payment.refSaleItemId ?? null
      const sessionCount = pre.payment.sessionCount ?? null

      
      let cascadeItems: Array<{ saleItemId: string; sessionCount: number | null; refundAmount: number | null; isFullItemRefund: boolean }> = []
      let cascadeWholeOrder = false
      try {
        const noteObj = pre.payment.note ? JSON.parse(pre.payment.note) : null
        if (noteObj && Array.isArray(noteObj.items)) {
          cascadeItems = noteObj.items.map(
            (it: { refSaleItemId: string; quantity: number; refundAmount?: number; isFullItemRefund?: boolean }) => ({
              saleItemId: it.refSaleItemId,
              sessionCount: it.quantity,
              refundAmount: it.refundAmount ?? null,
              isFullItemRefund: !!it.isFullItemRefund,
            }),
          )
          cascadeWholeOrder = !!noteObj.isWholeOrderRefund
        }
      } catch {
        cascadeItems = []
      }
      
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

      
      
      await recalcPaidSessionsForOrder(tx, refSaleOrderId)

      
      if (pre.orderClientUserId) {
        await refreshSpendingTierTx(tx, pre.orderClientUserId)
      }

      
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
  
  if (pre.orderSaleOrderType === '充值单') {
    return {
      success: false,
      error: {
        code: 'INVALID_STATE',
        message: '充值卡退款请在员工端审批（员工端 → 充值卡 → 退款审批）',
      },
    }
  }
  
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






export const listRefunds = withAnyPermission(
  ['sale_order:refund_create', 'sale_order:refund_approve'],
  async (session, filters: RefundListFilters = {}): Promise<RefundListResult> => {
  const page = Math.max(1, filters.page || 1)
  const pageSize = [10, 20, 50].includes(filters.pageSize ?? 0) ? (filters.pageSize as number) : 20
  const offset = (page - 1) * pageSize

  
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
    })
    .from(saleOrderPayments)
    .leftJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(operatorAlias, eq(saleOrderPayments.operatorEmployeeId, operatorAlias.employeeId))
    .leftJoin(auditorAlias, eq(saleOrderPayments.auditEmployeeId, auditorAlias.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
    .where(whereClause)
    .orderBy(desc(saleOrderPayments.createdAt))
    .limit(pageSize)
    .offset(offset)

  const refunds: RefundListItem[] = rows.map((r) => mapRefundRow(r))

  return { refunds, total, page, pageSize }
  },
)






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
    })
    .from(saleOrderPayments)
    .leftJoin(saleOrders, eq(saleOrders.saleOrderId, saleOrderPayments.saleOrderId))
    .leftJoin(stores, eq(saleOrders.storeId, stores.storeId))
    .leftJoin(operatorAlias, eq(saleOrderPayments.operatorEmployeeId, operatorAlias.employeeId))
    .leftJoin(auditorAlias, eq(saleOrderPayments.auditEmployeeId, auditorAlias.employeeId))
    .leftJoin(clientWechatUsers, eq(saleOrders.clientUserId, clientWechatUsers.userId))
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





function mapRefundRow(r: {
  payment: typeof saleOrderPayments.$inferSelect
  order: typeof saleOrders.$inferSelect | null
  storeName: string | null
  operatorName: string | null
  auditorName: string | null
  custName?: string | null
  custPhone?: string | null
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
