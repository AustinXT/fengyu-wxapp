export type HomeProductStatus = '退款处理中' | '待提货' | '部分提货' | '已提货' | '已完成'

export interface CustomerHomeProduct {
  saleItemId: string
  saleOrderId: string
  productName: string
  unit: string
  purchasedQuantity: number
  pickedQuantity: number
  refundedQuantity: number
  remainingQuantity: number
  status: HomeProductStatus
  storeId: string
  storeName: string | null
  purchasedAt: string
}

export function deriveHomeProductStatus(
  refundPending: boolean,
  pickedQuantity: number,
  refundedQuantity: number,
  remainingQuantity: number,
): HomeProductStatus {
  if (refundPending) return '退款处理中'
  if (remainingQuantity > 0) return pickedQuantity > 0 ? '部分提货' : '待提货'
  return refundedQuantity > 0 ? '已完成' : '已提货'
}
