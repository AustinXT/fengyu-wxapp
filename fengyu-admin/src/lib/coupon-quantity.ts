/**
 * 优惠券发放数量共享约束。
 *
 * 单场景、单模板的发放数量上限。会员权益自动发券（升级/生日/感恩日 cron）与
 * 后台手动发券（issueCoupon）共用，避免误填巨数导致 user_coupons 一次性暴涨。
 * 上限可在此处统一调整。
 */
export const MAX_COUPON_QUANTITY = 99

/**
 * 把任意输入规范成 [1, MAX_COUPON_QUANTITY] 的整数。
 * 缺省 / NaN / 非法值 → 1；小数向下取整；超上限截到上限。
 *
 * 兼容旧配置：DB 中现存的 member_level_benefits / birthday_benefits / thanksgiving_benefits
 * JSON 没有 couponQuantities 字段，读取时传入 undefined，回退为 1 张。
 */
export function clampCouponQuantity(raw: unknown): number {
  const n = Math.floor(Number(raw) || 1)
  return Math.max(1, Math.min(MAX_COUPON_QUANTITY, n))
}
