// V2 原型目标规则。所有金额先转为分，避免第 4 周余额出现浮点误差。
export function cents(value: any, positive: any = false) {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw Error('INVALID_PARAMS: 请填写有效金额')
  const raw = String(value).trim()
  if (!/^\d+(\.\d{1,2})?$/.test(raw))
    throw Error('INVALID_PARAMS: 金额最多保留两位小数')
  const [whole, fraction = ''] = raw.split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(amount) || (positive && amount <= 0))
    throw Error('INVALID_PARAMS: 月目标必须大于 0，且金额不能超出范围')
  return amount
}

export function distributeByDays(total: number, days: number[]) {
  if (!Number.isSafeInteger(total) || total < 0 || days.length !== 4 || days.some((day) => !Number.isSafeInteger(day) || day <= 0))
    throw Error('INVALID_PARAMS: 无效的目标分摊参数')
  const totalDays = days.reduce((sum, day) => sum + BigInt(day), BigInt(0))
  const totalValue = BigInt(total)
  let used = BigInt(0)
  return days.map((day, index) => {
    const value = index === days.length - 1 ? totalValue - used : totalValue * BigInt(day) / totalDays
    used += value
    return Number(value)
  })
}

export function validateMonth(input: any, scope: any) {
  if (!['personal', 'store', 'market'].includes(scope))
    throw Error('INVALID_PARAMS: 无效目标范围')
  const penalty = String(input.penalty || '').trim()
  if (penalty.length > 500 || (scope === 'personal' && !penalty))
    throw Error('INVALID_PARAMS: 请填写不超过500字的本月负激励')
  return {
    sales: cents(input.sales, true),
    consumption: cents(input.consumption, true),
    penalty: scope === 'personal' ? penalty : '',
  }
}

// 第一至第三周目标未齐全时，第四周保持未设置；不把空值当作零。
export function weeklyTargets(
  monthCents: any,
  firstThree: any,
  allowZero: any = false,
) {
  if (
    !Number.isSafeInteger(monthCents) ||
    (allowZero ? monthCents < 0 : monthCents <= 0) ||
    !Array.isArray(firstThree) ||
    firstThree.length !== 3
  )
    throw Error('INVALID_PARAMS: 无效月周目标')
  for (const value of firstThree) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      throw Error('INVALID_PARAMS: 周目标必须是非负金额')
  }
  const used = firstThree.reduce(
    (sum: any, value: any) => sum + (value ?? 0),
    0,
  )
  if (!Number.isSafeInteger(used) || used > monthCents)
    throw Error('INVALID_PARAMS: 前三周目标累计不能超过月目标')
  return [...firstThree, firstThree.includes(null) ? null : monthCents - used]
}

export function count(value: any) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !/^\d+$/.test(String(value).trim())
  )
    throw Error('INVALID_PARAMS: 客量、新客、项目数须为非负整数')
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n > 2147483647)
    throw Error('INVALID_PARAMS: 计数目标超出范围')
  return n
}
export const countKeys = ['visits', 'newCustomers', 'projects']
export function validateCounts(payload: any) {
  if (countKeys.every((key: any) => payload[key] === undefined)) return null
  if (countKeys.some((key: any) => payload[key] === undefined))
    throw Error('INVALID_PARAMS: 请填写完整的三项计数目标')
  return Object.fromEntries(
    countKeys.map((key: any) => [key, count(payload[key])]),
  )
}
