/**
 * 库存转换的成本守恒与血缘分摊（#344，9/18 会议 §2.15「上下必须对等」）。
 *
 * 纯函数、不碰数据库：服务端 `createInventoryConversion` 用它做硬拦截，办理台转换表单用它
 * 实时显示来源合计 / 目标合计 / 差额并预填目标单价 —— 两边同一份公式，前端放行的服务端不会拒。
 *
 * 金额一律按整数「分」计算，逐行 ROUND 到分后再合计，与 0043 `inventory_set_doc_item_amount`
 * （`ROUND(quantity * price, 2)`）和 0039 `inventory_refresh_doc_totals`（单头 = 明细合计）同口径，
 * 所以这里判定守恒 ⇔ 落库后出库单与入库单的 total_amount 之差也在允许误差内。
 */

export interface ConversionSourceCost {
  quantity: number
  /** 来源批次成本单价；赠送批次按 0 传入。 */
  unitCost: number
}

export interface ConversionTargetPrice {
  quantity: number
  unitPrice: number
}

export interface ConversionBalance {
  sourceAmount: number
  targetAmount: number
  /** 目标合计 − 来源合计 */
  difference: number
  /** 允许的舍入误差（元）。 */
  tolerance: number
  balanced: boolean
}

export interface ConversionLinkShare {
  sourceIndex: number
  targetIndex: number
  quantity: number
}

/** 两位小数的数量 / 单价换成整数分；先 toFixed(4) 吸收浮点残差（0.1 + 0.2 之类）。 */
function toCents(value: number): number {
  return Math.round(Number(value.toFixed(4)) * 100)
}

/** 一行金额（分）= ROUND(数量 × 单价, 2)。数量、单价均非负，Math.round 的 .5 进位即远离 0。 */
function lineAmountCents(quantity: number, unitPrice: number): number {
  return Math.round((toCents(quantity) * toCents(unitPrice)) / 100)
}

/**
 * 允许误差（分）= max(1, ⌊0.5 × (Σ目标数量 + 目标行数)⌋)。
 *
 * 推导：来源合计 S 是已取整的分。按预填规则所有目标单价取 p = ROUND(S ÷ Q, 2)（Q = Σ目标数量），
 * 单价只能精确到分，偏差 |Q·p − S| ≤ 0.5·Q 分；每个目标行金额再 ROUND 一次，各 ≤ 0.5 分。
 * 所以「按合计 ÷ 总数量预填」必然落在这个范围内，而超出它的差额只能是人为改价造成的 —— 硬拦截。
 */
function toleranceCents(targets: ConversionTargetPrice[]): number {
  const totalQuantity = targets.reduce((sum, target) => sum + toCents(target.quantity), 0) / 100
  return Math.max(1, Math.floor(0.5 * (totalQuantity + targets.length)))
}

export function summarizeConversion(
  sources: ConversionSourceCost[],
  targets: ConversionTargetPrice[],
): ConversionBalance {
  const sourceCents = sources.reduce((sum, source) => sum + lineAmountCents(source.quantity, source.unitCost), 0)
  const targetCents = targets.reduce((sum, target) => sum + lineAmountCents(target.quantity, target.unitPrice), 0)
  const tolerance = toleranceCents(targets)
  return {
    sourceAmount: sourceCents / 100,
    targetAmount: targetCents / 100,
    difference: (targetCents - sourceCents) / 100,
    tolerance: tolerance / 100,
    balanced: Math.abs(targetCents - sourceCents) <= tolerance,
  }
}

/** 目标单价预填 = ROUND(来源合计 ÷ Σ目标数量, 2)；目标数量为 0 时无从预填。 */
export function suggestConversionUnitPrice(sourceAmount: number, targetQuantityTotal: number): number | null {
  const quantityCents = toCents(targetQuantityTotal)
  if (quantityCents <= 0) return null
  return Math.round((toCents(sourceAmount) * 100) / quantityCents) / 100
}

/**
 * 来源行 × 目标行的多对多血缘（relation_type = 库存转换）。
 *
 * 每条关联的 quantity = 该来源行数量按目标数量占比分摊到该目标的部分，按分做最大余数法
 * （余数相同时靠前的目标先得），保证同一来源行的关联合计**恰好**等于来源数量 ——
 * 0043 `inventory_validate_doc_link` 要求同一来源明细的关联合计不超过来源明细数量，
 * 不需要为此改触发器或加迁移（用户 2026-09-25 确认）。分摊为 0 的配对不建关联
 * （doc_links 的 CHECK 要求 quantity > 0）。
 */
export function allocateConversionLinks(
  sourceQuantities: number[],
  targetQuantities: number[],
): ConversionLinkShare[] {
  const targetCents = targetQuantities.map(toCents)
  const targetTotal = targetCents.reduce((sum, value) => sum + value, 0)
  if (targetTotal <= 0) return []
  const shares: ConversionLinkShare[] = []
  for (const [sourceIndex, sourceQuantity] of sourceQuantities.entries()) {
    const sourceCents = toCents(sourceQuantity)
    const raw = targetCents.map((target) => (sourceCents * target) / targetTotal)
    const allotted = raw.map(Math.floor)
    let remainder = sourceCents - allotted.reduce((sum, value) => sum + value, 0)
    const order = raw
      .map((value, targetIndex) => ({ targetIndex, fraction: value - Math.floor(value) }))
      .sort((left, right) => right.fraction - left.fraction || left.targetIndex - right.targetIndex)
    for (const { targetIndex } of order) {
      if (remainder <= 0) break
      allotted[targetIndex] += 1
      remainder -= 1
    }
    for (const [targetIndex, cents] of allotted.entries()) {
      if (cents > 0) shares.push({ sourceIndex, targetIndex, quantity: cents / 100 })
    }
  }
  return shares
}
