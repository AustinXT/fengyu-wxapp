/**
 * 组合套餐价格计算（纯函数，无 IO）。
 * 供 actions/products.ts 的 recomputeBundlePrice 复用，并独立单测覆盖边界。
 */

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export interface BundleGroupTotalsInput {
  /** N选M 的 M；null=全选（计入数量=skuCount） */
  pickCount: number | null
  /** 组标价单价（numeric 字符串）；null 视为 0 */
  listPrice: string | null
  /** 组会员价单价；null 视为按标价单价成交 */
  memberPrice: string | null
  /** 组内 SKU 数（全选组计入数量用） */
  skuCount: number
}

/**
 * 算套餐展示价：
 * - price        = Σ 各组 listPrice × 计入数量
 * - specialPrice = Σ 各组 coalesce(memberPrice, listPrice) × 计入数量；仅当 < price 时落值，否则 null
 * 计入数量 = pickCount（N选M）或 skuCount（全选组）。组内同价 → 套餐价与具体如何选无关。
 */
export function computeBundleTotals(
  groups: BundleGroupTotalsInput[],
): { price: string; specialPrice: string | null } {
  let listSum = 0
  let memberSum = 0
  for (const g of groups) {
    const count = g.pickCount != null ? g.pickCount : g.skuCount
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
