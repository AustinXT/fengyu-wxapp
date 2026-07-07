
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
    
    
    const fromDate = input.validFrom.slice(0, 10)
    const toDate = input.validTo.slice(0, 10)
    const fromStart = new Date(`${fromDate}T00:00:00+08:00`)
    const toEnd = new Date(`${toDate}T23:59:59+08:00`)
    if (Number.isNaN(fromStart.getTime()) || Number.isNaN(toEnd.getTime())) {
      return { ok: false, message: '"固定时段"模式需同时填写开始与结束日期' }
    }
    
    if (fromDate >= toDate) {
      return { ok: false, message: "有效期开始日期必须早于结束日期" }
    }
    if (toEnd <= new Date()) {
      return { ok: false, message: "有效期结束日期必须晚于当前时间" }
    }
  }
  return { ok: true }
}
