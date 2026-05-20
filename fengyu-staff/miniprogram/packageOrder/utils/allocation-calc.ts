// packageOrder/utils/allocation-calc.ts — 提成计算

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

/**
 * 查提成比例并计算金额（纯函数版本）
 *
 * tier 算法：amountMin <= totalAmount <= amountMax 命中；
 *           多 tier 命中时取 amountMin 最大者（高 tier 优先），与 cloudfn allocation.suggest
 *           的 lookupTierRate / service.complete 的 ORDER BY amount_tier_min DESC LIMIT 1 一致。
 *
 * `beautyRates` 参数保留为向后兼容（cloudfn ratesByRole 仍下发首 tier 索引），
 * 但当 rates 数组有该 role 的规则时，**优先**用 rates + tier 查找，不再读 beautyRates。
 */
export function lookupRate(
  dept: string,
  salesCat: string,
  receivable: number,
  beautyRates: Record<string, Record<string, number>>,
  rates: RateRow[],
  totalAmount: number
): { commissionRate: number; amount: string } {
  // 1) 优先按 (role, tier) 命中 rates（统一路径，覆盖所有 role）
  // rates 是 pivot 后的 grouped 结构，orderRates 全 sales_category 占位 0（未配的为 0）。
  // 需跳过 orderRates[salesCat]==0 的 grouped 项，避免同 amountMin 多 grouped 项中误选未配该 sales_category 的。
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

  // 2) 兜底：rates 没有该 role 但 beautyRates 有（兼容 cloudfn 老版本只下发 beautyRates 的场景）
  if (beautyRates[dept]) {
    const commRate = beautyRates[dept][salesCat] || 0
    return { commissionRate: commRate, amount: (receivable * commRate).toFixed(2) }
  }

  return { commissionRate: 0, amount: '0.00' }
}

/**
 * 汇总提成分配
 *
 * 页面语义为「提成分配」，汇总按员工聚合**提成额**（commissionAmount = 分配额 × 提成比例），
 * 合计为提成额合计。入库的 total_amount（=实收×分配比例）是「分配额」，与此处展示口径不同。
 */
export function computeSummary(displayItems: DisplayItem[]): {
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
