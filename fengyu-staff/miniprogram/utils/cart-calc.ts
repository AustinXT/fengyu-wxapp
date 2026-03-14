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
