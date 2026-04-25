/**
 * 退款工具函数
 *
 * 核心规则（ticket 2026-04-24-refund-admin-parity-and-rules §1.2）：
 *   refundable_per_item = 未使用数量 × unit_real_price
 *   total_refundable    = Σ(refundable_per_item)
 *   final_refund_amount = max(0, total_refundable − handling_fee)
 *
 * 未使用数量按 sale_items.product_type 区分：
 *   疗程卡：remaining_sessions
 *   单品 / 院装产品：quantity − picked_up_quantity
 */

/**
 * 计算单个 sale_item 的可退未使用数量
 * @param {object} item sale_items 行（snake_case 字段）
 * @returns {number} 可退数量（≥0）
 */
function calculateUnusedQuantity(item) {
  if (!item) return 0
  if (item.product_type === '疗程卡') {
    return Number(item.remaining_sessions || 0)
  }
  const quantity = Number(item.quantity || 0)
  const pickedUp = Number(item.picked_up_quantity || 0)
  return Math.max(0, quantity - pickedUp)
}

/**
 * 校验并构建退款明细
 *
 * @param {Array<object>} origItems 原单 sale_items（item_direction='购买'）
 * @param {Array<{saleItemId: string, refundQuantity?: number}>} requestItems 前端请求
 * @returns {{ refundDetails: Array, totalRefund: number }}
 * @throws Error INVALID_PARAMS / INVALID_STATE
 */
function buildRefundDetails(origItems, requestItems) {
  const itemMap = {}
  for (const i of origItems) itemMap[i.sale_item_id] = i

  const refundDetails = []
  let totalRefund = 0

  for (const req of requestItems) {
    const orig = itemMap[req.saleItemId]
    if (!orig) throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 不存在`)

    const maxUnused = calculateUnusedQuantity(orig)
    const requested = Number(req.refundQuantity) || maxUnused

    if (requested <= 0) {
      throw new Error(`INVALID_PARAMS: 明细 ${req.saleItemId} 退款数量必须大于 0`)
    }
    if (requested > maxUnused) {
      throw new Error(
        `INVALID_STATE: 明细 ${req.saleItemId} 可退数量 ${maxUnused} 不足 ${requested}`,
      )
    }

    const unitRealPrice = Number(orig.unit_real_price)
    const refundAmount = Math.round(unitRealPrice * requested * 100) / 100
    totalRefund += refundAmount

    // 退款行 service_fee 按比例扣减（原 service_fee 占比 × 退款数量占比）
    const origServiceFee = Number(orig.service_fee || 0)
    const origQty = Number(orig.quantity) || 1
    const refundServiceFee = -Math.round((origServiceFee * requested / origQty) * 100) / 100

    refundDetails.push({
      refSaleItemId: req.saleItemId,
      skuId: orig.sku_id,
      productName: orig.product_name,
      skuSpecName: orig.sku_spec_name,
      productType: orig.product_type,
      sessionCount: orig.session_count,
      unitPrice: Number(orig.unit_price),
      quantity: requested,
      unitRealPrice,
      refundAmount,
      salesCategory: orig.sales_category,
      serviceFee: refundServiceFee,
      isShengmei: orig.is_shengmei ?? null,
    })
  }

  return {
    refundDetails,
    totalRefund: Math.round(totalRefund * 100) / 100,
  }
}

/**
 * 按原单储值卡抵扣比例，将退款金额拆为储值卡回冲 + 原路径退款
 *
 *   refundByCard   = floor(origPrepaidCardAmount / origTotalAmount × refundAmount, 2)
 *   refundByOrigin = refundAmount − refundByCard   // 反向相减，无尾差
 *
 * @param {number} refundAmount 本次退款金额（正数，已扣 handling_fee）
 * @param {number} origPrepaidCardAmount 原单储值卡抵扣部分
 * @param {number} origTotalAmount 原单总金额
 * @returns {{ refundByCard: number, refundByOrigin: number }}
 */
function splitRefundByOriginalPayment(refundAmount, origPrepaidCardAmount, origTotalAmount) {
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
 * 过渡期：微信/支付宝退款 API 未集成前，原单微信/支付宝通道的退款
 * 暂用 '线下' 承接（需店员现场退现或走其他渠道），下一 ticket 集成三方 refund
 * API 后改为 '微信'/'支付宝' + external_txn_id。
 *
 * @param {string} origPaymentMethod 原单 payment_method 枚举值
 * @returns {string} 退款行的 payment_method
 */
function resolveRefundPaymentMethod(origPaymentMethod) {
  if (origPaymentMethod === '微信' || origPaymentMethod === '支付宝') {
    return '线下'
  }
  if (!origPaymentMethod || origPaymentMethod === '无') {
    return '线下'
  }
  return origPaymentMethod
}

module.exports = {
  calculateUnusedQuantity,
  buildRefundDetails,
  splitRefundByOriginalPayment,
  resolveRefundPaymentMethod,
}
