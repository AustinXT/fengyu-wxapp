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

/**
 * 家居产品的「可折抵件数 / 可折抵金额」（#145 / #153 收紧口径）
 *
 * #125 原口径按「未提货件数 × 单价」整行折抵、不看付款进度，可以把未兑现价值洗成全额可提：
 * 10 件 ¥1000 只付 ¥400（欠 ¥600）→ 折 ¥1000 换等额家居 → 新行 10 件全可提，欠款仍留原单
 * （dev 真库实证）。改为以**剩余已付金额**为基准：
 *
 *     剩余已付 = 行实收 − 已提货金额 − 已转走金额
 *
 * - **已转走金额**取自转出行的 `received` 聚合，**不是** `已转走件数 × 单价`——折抵金额含余数时
 *   两者不等（折 4 件带走 ¥450 而非 ¥400），用件数推算会让多次折抵累计超过累计实收。
 * - **退款不在此处扣**：`received` 已由 paid-sessions STEP 1.5 扣过逐项退款，
 *   而 `picked_up_quantity` 又包含退款结算数，两边都减就是重复扣减（顾客少折）。
 * - **件数**向下取整：`floor(剩余已付 / 单价)`，再受物理未结算件数封顶。
 *   转出行受 `chk_item_quantity > 0` 约束，不足一整件时没有载体可折，整行不可折抵
 *   （已付款留原单，付清后即可折抵或提货）。
 * - **金额**即剩余已付，含不足一整件的余数（用户 2026-09-14 拍板，顾客付的钱一分不丢）。
 * - 寄存单与 0 元赠品行没有「实收」可言，维持原口径 `单价 × 未结算件数`。
 *
 * 疗程卡不走本函数（维持 #125 的 remaining_sessions 口径）。
 * 与 staffApi routes/order.js 的 `hp.deductible_quantity` / `hp.deductible_amount` LATERAL 跨端同义。
 */
export function homeDeductible(row: {
  saleOrderType: string | null
  quantity: number
  pickedUpQuantity: number | null
  /** 该行 pickup_records 的物理提货合计（不含退款、不含折抵） */
  pickedQuantity: number | null
  /** 该行已被折抵转走的金额合计（转出行 received 取正，排除已关闭的转换单） */
  convertedAmount: string | number | null
  saleAmount: string | number | null
  received: string | number | null
  unitRealPrice: string | number | null
}): { quantity: number; amount: number } {
  const qty = Number(row.quantity ?? 0)
  const settled = Math.max(0, Number(row.pickedUpQuantity ?? 0))
  const picked = Math.max(0, Number(row.pickedQuantity ?? 0))
  const convertedAmount = Math.max(0, Number(row.convertedAmount ?? 0))
  const saleAmount = Number(row.saleAmount ?? 0)
  const received = Number(row.received ?? 0)
  const unit = Number(row.unitRealPrice ?? 0)
  const physicalRemaining = Math.max(0, qty - settled)

  if (row.saleOrderType === '寄存单' || saleAmount <= 0) {
    return { quantity: physicalRemaining, amount: unit * physicalRemaining }
  }

  const remainingPaid = Math.max(0, received - picked * unit - convertedAmount)
  // ⚠ 必须按「分」做整除：staff 侧是 PG numeric 精确除法，JS 浮点直除会分叉——
  // 例如 remainingPaid=300.27 / unit=100.09，浮点得 2.9999999999999996 → floor 2，
  // 而 PG 得 3。候选（SQL）放行 3 件、锁内复算（JS）只折 2 件，双端与候选/闸门全都对不上。
  const toCents = (v: number) => Math.round(v * 100)
  const unitCents = toCents(unit)
  return {
    quantity: unitCents > 0
      ? Math.min(physicalRemaining, Math.floor(toCents(remainingPaid) / unitCents))
      : 0,
    amount: remainingPaid,
  }
}
