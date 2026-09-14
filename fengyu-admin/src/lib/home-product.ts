export type HomeProductStatus = '退款处理中' | '待提货' | '部分提货' | '已提货' | '已完成' | '待付清'

export interface CustomerHomeProduct {
  saleItemId: string
  saleItemGroupId: string | null
  saleOrderId: string
  productName: string
  unit: string
  purchasedQuantity: number
  paidQuantity: number
  pickedQuantity: number
  refundedQuantity: number
  remainingQuantity: number
  pendingPickupQuantity: number
  /** 行级欠款；仅 refundedQuantity=0 时有值，退过款的行为 null（received 是净实收，相减会虚增欠款） */
  unpaidAmount: number | null
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
  remainingQuantity: number,
  unpaidAmount: number | null,
): HomeProductStatus {
  if (refundPending) return '退款处理中'
  if (pendingPickupQuantity > 0) return pickedQuantity > 0 ? '部分提货' : '待提货'
  // 「待付清」必须与欠款金额绑定：只有真的算得出欠款才这么标。
  // 否则寄存单（金额列留空）和退款后仍有剩余的行会被误标成待付清/已完成。
  if (unpaidAmount != null && unpaidAmount > 0) return '待付清'
  // 还有未交付份额但算不出欠款（寄存单、退款后剩余）——是待提，不是已完成。
  if (remainingQuantity > 0) return '待提货'
  return refundedQuantity > 0 ? '已完成' : '已提货'
}
