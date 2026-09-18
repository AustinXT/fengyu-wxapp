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
  // 注：#182 起折抵会把原单该行欠款归零（下调 sale_amount / total_amount，下调量记在
  // sale_items.waived_amount，仅关闭/删除该转换单时还原），因此被折抵过的行算出来的
  // unpaidAmount 通常已是 0，不会再落进「待付清」。这条分支现在只服务**未被折抵**的欠款行。
  // （#125 的方案 A「received 不变、欠款仍挂原单继续催收」已作废。）
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
 *
 * ⚠️ **#182 起本函数的 `quantity` 只是「提货 / 退款」口径，不再是折抵数量。**
 *   折抵改为「整行退出」：一次带走该行**全部**物理未结算件（见 cards.ts / orders.ts 的
 *   `remainingQty`），`chk_item_quantity` 也已放宽到允许转出行 quantity = 0（纯余数行）。
 *   折抵只复用本函数的 `amount`（剩余已付，含不足一整件的余数）。
 *   **不要**再把 `homeDeductible().quantity` 当折抵件数用——那会把「1 件 ¥680 只付 ¥594」
 *   这类行重新算成 0 件而整行剔除，正是 #182 要修的缺陷。
 * - **金额**即剩余已付，含不足一整件的余数（用户 2026-09-14 拍板，顾客付的钱一分不丢）。
 * - 寄存单与 0 元赠品行没有「实收」可言，维持原口径 `单价 × 未结算件数`。
 *
 * 疗程卡不走本函数：#182 起它与家居共用「剩余已付」金额口径，但已交付价值按
 * （session_count − remaining_sessions）× 单价 算，与家居的 pickup_records 口径不同，
 * 故在 cards.ts / orders.ts 内按分单独计算，没有抽成公共函数。
 * 本函数的 `amount` 仍与 staffApi routes/order.js 的 `hp.deductible_amount` 家居分支同义；
 * `quantity` 则只对应提货侧的 `pendingHomeProductQuantity`，**不**对应折抵数量。
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

  // ⚠ 全程按「分」算：这些列都是 numeric(10,2)，staff 侧走 PG exact decimal，
  // admin 侧一旦用 IEEE-754 double 做减法/除法就会与它分叉。实测 unit=16.67 × 3 件、
  // received=50.01 时，浮点 floor 得 2 而 PG 得 3——admin 会落一条
  // `quantity=2 / received=-50.01` 的转出行（违反 sale_amount = unit × quantity），
  // 源行只 +2 件，展示侧按 SUM(quantity)=2 算，第 3 件仍可提 → 超发一件。
  const toCents = (v: number) => Math.round(v * 100)
  const unitCents = toCents(unit)
  const remainingCents = Math.max(
    0,
    toCents(received) - picked * unitCents - toCents(convertedAmount),
  )
  return {
    quantity: unitCents > 0 ? Math.min(physicalRemaining, Math.floor(remainingCents / unitCents)) : 0,
    amount: remainingCents / 100,
  }
}

/**
 * 可提货 / 可折抵的方向判据（#145 / #153）：购买行，或转换单换入行。
 *
 * admin 三处站点共用（提货候选与闸门 `actions/pickup-records.ts`、
 * 转换折抵锁内复算 `actions/orders.ts`），与 staffApi routes/order.js
 * 的 `isConvertibleEntitlementRow` 跨端同义，由 cross-end snapshot 守护。
 * 内联复制会成为脱缰的漂移向量——改一端漏改另一端测不出来。
 */
export function isConvertibleEntitlementRow(row: {
  item_direction: string
  sale_order_type: string
}): boolean {
  return row.item_direction === '购买'
    || (row.sale_order_type === '转换单' && row.item_direction === '转入')
}
