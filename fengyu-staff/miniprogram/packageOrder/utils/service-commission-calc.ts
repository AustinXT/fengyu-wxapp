// packageOrder/utils/service-commission-calc.ts — 服务提成计算
//
// 与销售侧 allocation-calc 的关键区别：rate tier 命中键是每行 consumeBase
// （= unit_real_price × session_used，整池不乘 ratio），不是订单总额。
// 与员工端 service.complete / admin service-commissions 修正后公式一致：
//   consumeBase   = round(unit_real_price × session_used, 2)
//   allocAmount   = round(consumeBase × ratio, 2)
//   consumeAmount = round(allocAmount × rate, 2)            // = consumeBase × ratio × rate
//   fixedFee      = round(service_fee × session_used × ratio, 2)
//   commissionAmount = round(fixedFee + consumeAmount, 2)

export interface ServiceRateRow {
  department: string // role_type
  amountMin: number
  amountMax: number
  serviceRates: Record<string, number>
}

const round2 = (n: number) => Math.round(Number(n) * 100) / 100

/**
 * 服务单提成比例查找（tier 命中 consumeBase；多 tier 取 amountMin 最大者，跳过 rate<=0）。
 */
export function lookupServiceRate(
  role: string,
  salesCat: string,
  consumeBase: number,
  rates: ServiceRateRow[]
): number {
  let hit: ServiceRateRow | null = null
  for (const r of rates) {
    if (r.department !== role) continue
    if (consumeBase < r.amountMin || consumeBase > r.amountMax) continue
    const rate = r.serviceRates[salesCat]
    if (!rate || rate <= 0) continue
    if (!hit || r.amountMin > hit.amountMin) hit = r
  }
  return (hit && hit.serviceRates[salesCat]) || 0
}

/**
 * 给定整池 consumeBase / fixedFeeBase（均未乘 ratio）+ ratio + rate，算分配额与提成额。
 * fixedFeeBase = service_fee × session_used。
 */
export function computeServiceLine(
  consumeBase: number,
  fixedFeeBase: number,
  ratio: number,
  rate: number
): { allocAmount: string; commissionAmount: string } {
  const allocAmount = round2(consumeBase * ratio)
  const consumeAmount = round2(allocAmount * rate)
  const fixedFee = round2(fixedFeeBase * ratio)
  const commissionAmount = round2(fixedFee + consumeAmount)
  return { allocAmount: allocAmount.toFixed(2), commissionAmount: commissionAmount.toFixed(2) }
}
