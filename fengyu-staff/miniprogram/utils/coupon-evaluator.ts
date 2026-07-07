

export type CouponInListItem = {
  couponId: string
  discount: number | string
}

export type RevalidateResult =
  | { kind: 'cleared' }
  | { kind: 'updated'; discount: number }
  | { kind: 'noop' }

export function evaluateCouponAfterCartChange(
  selectedCouponId: string,
  selectedDiscount: number,
  availableCoupons: CouponInListItem[] | null | undefined
): RevalidateResult {
  const list = Array.isArray(availableCoupons) ? availableCoupons : []
  const still = list.find(c => c.couponId === selectedCouponId)
  if (!still) return { kind: 'cleared' }
  const newDiscount = Number(still.discount) || 0
  if (newDiscount !== selectedDiscount) {
    return { kind: 'updated', discount: newDiscount }
  }
  return { kind: 'noop' }
}
