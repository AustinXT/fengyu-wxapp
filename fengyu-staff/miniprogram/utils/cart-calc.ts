// utils/cart-calc.ts — 购物车计算（按行模型 v2：价格 / 应付金额 / 实付金额）

interface CartItem {
  price: number
  /** 标价（划线原价）；内部单半价以此为准，缺省降级为 price */
  listPrice?: number
  quantity: number
}

/**
 * 计算购物车原价合计（"价格"列汇总，未摊券）。
 * 用于显示「价格合计」/ 内部单半价基础。
 */
export function calcCartTotal(cart: CartItem[]): { count: number; total: string } {
  const count = cart.reduce((s, c) => s + c.quantity, 0)
  const total = cart.reduce((s, c) => s + c.price * c.quantity, 0)
  return { count, total: total.toFixed(2) }
}

/**
 * 内部单半价合计：每行按 标价(listPrice) × 0.5 × quantity（与云函数 order.create 内部单分支对齐，
 * 不取会员价；listPrice 缺省时降级为 price）。
 */
export function calcHalfPriceTotal(cart: CartItem[]): string {
  const total = cart.reduce((s, c) => {
    const halfUnit = Math.round((c.listPrice ?? c.price) * 50) / 100
    return s + halfUnit * c.quantity
  }, 0)
  return total.toFixed(2)
}

/**
 * 疗程卡阶梯价按总价反推单行金额。
 * - tierAmount = 阶梯 SKU 总价
 * - tierSessions = 阶梯 SKU 总次数
 * - lineSessions = 当前行总次数
 *
 * 不先圆整单次价，避免 8800 / 30 这类金额回乘后丢分。
 */
export function calcTierLineAmount(tierAmount: number, tierSessions: number, lineSessions: number): number {
  const amount = Math.max(0, Number(tierAmount) || 0)
  const sessions = Math.max(0, Number(tierSessions) || 0)
  const line = Math.max(0, Number(lineSessions) || 0)
  if (amount <= 0 || sessions <= 0 || line <= 0) {
    return 0
  }
  return Math.round((amount * line * 100) / sessions) / 100
}

/**
 * 按行应付比例分摊订单级抵扣（优惠券 / 积分）。
 * - 入参 priceLines = 各行 价格×数量（已含内部单半价处理）
 * - 出参 shares[i] = 摊到 i 行的抵扣（元，2 位精度）
 * - 尾差消化到最后一行，保证 Σ shares = discountAmount（在合法范围内）
 * - discountAmount > Σ priceLines 时按 Σ priceLines 截断
 */
export function allocateDiscountPerLine(priceLines: number[], discountAmount: number): number[] {
  const total = priceLines.reduce((s, x) => s + x, 0)
  const discount = Math.max(0, Math.min(discountAmount, total))
  if (discount <= 0 || total <= 0) {
    return priceLines.map(() => 0)
  }
  const n = priceLines.length
  const shares: number[] = []
  const discountCents = Math.round(discount * 100)
  let allocatedCents = 0
  for (let i = 0; i < n - 1; i++) {
    const raw = (discount * priceLines[i]) / total
    const remainingCents = discountCents - allocatedCents
    const shareCents = Math.min(Math.round(raw * 100), remainingCents)
    shares.push(shareCents / 100)
    allocatedCents += shareCents
  }
  // 末行吸收尾差
  shares.push((discountCents - allocatedCents) / 100)
  return shares
}
