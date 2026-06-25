/**
 * 退款工具函数（TypeScript 版本）
 *
 * 与 fengyu-staff/cloudfunctions/staffApi/utils/refund.js 算法完全一致：
 *   refundable_per_item = 未使用数量 × unit_real_price
 *   total_refundable    = Σ(refundable_per_item)
 *   final_refund_amount = max(0, total_refundable − handling_fee)
 *
 * 未使用数量按 sale_items.product_type 区分（2026-05-21 单品合并后）：
 *   疗程卡（含原单品=1 次卡）：remaining_sessions
 *   家居产品：quantity − picked_up_quantity
 */

import type { PaymentMethod, ProductType, SalesCategory } from './types'

/** sale_items 行（snake_case 字段，来自 PG） */
export interface RefundSourceItem {
  sale_item_id: string
  sku_id: string | null
  product_name: string | null
  product_type: ProductType | null
  session_count: number | null
  remaining_sessions: number | null
  /** 已付费次数（已反映已审批退款）；疗程卡数量门用，null 视为历史行回退 remaining_sessions */
  paid_sessions: number | null
  unit_price: string | number
  quantity: number
  unit_real_price: string | number
  picked_up_quantity: number | null
  sales_category: SalesCategory | null
  service_fee: string | number | null
  item_direction?: string
}

export interface RefundRequestItem {
  saleItemId: string
  refundQuantity?: number
}

export interface RefundDetail {
  refSaleItemId: string
  skuId: string | null
  productName: string | null
  productType: ProductType | null
  sessionCount: number | null
  unitPrice: number
  quantity: number
  unitRealPrice: number
  refundAmount: number
  salesCategory: SalesCategory | null
  serviceFee: number
  /** 本次是否全退该明细（退款数量 >= 当前可退数量）→ 控制 cascade 是否作废其分配/提成（Bug M） */
  isFullItemRefund: boolean
}

/**
 * 计算单个 sale_item 的可退未使用数量
 */
export function calculateUnusedQuantity(item: RefundSourceItem | null | undefined): number {
  if (!item) return 0
  if (item.product_type === '疗程卡') {
    // 修复（Bug A 数量门）：退款不减 remaining_sessions（Model X），真正可退 = paid_sessions − 已消费次数。
    // paid_sessions 已反映所有已审批退款，全额退后为 0 → 可退 0。null（历史行）回退 remaining，金额门兜底。
    // 两端镜像 staff utils/refund.js。
    const remaining = Number(item.remaining_sessions || 0)
    if (item.paid_sessions == null) return remaining
    const consumed = Number(item.session_count || 0) - remaining
    return Math.max(0, Math.min(remaining, Number(item.paid_sessions) - consumed))
  }
  const quantity = Number(item.quantity || 0)
  const pickedUp = Number(item.picked_up_quantity || 0)
  return Math.max(0, quantity - pickedUp)
}

/**
 * 校验并构建退款明细
 *
 * @throws Error INVALID_PARAMS / INVALID_STATE 前缀异常
 */
export function buildRefundDetails(
  origItems: RefundSourceItem[],
  requestItems: RefundRequestItem[],
): { refundDetails: RefundDetail[]; totalRefund: number } {
  const itemMap: Record<string, RefundSourceItem> = {}
  for (const i of origItems) itemMap[i.sale_item_id] = i

  const refundDetails: RefundDetail[] = []
  let totalRefund = 0

  for (const req of requestItems) {
    const orig = itemMap[req.saleItemId]
    if (!orig) throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 不存在`)

    const maxUnused = calculateUnusedQuantity(orig)
    // 疗程卡必须整卡全退（不支持部分退次数）：强制 requested = maxUnused，忽略前端传入的部分数量；
    // 家居产品仍可按未提货数量部分退。两端镜像 staff utils/refund.js。
    const requested =
      orig.product_type === '疗程卡' ? maxUnused : (Number(req.refundQuantity) || maxUnused)

    if (requested <= 0) {
      throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 退款数量必须大于 0`)
    }
    if (requested > maxUnused) {
      throw new Error(`INVALID_STATE: 明细 ${req.saleItemId} 可退数量 ${maxUnused} 不足 ${requested}`)
    }

    const unitRealPrice = Number(orig.unit_real_price)
    const refundAmount = Math.round(unitRealPrice * requested * 100) / 100
    totalRefund += refundAmount

    // 退款行 service_fee 按比例扣减（原 service_fee 占比 × 退款数量占比）
    const origServiceFee = Number(orig.service_fee || 0)
    const origQty = Number(orig.quantity) || 1
    const refundServiceFee = -Math.round((origServiceFee * requested) / origQty * 100) / 100

    // 修复（Bug M 强化 2026-06-08）：仅「退光全部可退 **且** 该明细零已消费/零已提货」才算全退该明细。
    // 退款只退未使用数量，未使用部分本无 service_commission；收紧后通道2 对被退 item 天然零作废，
    // 保护「已完成服务的提成」与「已实现营收的分配」不被退剩余次数误删（两端镜像 staff utils/refund.js）。
    const consumedQty =
      orig.product_type === '疗程卡'
        ? Number(orig.session_count || 0) - Number(orig.remaining_sessions || 0)
        : Number(orig.picked_up_quantity || 0)

    refundDetails.push({
      refSaleItemId: req.saleItemId,
      skuId: orig.sku_id,
      productName: orig.product_name,
      productType: orig.product_type,
      sessionCount: orig.session_count,
      unitPrice: Number(orig.unit_price),
      quantity: requested,
      unitRealPrice,
      refundAmount,
      salesCategory: orig.sales_category,
      serviceFee: refundServiceFee,
      isFullItemRefund: requested >= maxUnused && consumedQty <= 0,
    })
  }

  return {
    refundDetails,
    totalRefund: Math.round(totalRefund * 100) / 100,
  }
}

/**
 * 退款封顶截断（疗程卡整卡全退专用）。
 *
 * 疗程卡强制整卡全退、退款数量不可调（见 buildRefundDetails）。部分支付订单（如疗程卡只付定金、
 * 次数全在）整卡值可能 > 净已收 refundCap，旧逻辑直接拒绝 → 该订单永远无法退款。
 * 改为：把逐项 refundAmount 等比缩到 targetGross（= refundCap + 手续费），数量不变（整卡仍作废）。
 * 退款额截断到「只退已付部分」，打破「数量↔金额自洽」（数量=整卡次数、金额=已付），符合"只能退已付"。
 *
 * 最大余数法对齐总额：逐项 floor 后把尾差补到 refundAmount 最大的一项，避免逐项 round 累积偏移。
 * 返回缩放后的 totalRefund（= targetGross）。两端镜像 staff utils/refund.js。
 */
export function capRefundAmounts(
  refundDetails: Array<{ refundAmount: number }>,
  originalTotal: number,
  targetGross: number,
): number {
  if (originalTotal <= 0 || targetGross >= originalTotal || refundDetails.length === 0) {
    return originalTotal
  }
  const ratio = targetGross / originalTotal
  let allocated = 0
  for (const d of refundDetails) {
    const v = Math.floor(d.refundAmount * ratio * 100) / 100
    d.refundAmount = v
    allocated += v
  }
  const remainder = Math.round((targetGross - allocated) * 100) / 100
  if (remainder !== 0) {
    let maxIdx = 0
    for (let i = 1; i < refundDetails.length; i += 1) {
      if (refundDetails[i].refundAmount > refundDetails[maxIdx].refundAmount) maxIdx = i
    }
    refundDetails[maxIdx].refundAmount = Math.round((refundDetails[maxIdx].refundAmount + remainder) * 100) / 100
  }
  return Math.round(targetGross * 100) / 100
}

/**
 * 按原单储值卡抵扣比例，将退款金额拆为储值卡回冲 + 原路径退款
 *
 *   refundByCard   = floor(origPrepaidCardAmount / origTotalAmount × refundAmount, 2)
 *   refundByOrigin = refundAmount − refundByCard   // 反向相减，无尾差
 */
export function splitRefundByOriginalPayment(
  refundAmount: number,
  origPrepaidCardAmount: number,
  origTotalAmount: number,
): { refundByCard: number; refundByOrigin: number } {
  let refundByCard = 0
  let refundByOrigin = Math.round(refundAmount * 100) / 100

  if (origPrepaidCardAmount > 0 && origTotalAmount > 0 && refundAmount > 0) {
    const raw = (origPrepaidCardAmount / origTotalAmount) * refundAmount
    refundByCard = Math.floor(raw * 100) / 100
    refundByOrigin = Math.round((refundAmount - refundByCard) * 100) / 100
  }

  return { refundByCard, refundByOrigin }
}

/**
 * 决定退款 payments 行的 payment_method
 *
 * 2026-06-24 改为「全部走线下退款」：退款不按原路返还，一律记 '线下'（门店现场退现金/转账），
 * 不调拉卡拉/微信原路退款接口。储值卡抵扣部分的回冲由 splitRefundByOriginalPayment +
 * approveRefund 储值卡通道处理（回冲到卡余额），不经本函数。两端镜像 staff utils/refund.js。
 */
export function resolveRefundPaymentMethod(
  _origPaymentMethod?: PaymentMethod | '储值卡' | null | undefined,
): PaymentMethod {
  return '线下'
}
