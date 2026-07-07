

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export interface BundleGroupTotalsInput {
  
  pickCount: number | null
  
  listPrice: string | null
  
  memberPrice: string | null
  
  skuCount: number
}


export function computeBundleTotals(
  groups: BundleGroupTotalsInput[],
): { price: string; specialPrice: string | null } {
  let listSum = 0
  let memberSum = 0
  for (const g of groups) {
    const count = g.pickCount != null ? Math.min(g.pickCount, g.skuCount) : g.skuCount
    const listUnit = g.listPrice != null ? Number(g.listPrice) : 0
    const memberUnit = g.memberPrice != null ? Number(g.memberPrice) : listUnit
    listSum += round2(listUnit * count)
    memberSum += round2(memberUnit * count)
  }
  listSum = round2(listSum)
  memberSum = round2(memberSum)
  return {
    price: listSum.toFixed(2),
    specialPrice: memberSum < listSum - 0.005 ? memberSum.toFixed(2) : null,
  }
}
