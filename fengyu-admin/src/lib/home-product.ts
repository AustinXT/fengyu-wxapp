export type HomeProductStatus = '退款处理中' | '待提货' | '部分提货' | '已提货' | '已完成'

export interface CustomerHomeProduct {
  saleItemId: string
  saleOrderId: string
  productName: string
  unit: string
  purchasedQuantity: number
  paidQuantity: number
  pickedQuantity: number
  refundedQuantity: number
  /** 已通过转换单折抵转走的数量（2026-09-14 #125，与已退款分列，二者同源于 picked_up_quantity） */
  convertedQuantity: number
  remainingQuantity: number
  pendingPickupQuantity: number
  status: HomeProductStatus
  storeId: string
  storeName: string | null
  purchasedAt: string
}

export function deriveHomeProductStatus(
  refundPending: boolean,
  pickedQuantity: number,
  refundedQuantity: number,
  pendingPickupQuantity: number,
  convertedQuantity = 0,
): HomeProductStatus {
  if (refundPending) return '退款处理中'
  if (pendingPickupQuantity > 0) return pickedQuantity > 0 ? '部分提货' : '待提货'
  return (refundedQuantity > 0 || convertedQuantity > 0) ? '已完成' : '已提货'
}
