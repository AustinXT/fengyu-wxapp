

interface CartItem {
  price: number
  
  listPrice?: number
  quantity: number
}


export function calcCartTotal(cart: CartItem[]): { count: number; total: string } {
  const count = cart.reduce((s, c) => s + c.quantity, 0)
  const total = cart.reduce((s, c) => s + c.price * c.quantity, 0)
  return { count, total: total.toFixed(2) }
}


export function calcHalfPriceTotal(cart: CartItem[]): string {
  const total = cart.reduce((s, c) => {
    const halfUnit = Math.round((c.listPrice ?? c.price) * 50) / 100
    return s + halfUnit * c.quantity
  }, 0)
  return total.toFixed(2)
}


export function allocateCouponPerLine(priceLines: number[], couponAmount: number): number[] {
  const total = priceLines.reduce((s, x) => s + x, 0)
  const coupon = Math.max(0, Math.min(couponAmount, total))
  if (coupon <= 0 || total <= 0) {
    return priceLines.map(() => 0)
  }
  const n = priceLines.length
  const shares: number[] = []
  let acc = 0
  for (let i = 0; i < n - 1; i++) {
    const raw = (coupon * priceLines[i]) / total
    const cent = Math.round(raw * 100) / 100
    shares.push(cent)
    acc += cent
  }
  
  const last = Math.round((coupon - acc) * 100) / 100
  shares.push(Math.max(0, last))
  return shares
}
