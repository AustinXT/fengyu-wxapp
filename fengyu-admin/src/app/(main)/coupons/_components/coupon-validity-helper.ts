/**
 * 前端 validity 字段校验 helper。
 * 错误消息必须与后端 `validateValidityFields`（src/actions/coupons.ts）字符级一致，
 * 以保证 AC-1/AC-2 的前后端双保险体验一致。
 *
 * 被 `coupon-create-page.tsx` 和 `coupon-detail-page.tsx` 同时消费，
 * 故抽为独立纯函数模块。
 */
export function validateCouponValidityFields(input: {
  validityMode: "days" | "fixed"
  validDays?: string
  validFrom?: string
  validTo?: string
}): { ok: true } | { ok: false; message: string } {
  if (input.validityMode !== "days" && input.validityMode !== "fixed") {
    return { ok: false, message: "有效期模式必须为 days 或 fixed" }
  }
  if (input.validityMode === "days") {
    const raw = input.validDays ?? ""
    const vd = Number(raw)
    if (!raw.trim() || !Number.isInteger(vd) || vd <= 0) {
      return { ok: false, message: '"领取后 N 天"模式需填写正整数有效天数' }
    }
    if (vd > 3650) {
      return { ok: false, message: "有效天数不能超过 3650 天（10 年）" }
    }
  }
  if (input.validityMode === "fixed") {
    if (!input.validFrom || !input.validTo) {
      return { ok: false, message: '"固定时段"模式需同时填写开始与结束日期' }
    }
    const from = new Date(input.validFrom)
    const to = new Date(input.validTo)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return { ok: false, message: '"固定时段"模式需同时填写开始与结束日期' }
    }
    if (from >= to) {
      return { ok: false, message: "有效期开始日期必须早于结束日期" }
    }
    if (to <= new Date()) {
      return { ok: false, message: "有效期结束日期必须晚于当前时间" }
    }
  }
  return { ok: true }
}
