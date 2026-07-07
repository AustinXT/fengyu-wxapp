










export interface ServiceRateRow {
  department: string 
  amountMin: number
  amountMax: number
  serviceRates: Record<string, number>
}

const round2 = (n: number) => Math.round(Number(n) * 100) / 100


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

interface SummaryLine {
  staffWfId: string
  staffName: string
  roleType: string
  commissionAmount: string
}

interface SummaryDisplayItem {
  allocLines: SummaryLine[]
}


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
