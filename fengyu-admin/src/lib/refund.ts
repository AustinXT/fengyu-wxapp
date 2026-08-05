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
 *
 * 多收余数（overpay，2026-07-18 ticket FY-XSD-WX-2607150028）：
 *   余数归属具体 sale_item：overpayRefundable(item) =
 *     max(0, item.received − 已消耗价值 − 当前可退整次/数量价值)
 *   发起退款时把该行余数并入同一个退款明细，不再创建新的订单级 OVERPAY 分摊行。
 *   OVERPAY_SENTINEL 仅保留用于历史 note 兼容。两端镜像 staffApi utils/refund.js。
 */

import type { PaymentMethod, ProductType, SalesCategory } from './types'

/** 多收余数退款哨兵 refSaleItemId（非空，禁用 null：refund-cascade.ts 空明细兜底会把全品项当全退） */
export const OVERPAY_SENTINEL = 'OVERPAY'

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
  sale_amount?: string | number | null
  received?: string | number | null
  picked_up_quantity: number | null
  sales_category: SalesCategory | null
  service_fee: string | number | null
  item_direction?: string
}

export interface RefundRequestItem {
  saleItemId: string
  refundQuantity?: number
  /** 是否把该 sale_item 自己的多收余数并入本次退款 */
  includeOverpay?: boolean
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
  saleAmount: number | null
  refundAmount: number
  salesCategory: SalesCategory | null
  serviceFee: number
  /** 本次是否全退该明细（退款数量 >= 当前可退数量）→ 控制 cascade 是否作废其分配/提成（Bug M） */
  isFullItemRefund: boolean
  /** 本明细并入的该 sale_item 行级多收余数 */
  overpayAmount?: number
  /** 历史多收余数退款哨兵行；新退款不再生成，仅用于旧 note 兼容 */
  isOverpay?: boolean
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
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
 * 计算每个 sale_item 自己的「多收余数」可退额（overpay）。两端镜像 staff utils/refund.js。
 *
 * 余数归属具体商品子项，退款某个子项时只能动该子项的 receipt：
 *   itemOverpay = max(0, item.received − 已消费价值 − 当前可退整次/数量价值)
 */
export function computeItemOverpayRemainders(origItems: RefundSourceItem[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const it of origItems || []) {
    const received = Number(it.received ?? 0) || 0
    if (received <= 0) {
      result.set(it.sale_item_id, 0)
      continue
    }
    const unitRealPrice = Number(it.unit_real_price) || 0
    const consumedQty =
      it.product_type === '疗程卡'
        ? Math.max(0, Number(it.session_count || 0) - Number(it.remaining_sessions || 0))
        : Math.max(0, Number(it.picked_up_quantity || 0))
    const consumedValue = consumedQty * unitRealPrice
    const maxRefundableValue = calculateUnusedQuantity(it) * unitRealPrice
    result.set(it.sale_item_id, Math.max(0, roundMoney(received - consumedValue - maxRefundableValue)))
  }
  return result
}

/**
 * 计算行级 overpay 合计。无行级 received 的旧单元测试/历史调用回退到旧订单级口径。
 */
export function computeOverpayRemainder(
  order: { received: string | number; refundedAmount?: string | number } | null | undefined,
  origItems: RefundSourceItem[],
): number {
  if (origItems.length > 0 && origItems.some((it) => it.received != null)) {
    let total = 0
    for (const amount of computeItemOverpayRemainders(origItems).values()) total += amount
    return roundMoney(total)
  }

  const netReceived = Math.max(
    0,
    (Number(order?.received) || 0) - (Number(order?.refundedAmount) || 0),
  )
  let consumedValue = 0
  let maxSessionRefundable = 0
  for (const it of origItems) {
    const urp = Number(it.unit_real_price) || 0
    if (it.product_type === '疗程卡') {
      const sc = Number(it.session_count) || 0
      const rem = Number(it.remaining_sessions) || 0
      consumedValue += Math.max(0, sc - rem) * urp
    } else {
      consumedValue += (Number(it.picked_up_quantity) || 0) * urp
    }
    maxSessionRefundable += calculateUnusedQuantity(it) * urp
  }
  consumedValue = roundMoney(consumedValue)
  maxSessionRefundable = roundMoney(maxSessionRefundable)
  return Math.max(0, roundMoney(netReceived - consumedValue - maxSessionRefundable))
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

  const overpayByItem = computeItemOverpayRemainders(origItems)
  const refundDetails: RefundDetail[] = []
  let totalRefund = 0

  for (const req of requestItems) {
    const orig = itemMap[req.saleItemId]
    if (!orig) throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 不存在`)

    const maxUnused = calculateUnusedQuantity(orig)
    const overpayAmount = req.includeOverpay === true
      ? Math.max(0, Number(overpayByItem.get(req.saleItemId) || 0))
      : 0
    // 疗程卡必须整卡全退（不支持部分退次数）：强制 requested = maxUnused，忽略前端传入的部分数量；
    // 家居产品仍可按未提货数量部分退。两端镜像 staff utils/refund.js。
    const requestedRaw = req.refundQuantity == null ? NaN : Number(req.refundQuantity)
    const wantsOverpayOnly = requestedRaw === 0 && overpayAmount > 0
    const requested = wantsOverpayOnly
      ? 0
      : orig.product_type === '疗程卡'
        ? maxUnused
        : (Number.isFinite(requestedRaw) && requestedRaw > 0 ? requestedRaw : maxUnused)

    if (requested <= 0 && overpayAmount <= 0) {
      throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 退款数量必须大于 0`)
    }
    if (requested > maxUnused) {
      throw new Error(`INVALID_STATE: 明细 ${req.saleItemId} 可退数量 ${maxUnused} 不足 ${requested}`)
    }

    const unitRealPrice = Number(orig.unit_real_price)
    const refundAmount = roundMoney(unitRealPrice * requested + overpayAmount)
    totalRefund += refundAmount

    // 退款行 service_fee 按比例扣减（原 service_fee 占比 × 退款数量占比）
    const origServiceFee = Number(orig.service_fee || 0)
    const origQty = Number(orig.quantity) || 1
    const refundServiceFee = -roundMoney((origServiceFee * requested) / origQty)

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
      saleAmount: orig.sale_amount == null ? null : Number(orig.sale_amount),
      refundAmount,
      salesCategory: orig.sales_category,
      serviceFee: refundServiceFee,
      overpayAmount,
      isFullItemRefund: requested >= maxUnused && consumedQty <= 0,
    })
  }

  return {
    refundDetails,
    totalRefund: roundMoney(totalRefund),
  }
}

/**
 * 0 元退项仅允许现有审批重算能真正扣减权益的场景：
 * 0 元疗程卡、零消费全退、且 sale_amount<=0 会命中 paid_sessions=0 覆盖。
 */
export function isZeroCashPaidSessionRefund(
  refundDetails: Array<{
    isOverpay?: boolean
    quantity?: number
    productType?: ProductType | null
    sessionCount?: number | null
    saleAmount?: string | number | null
    isFullItemRefund?: boolean
    unitRealPrice?: number
  }>,
  handlingFee: number,
  totalRefund: number,
): boolean {
  const fee = Math.max(0, Number(handlingFee) || 0)
  const total = Math.round((Number(totalRefund) || 0) * 100) / 100
  if (fee !== 0 || total !== 0) return false

  const itemRefunds = refundDetails.filter((d) => !d.isOverpay && Number(d.quantity || 0) > 0)
  // 允许 0 元退项的场景：
  // 1. 疗程卡：寄存单、优惠券全额抵扣的疗程卡（未消费可退）
  // 2. 非疗程卡：优惠券全额抵扣的商品（unit_real_price = 0）
  return itemRefunds.length > 0 && itemRefunds.every((d) => {
    // 通用条件：单次价为 0（优惠券全额抵扣）且全退
    const isUnconsumedZeroPrice = Number(d.unitRealPrice || 0) === 0 && d.isFullItemRefund === true

    // 疗程卡专属条件：寄存单（sale_amount <= 0）
    const isCourseCardDeposit = d.productType === '疗程卡' &&
      Number(d.sessionCount || 0) > 0 &&
      d.saleAmount != null &&
      Number(d.saleAmount) <= 0 &&
      d.isFullItemRefund === true

    return isUnconsumedZeroPrice || isCourseCardDeposit
  })
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
 * 手续费上限校验（疗程卡）：仅正手续费需要校验，且 0 元赠送疗程不参与最小单次价。
 *
 * fee >= 最小正价疗程单次价时，paid_sessions 反推会多留 floor(fee / price) 次；
 * 但赠送项 unit_real_price=0 不是可扣手续费的价格基准。
 */
export function isHandlingFeeInvalidForRefund(
  refundDetails: Array<{ productType: ProductType | null; unitRealPrice: number }>,
  handlingFee: number,
): boolean {
  const fee = Math.max(0, Number(handlingFee) || 0)
  if (fee <= 0) return false

  const positiveCardUnitPrices = refundDetails
    .filter((d) => d.productType === '疗程卡')
    .map((d) => Number(d.unitRealPrice))
    .filter((price) => Number.isFinite(price) && price > 0)

  return positiveCardUnitPrices.length > 0 && fee >= Math.min(...positiveCardUnitPrices)
}

/**
 * 拆分退款现金 vs 储值卡
 *
 * 2026-06-28 改为「全部走现金」：退款不再按储值卡占比拆分，refundByCard 始终为 0。
 * 所有退款统一走现金（refundByOrigin），避免用户退款拿到的现金和疗程卡对应金额不一致的误解，
 * 也避免了退款时出现剩余金额无法退款的情况。
 */
export function splitRefundByOriginalPayment(
  refundAmount: number,
  _origPrepaidCardAmount: number,
  _origTotalAmount: number,
): { refundByCard: number; refundByOrigin: number } {
  return {
    refundByCard: 0,
    refundByOrigin: Math.round(refundAmount * 100) / 100,
  }
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
