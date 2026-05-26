/**
 * 优惠券重评估纯函数
 * cart 变动后调用 coupon.available 拿到新可用列表，
 * 此函数根据原选中券 ID/金额与新列表做决策，不做 side effect
 */

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
