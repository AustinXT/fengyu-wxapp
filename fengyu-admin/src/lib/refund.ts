

import type { PaymentMethod, ProductType, SalesCategory } from './types'


export interface RefundSourceItem {
  sale_item_id: string
  sku_id: string | null
  product_name: string | null
  product_type: ProductType | null
  session_count: number | null
  remaining_sessions: number | null
  
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
  
  isFullItemRefund: boolean
}


export function calculateUnusedQuantity(item: RefundSourceItem | null | undefined): number {
  if (!item) return 0
  if (item.product_type === '疗程卡') {
    
    
    
    const remaining = Number(item.remaining_sessions || 0)
    if (item.paid_sessions == null) return remaining
    const consumed = Number(item.session_count || 0) - remaining
    return Math.max(0, Math.min(remaining, Number(item.paid_sessions) - consumed))
  }
  const quantity = Number(item.quantity || 0)
  const pickedUp = Number(item.picked_up_quantity || 0)
  return Math.max(0, quantity - pickedUp)
}


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

    
    const origServiceFee = Number(orig.service_fee || 0)
    const origQty = Number(orig.quantity) || 1
    const refundServiceFee = -Math.round((origServiceFee * requested) / origQty * 100) / 100

    
    
    
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


export function resolveRefundPaymentMethod(
  _origPaymentMethod?: PaymentMethod | '储值卡' | null | undefined,
): PaymentMethod {
  return '线下'
}
