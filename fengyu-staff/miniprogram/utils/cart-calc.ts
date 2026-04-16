// utils/cart-calc.ts — 购物车计算

interface CartItem {
  price: number
  quantity: number
  discount: number
}

/**
 * 计算购物车汇总
 */
export function calcCartTotal(cart: CartItem[]): { count: number; total: string } {
  const count = cart.reduce((s, c) => s + c.quantity, 0)
  const total = cart.reduce((s, c) => s + c.price * c.quantity - c.discount, 0)
  return { count, total: total.toFixed(2) }
}

/**
 * PR-C §C2 — 计算内部单半价合计
 * 内部单下所有行统一按 price × 0.5 × quantity 计算；discount 禁用（前端UI已禁）但若有残值仍会减去
 * （与云函数 order.create 内部单分支对齐：basePrice × 0.5 × quantity，discount 需 >= 0）
 */
export function calcHalfPriceTotal(cart: CartItem[]): string {
  const total = cart.reduce((s, c) => {
    const halfUnit = Math.round(c.price * 50) / 100 // 防浮点
    return s + halfUnit * c.quantity - (c.discount || 0)
  }, 0)
  return total.toFixed(2)
}
