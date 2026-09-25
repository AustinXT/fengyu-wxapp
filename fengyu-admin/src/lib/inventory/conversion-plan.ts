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
  /** 任一侧合计超过 numeric(12,2)（单头 total_amount / 明细 amount 的列上限）。 */
  exceedsAmountLimit: boolean
}

export interface ConversionLinkShare {
  sourceIndex: number
  targetIndex: number
  quantity: number
}

/** numeric(12,2) 上限，单位分。 */
const AMOUNT_LIMIT_CENTS = BigInt('999999999999')
// tsconfig target 为 ES2017，不能写 BigInt 字面量（`50n`）
const ZERO = BigInt(0)
const ONE = BigInt(1)
const TWO = BigInt(2)
const FIFTY = BigInt(50)
const HUNDRED = BigInt(100)
const TWO_HUNDRED = BigInt(200)

/**
 * 两位小数的数量 / 单价换成整数分（BigInt）；先 toFixed(4) 吸收浮点残差（0.1 + 0.2 之类）。
 * 用 BigInt 是因为数量分 × 单价分最大可到 1e24，远超 2^53，Number 乘法会静默失真。
 */
function toCents(value: number): bigint {
  return BigInt(Math.round(Number(value.toFixed(4)) * 100))
}

/** 一行金额（分）= ROUND(数量 × 单价, 2)。数量、单价均非负，+50 再整除即 .5 远离 0，与 PG ROUND 一致。 */
function lineAmountCents(quantity: number, unitPrice: number): bigint {
  return (toCents(quantity) * toCents(unitPrice) + FIFTY) / HUNDRED
}

const centsToYuan = (cents: bigint) => Number(cents) / 100
const absCents = (cents: bigint) => (cents < ZERO ? -cents : cents)

/** 一行金额（元），与触发器逐行 ROUND 同口径；表单的「带出成本」「金额」列用它。 */
export function conversionLineAmount(quantity: number, unitPrice: number): number {
  return centsToYuan(lineAmountCents(quantity, unitPrice))
}

/** 预填单价（分）= ROUND(来源合计 ÷ Σ目标数量, 2)；目标数量为 0 时无从预填。 */
function suggestedPriceCents(sourceCents: bigint, targets: ConversionTargetPrice[]): bigint | null {
  const quantityCents = targets.reduce((sum, target) => sum + toCents(target.quantity), ZERO)
  if (quantityCents <= ZERO) return null
  // sourceCents(分) ÷ (quantityCents / 100) = sourceCents × 100 ÷ quantityCents，四舍五入
  return (sourceCents * TWO_HUNDRED + quantityCents) / (TWO * quantityCents)
}

/**
 * 允许误差（分）= max(1, 所有目标都按预填单价时的差额)。
 *
 * 单价只能精确到分，行金额还要再 ROUND 一次，所以一般做不到分毫不差；「按合计 ÷ 总数量预填」
 * 产生的差额就是这张单不可避免的舍入误差。手改单价可以更接近守恒，但不能比预填更偏离 ——
 * 否则就是人为改价（例如来源 1 件 0.01 元拆 3 件：预填 0.00 差 1 分；按 0.01 元填差 2 分，拒绝，
 * 避免借舍入把账面成本放大）。
 */
function toleranceCents(sourceCents: bigint, targets: ConversionTargetPrice[]): bigint {
  const price = suggestedPriceCents(sourceCents, targets)
  if (price === null) return ONE
  const prefilled = targets.reduce((sum, target) => sum + (toCents(target.quantity) * price + FIFTY) / HUNDRED, ZERO)
  const unavoidable = absCents(prefilled - sourceCents)
  return unavoidable > ONE ? unavoidable : ONE
}

export function summarizeConversion(
  sources: ConversionSourceCost[],
  targets: ConversionTargetPrice[],
): ConversionBalance {
  const sourceCents = sources.reduce((sum, source) => sum + lineAmountCents(source.quantity, source.unitCost), ZERO)
  const targetCents = targets.reduce((sum, target) => sum + lineAmountCents(target.quantity, target.unitPrice), ZERO)
  const tolerance = toleranceCents(sourceCents, targets)
  return {
    sourceAmount: centsToYuan(sourceCents),
    targetAmount: centsToYuan(targetCents),
    difference: centsToYuan(targetCents - sourceCents),
    tolerance: centsToYuan(tolerance),
    balanced: absCents(targetCents - sourceCents) <= tolerance,
    exceedsAmountLimit: sourceCents > AMOUNT_LIMIT_CENTS || targetCents > AMOUNT_LIMIT_CENTS,
  }
}

/** 目标单价预填 = ROUND(来源合计 ÷ Σ目标数量, 2)；目标数量为 0 时无从预填。 */
export function suggestConversionUnitPrice(sourceAmount: number, targetQuantityTotal: number): number | null {
  const price = suggestedPriceCents(toCents(sourceAmount), [{ quantity: targetQuantityTotal, unitPrice: 0 }])
  return price === null ? null : centsToYuan(price)
}

/**
 * 来源行 × 目标行的多对多血缘（relation_type = 库存转换）。
 *
 * 每条关联的 quantity = 该来源行数量按目标数量占比分摊到该目标的部分，按分做最大余数法
 * （余数相同时靠前的目标先得），保证同一来源行的关联合计**恰好**等于来源数量 ——
 * 0043 `inventory_validate_doc_link` 要求同一来源明细的关联合计不超过来源明细数量，
 * 不需要为此改触发器或加迁移（用户 2026-09-25 确认）。分摊为 0 的配对不建关联
 * （doc_links 的 CHECK 要求 quantity > 0）；调用方须用 {@link uncoveredConversionTargets}
 * 拒绝「某个目标一条来源关联都分不到」的单据，否则该目标明细没有血缘。
 */
export function allocateConversionLinks(
  sourceQuantities: number[],
  targetQuantities: number[],
): ConversionLinkShare[] {
  const targetCents = targetQuantities.map(toCents)
  const targetTotal = targetCents.reduce((sum, value) => sum + value, ZERO)
  if (targetTotal <= ZERO) return []
  const shares: ConversionLinkShare[] = []
  for (const [sourceIndex, sourceQuantity] of sourceQuantities.entries()) {
    const sourceCents = toCents(sourceQuantity)
    const products = targetCents.map((target) => sourceCents * target)
    const allotted = products.map((product) => product / targetTotal)
    let remainder = sourceCents - allotted.reduce((sum, value) => sum + value, ZERO)
    const order = products
      .map((product, targetIndex) => ({ targetIndex, fraction: product % targetTotal }))
      .sort((left, right) => (left.fraction === right.fraction
        ? left.targetIndex - right.targetIndex
        : left.fraction > right.fraction ? -1 : 1))
    for (const { targetIndex } of order) {
      if (remainder <= ZERO) break
      allotted[targetIndex] += ONE
      remainder -= ONE
    }
    for (const [targetIndex, cents] of allotted.entries()) {
      if (cents > ZERO) shares.push({ sourceIndex, targetIndex, quantity: centsToYuan(cents) })
    }
  }
  return shares
}

/** 一条来源关联都分不到的目标行下标（来源数量太少、分到每个目标不足 0.01）。 */
export function uncoveredConversionTargets(shares: ConversionLinkShare[], targetCount: number): number[] {
  const covered = new Set(shares.map((share) => share.targetIndex))
  return Array.from({ length: targetCount }, (_, index) => index).filter((index) => !covered.has(index))
}
