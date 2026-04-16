// utils/allocation-calc.ts — 提成计算

interface RateRow {
  department: string
  amountMin: number
  amountMax: number
  orderRates: Record<string, number>
}

interface AllocLine {
  staffWfId: string
  staffName: string
  department: string
  amount: string
}

interface DisplayItem {
  allocLines: AllocLine[]
}

/**
 * 查提成比例并计算金额（纯函数版本）
 */
export function lookupRate(
  dept: string,
  salesCat: string,
  receivable: number,
  beautyRates: Record<string, Record<string, number>>,
  rates: RateRow[],
  totalAmount: number
): { commissionRate: number; amount: string } {
  // P2-14 Q5：beautyRates 现在以 roleType 为键（cloudfn 内部叫 ratesByRole），
  // dept 参数语义也改为 roleType。白名单覆盖三个 SKILL_TAGS。
  const beautyDepts = ['美容师', '养生师', '推广师']
  if (beautyDepts.includes(dept)) {
    const commRate = (beautyRates[dept] && beautyRates[dept][salesCat]) || 0
    return { commissionRate: commRate, amount: (receivable * commRate).toFixed(2) }
  }
  for (const rate of rates) {
    if (rate.department === dept && totalAmount >= rate.amountMin && totalAmount <= rate.amountMax) {
      const commRate = rate.orderRates[salesCat] || 0
      return { commissionRate: commRate, amount: (receivable * commRate).toFixed(2) }
    }
  }
  return { commissionRate: 0, amount: '0.00' }
}

/**
 * 汇总提成分配
 */
export function computeSummary(displayItems: DisplayItem[]): {
  summary: Array<{ staffName: string; department: string; total: string }>
  grandTotal: string
} {
  const map = new Map<string, { staffName: string; department: string; total: number }>()
  let grand = 0
  for (const di of displayItems) {
    for (const l of di.allocLines) {
      const amt = parseFloat(l.amount) || 0
      grand += amt
      if (l.staffWfId) {
        const key = `${l.staffWfId}_${l.department}`
        const existing = map.get(key)
        if (existing) {
          existing.total += amt
        } else {
          map.set(key, { staffName: l.staffName, department: l.department, total: amt })
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
