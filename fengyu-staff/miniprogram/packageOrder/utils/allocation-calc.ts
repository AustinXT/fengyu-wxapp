

interface RateRow {
  department: string
  amountMin: number
  amountMax: number
  orderRates: Record<string, number>
}

interface AllocLine {
  staffWfId: string
  staffName: string
  roleType: string
  commissionAmount: string
}

interface DisplayItem {
  allocLines: AllocLine[]
}


export function lookupRate(
  dept: string,
  salesCat: string,
  receivable: number,
  beautyRates: Record<string, Record<string, number>>,
  rates: RateRow[],
  totalAmount: number
): { commissionRate: number; amount: string } {
  
  
  
  let hit: RateRow | null = null
  for (const r of rates) {
    if (r.department !== dept) continue
    if (totalAmount < r.amountMin || totalAmount > r.amountMax) continue
    const rate = r.orderRates[salesCat]
    if (!rate || rate <= 0) continue
    if (!hit || r.amountMin > hit.amountMin) hit = r
  }
  if (hit) {
    const commRate = hit.orderRates[salesCat] || 0
    return { commissionRate: commRate, amount: (receivable * commRate).toFixed(2) }
  }

  
  if (beautyRates[dept]) {
    const commRate = beautyRates[dept][salesCat] || 0
    return { commissionRate: commRate, amount: (receivable * commRate).toFixed(2) }
  }

  return { commissionRate: 0, amount: '0.00' }
}


export function computeSummary(displayItems: DisplayItem[]): {
  summary: Array<{ staffName: string; department: string; total: string }>
  grandTotal: string
  hasUnassigned: boolean
} {
  const map = new Map<string, { staffName: string; department: string; total: number }>()
  let grand = 0
  let hasUnassigned = false
  for (const di of displayItems) {
    for (const l of di.allocLines) {
      const amt = parseFloat(l.commissionAmount) || 0
      if (l.staffWfId) {
        grand += amt
        const key = `${l.staffWfId}_${l.roleType}`
        const existing = map.get(key)
        if (existing) {
          existing.total += amt
        } else {
          map.set(key, { staffName: l.staffName, department: l.roleType, total: amt })
        }
      } else if (amt > 0) {
        
        hasUnassigned = true
      }
    }
  }
  const summary = Array.from(map.values()).map(s => ({
    staffName: s.staffName,
    department: s.department,
    total: s.total.toFixed(2),
  }))
  return { summary, grandTotal: grand.toFixed(2), hasUnassigned }
}
