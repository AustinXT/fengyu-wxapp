// packageOrder/utils/service-commission-calc.ts — 服务提成计算
//
// 与销售侧 allocation-calc 的关键区别：rate tier 命中键是每行 consumeBase
// （= unit_real_price × session_used，整池不乘 ratio），不是订单总额。
// 与员工端 service.complete / admin service-commissions 修正后公式一致：
//   consumeBase   = round(unit_real_price × session_used, 2)
//   allocAmount   = round(consumeBase × ratio, 2)
//   consumeAmount = round(allocAmount × rate, 2)            // = consumeBase × ratio × rate
//   #379 阈值保底：命中行 priceThreshold > 单次实价时，consumeAmount 改用
//   effConsumeBase = round(max(单次实价, 阈值) × session_used, 2) 代替 consumeBase；分配额与选档不变
//   fixedFee      = round(service_fee × session_used × ratio, 2)
//   commissionAmount = round(fixedFee + consumeAmount, 2)

export interface ServiceRateRow {
  department: string // role_type
  amountMin: number
  amountMax: number
  serviceRates: Record<string, number>
  /** #379 各销售分类的划卡单价阈值（null / 缺省 = 不启用） */
  serviceThresholds?: Record<string, number | null>
}

export interface ServiceRateHit {
  rate: number
  /** 命中行阈值；0 = 不启用 */
  priceThreshold: number
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
): ServiceRateHit {
  let hit: ServiceRateRow | null = null
  for (const r of rates) {
    if (r.department !== role) continue
    if (consumeBase < r.amountMin || consumeBase > r.amountMax) continue
    const rate = r.serviceRates[salesCat]
    if (!rate || rate <= 0) continue
    if (!hit || r.amountMin > hit.amountMin) hit = r
  }
  if (!hit) return { rate: 0, priceThreshold: 0 }
  return {
    rate: hit.serviceRates[salesCat] || 0,
    priceThreshold: Number(hit.serviceThresholds?.[salesCat]) || 0,
  }
}

/** #379 计提成基数：round(max(单次实价, 阈值) × 次数, 2)，与五个写入副本同口径 */
export function effServiceConsumeBase(perSession: number, sessionUsed: number, priceThreshold: number): number {
  return round2(Math.max(perSession, priceThreshold || 0) * sessionUsed)
}

/**
 * 给定整池 consumeBase / fixedFeeBase（均未乘 ratio）+ ratio + rate，算分配额与提成额。
 * fixedFeeBase = service_fee × session_used。
 */
export function computeServiceLine(
  consumeBase: number,
  fixedFeeBase: number,
  ratio: number,
  rate: number,
  effConsumeBase: number = consumeBase
): { allocAmount: string; commissionAmount: string } {
  const allocAmount = round2(consumeBase * ratio)
  const consumeAmount = round2(round2(effConsumeBase * ratio) * rate)
  const fixedFee = round2(fixedFeeBase * ratio)
  const commissionAmount = round2(fixedFee + consumeAmount)
  return { allocAmount: allocAmount.toFixed(2), commissionAmount: commissionAmount.toFixed(2) }
}

interface SummaryLine {
  staffWfId: string
  staffName: string
  roleType: string
  commissionAmount: string
}

interface SummaryDisplayItem {
  allocLines: SummaryLine[]
}

/**
 * 汇总服务提成：按员工+技能标签聚合**提成额**，合计为提成额合计。
 * 对齐销售侧 allocation-calc.computeSummary。
 */
export function computeServiceSummary(displayItems: SummaryDisplayItem[]): {
  summary: Array<{ staffName: string; department: string; total: string }>
  grandTotal: string
} {
  const map = new Map<string, { staffName: string; department: string; total: number }>()
  let grand = 0
  for (const di of displayItems) {
    for (const l of di.allocLines) {
      const amt = parseFloat(l.commissionAmount) || 0
      grand += amt
      if (l.staffWfId) {
        const key = `${l.staffWfId}_${l.roleType}`
        const existing = map.get(key)
        if (existing) {
          existing.total += amt
        } else {
          map.set(key, { staffName: l.staffName, department: l.roleType, total: amt })
        }
      }
    }
  }
  const summary = Array.from(map.values()).map(s => ({
    staffName: s.staffName,
    department: s.department,
    total: s.total.toFixed(2),
  }))
  return { summary, grandTotal: grand.toFixed(2) }
}
