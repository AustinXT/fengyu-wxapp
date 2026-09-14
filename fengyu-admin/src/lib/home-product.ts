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
  /** 已通过转换单折抵转走的数量（2026-09-14 #125，与已退款分列，二者同源于 picked_up_quantity） */
  convertedQuantity: number
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
  convertedQuantity = 0,
): HomeProductStatus {
  if (refundPending) return '退款处理中'
  if (pendingPickupQuantity > 0) return pickedQuantity > 0 ? '部分提货' : '待提货'
  // 「待付清」必须与欠款金额绑定：只有真的算得出欠款才这么标。
  // 否则寄存单（金额列留空）和退款后仍有剩余的行会被误标成待付清/已完成。
  // 注：#125 整行折抵后原单 received 不变（方案 A），欠款仍挂原单继续催收，故此处照常标「待付清」。
  if (unpaidAmount != null && unpaidAmount > 0) return '待付清'
  // 还有未交付份额但算不出欠款（寄存单、退款后剩余）——是待提，不是已完成。
  // 整行折抵后 remainingQuantity = purchased − settled = 0，不会落进这条分支。
  if (remainingQuantity > 0) return '待提货'
  return (refundedQuantity > 0 || convertedQuantity > 0) ? '已完成' : '已提货'
}
