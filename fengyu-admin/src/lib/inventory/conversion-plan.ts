/**
 * 库存转换的成本守恒与血缘分摊（#344，9/18 会议 §2.15「上下必须对等」）。
 *
 * 纯函数、不碰数据库：服务端 `createInventoryConversion` 用它做硬拦截，办理台转换表单用它
 * 实时显示来源合计 / 目标合计 / 差额并预填目标单价 —— 两边同一份公式，前端放行的服务端不会拒。
 *
 * 守恒按**未舍入的精确值**比较：Σ数量×单价，数量、单价都是两位小数，乘积精确到万分之一元，
 * 用 BigInt 整数运算。不能按逐行 ROUND 后的金额比 —— 那样把同一批次拆成 100 行 0.01，
 * 每行 0.005 都进位成 0.01，就能凭空把成本放大一倍（第 3 轮评审 P0）；精确和对拆行不敏感。
 * 单据上的明细金额仍由 0043 触发器逐行 ROUND，那是展示与对账口径，不参与守恒判定。
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
  /** 来源成本精确合计（元，最多 4 位小数） */
  sourceAmount: number
  /** 目标金额精确合计（元，最多 4 位小数） */
  targetAmount: number
  /** 目标合计 − 来源合计 */
  difference: number
  /** 允许的舍入误差（元）。 */
  tolerance: number
  balanced: boolean
  /** 按 Σ目标数量统一预填的单价；目标数量为 0 时为 null。 */
  suggestedUnitPrice: number | null
  /** 任一侧逐行 ROUND 后的合计超过 numeric(12,2)（单头 total_amount / 明细 amount 的列上限）。 */
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

/**
 * 一行金额（分）= ROUND(数量 × 单价, 2)，.5 远离 0 —— 与 PG numeric ROUND 一致。
 * 按符号处理：BigInt 除法向 0 截断，负数若也「+50 再整除」会把 -0.005 算成 0.00（PG 是 -0.01）。
 * 调用方本就拒绝负价，这里仍保持对称，免得公式与触发器在异常数据上悄悄分叉。
 */
function lineAmountCents(quantity: number, unitPrice: number): bigint {
  const product = toCents(quantity) * toCents(unitPrice)
  return product < ZERO ? -((-product + FIFTY) / HUNDRED) : (product + FIFTY) / HUNDRED
}

const centsToYuan = (cents: bigint) => Number(cents) / 100
const absCents = (cents: bigint) => (cents < ZERO ? -cents : cents)

/** 一行金额（元），与触发器逐行 ROUND 同口径；表单的「带出成本」「金额」列用它。 */
export function conversionLineAmount(quantity: number, unitPrice: number): number {
  return centsToYuan(lineAmountCents(quantity, unitPrice))
}

/** 精确值单位：万分之一元（数量分 × 单价分）。 */
const MICRO_PER_CENT = HUNDRED
const exactAmount = (quantity: number, unitPrice: number) => toCents(quantity) * toCents(unitPrice)
const microToYuan = (micro: bigint) => Number(micro) / 10000

/** ROUND(value ÷ divisor)，.5 远离 0（divisor > 0）。 */
function roundDiv(value: bigint, divisor: bigint): bigint {
  return value < ZERO ? -((-value * TWO + divisor) / (TWO * divisor)) : (value * TWO + divisor) / (TWO * divisor)
}

/**
 * 允许误差固定 0.01 元（用户 2026-09-25 拍板「严格 1 分」）。
 *
 * 单价只能精确到分，统一单价往往做不到分毫不差（例：300 元拆 2 万件，精确单价 0.015），
 * 这时不放宽容差，而是用 {@link splitTargetForExactConservation} 把某个目标拆成单价差 1 分的两行补足。
 * 预填单价 p = ROUND(来源精确合计 ÷ Σ目标数量, 2) 只是起点，不保证守恒。
 */
export function summarizeConversion(
  sources: ConversionSourceCost[],
  targets: ConversionTargetPrice[],
): ConversionBalance {
  const sourceExact = sources.reduce((sum, source) => sum + exactAmount(source.quantity, source.unitCost), ZERO)
  const targetExact = targets.reduce((sum, target) => sum + exactAmount(target.quantity, target.unitPrice), ZERO)
  const quantityCents = targets.reduce((sum, target) => sum + toCents(target.quantity), ZERO)
  const suggestedCents = quantityCents > ZERO ? roundDiv(sourceExact, quantityCents) : null
  const roundedSource = sources.reduce((sum, source) => sum + lineAmountCents(source.quantity, source.unitCost), ZERO)
  const roundedTarget = targets.reduce((sum, target) => sum + lineAmountCents(target.quantity, target.unitPrice), ZERO)
  return {
    sourceAmount: microToYuan(sourceExact),
    targetAmount: microToYuan(targetExact),
    difference: microToYuan(targetExact - sourceExact),
    tolerance: microToYuan(MICRO_PER_CENT),
    balanced: absCents(targetExact - sourceExact) <= MICRO_PER_CENT,
    suggestedUnitPrice: suggestedCents === null ? null : centsToYuan(suggestedCents),
    exceedsAmountLimit: roundedSource > AMOUNT_LIMIT_CENTS || roundedTarget > AMOUNT_LIMIT_CENTS,
  }
}

export interface ConversionTargetSplit {
  /** 保留在原行的数量与单价 */
  low: ConversionTargetPrice
  /** 需要新增的一行（单价高 1 分）；恰好能用单一单价守恒时为 null */
  high: ConversionTargetPrice | null
}

/**
 * 「拆分补差」：保持其它目标行不动，把第 `index` 个目标拆成单价 p / p+0.01 的两行，使目标合计与来源合计之差 ≤ 0.01。
 *
 * 余额 R = 来源精确合计 − 其它目标精确合计，p = ⌊R ÷ 该行数量⌋（分），剩下的差额由若干数量按 p+0.01 补上。
 * 数量是整数时按整件拆（不会拆出 0.33 套），残差 < 0.005 元；否则按 0.01 拆，精确到万分之一元。
 * R < 0（其它目标已超过来源合计）或该行数量为 0 时无法拆分，返回 null。
 */
export function splitTargetForExactConservation(
  sources: ConversionSourceCost[],
  targets: ConversionTargetPrice[],
  index: number,
): ConversionTargetSplit | null {
  const target = targets[index]
  if (!target) return null
  const quantityCents = toCents(target.quantity)
  if (quantityCents <= ZERO) return null
  const sourceExact = sources.reduce((sum, source) => sum + exactAmount(source.quantity, source.unitCost), ZERO)
  const othersExact = targets.reduce((sum, other, otherIndex) => (
    otherIndex === index ? sum : sum + exactAmount(other.quantity, other.unitPrice)
  ), ZERO)
  const remaining = sourceExact - othersExact
  if (remaining < ZERO) return null
  const lowCents = remaining / quantityCents
  const shortfall = remaining - quantityCents * lowCents // 单位：万分之一元；每 0.01 数量加价 1 分补 1
  // 整数件按整件拆：每件加价 1 分补 100
  const step = quantityCents % HUNDRED === ZERO ? HUNDRED : ONE
  let highCents = roundDiv(shortfall, step) * step
  if (highCents >= quantityCents) highCents = quantityCents
  if (highCents === ZERO) return { low: { quantity: target.quantity, unitPrice: centsToYuan(lowCents) }, high: null }
  if (highCents === quantityCents) return { low: { quantity: target.quantity, unitPrice: centsToYuan(lowCents + ONE) }, high: null }
  return {
    low: { quantity: centsToYuan(quantityCents - highCents), unitPrice: centsToYuan(lowCents) },
    high: { quantity: centsToYuan(highCents), unitPrice: centsToYuan(lowCents + ONE) },
  }
}

/** 目标单价预填 = ROUND(来源合计 ÷ Σ目标数量, 2)；来源合计按精确值（最多 4 位小数）参与，不先取整分。 */
export function suggestConversionUnitPrice(sourceAmount: number, targetQuantityTotal: number): number | null {
  const quantityCents = toCents(targetQuantityTotal)
  if (quantityCents <= ZERO) return null
  return centsToYuan(roundDiv(BigInt(Math.round(sourceAmount * 10000)), quantityCents))
}

/** 金额展示：整分给两位小数，不足一分（精确值）给到四位，免得「差额 0.01、允许 ±0.01」却被拒。 */
export function formatConversionAmount(value: number): string {
  return Number.isInteger(Math.round(value * 10000) / 100) ? value.toFixed(2) : value.toFixed(4)
}

/**
 * 来源行 × 目标行的多对多血缘（relation_type = 库存转换）。
 *
 * 每条关联的 quantity = 该来源行数量按目标数量占比分摊到该目标的部分，按分做最大余数法，
 * 保证同一来源行的关联合计**恰好**等于来源数量 —— 0043 `inventory_validate_doc_link` 要求
 * 同一来源明细的关联合计不超过来源明细数量，不需要为此改触发器或加迁移（用户 2026-09-25 确认）。
 * 分摊为 0 的配对不建关联（doc_links 的 CHECK 要求 quantity > 0）。
 *
 * 覆盖：各来源行不是各算各的 —— 余数优先分给「到目前为止还没分到任何来源」的目标，
 * 最后再做一遍补位：仍没分到的目标，从「合计 ≥ 0.02 的目标」那里挪 0.01（同一来源行内挪，
 * 来源合计不变）。所以只要 Σ来源数量 ≥ 0.01 × 目标行数，每个目标都至少有一条关联；
 * 调用方用 {@link uncoveredConversionTargets} 拒绝余下那种来源实在太少的单据。
 */
export function allocateConversionLinks(
  sourceQuantities: number[],
  targetQuantities: number[],
): ConversionLinkShare[] {
  const targetCents = targetQuantities.map(toCents)
  const targetTotal = targetCents.reduce((sum, value) => sum + value, ZERO)
  if (targetTotal <= ZERO) return []
  const matrix: bigint[][] = []
  const receivedByTarget = targetCents.map(() => ZERO)
  for (const sourceQuantity of sourceQuantities) {
    const sourceCents = toCents(sourceQuantity)
    const products = targetCents.map((target) => sourceCents * target)
    const allotted = products.map((product) => product / targetTotal)
    let remainder = sourceCents - allotted.reduce((sum, value) => sum + value, ZERO)
    const order = products
      .map((product, targetIndex) => ({
        targetIndex,
        fraction: product % targetTotal,
        uncovered: receivedByTarget[targetIndex] === ZERO && allotted[targetIndex] === ZERO,
      }))
      .sort((left, right) => {
        if (left.uncovered !== right.uncovered) return left.uncovered ? -1 : 1
        if (left.fraction !== right.fraction) return left.fraction > right.fraction ? -1 : 1
        return left.targetIndex - right.targetIndex
      })
    for (const { targetIndex } of order) {
      if (remainder <= ZERO) break
      allotted[targetIndex] += ONE
      remainder -= ONE
    }
    allotted.forEach((cents, targetIndex) => { receivedByTarget[targetIndex] += cents })
    matrix.push(allotted)
  }
  // 补位：没分到的目标从合计 ≥ 0.02 的目标那里挪 0.01（挪的是同一来源行内的份额，来源合计不变）
  for (const [target, received] of receivedByTarget.entries()) {
    if (received > ZERO) continue
    for (const row of matrix) {
      const donor = row.findIndex((cents, index) => cents > ZERO && receivedByTarget[index] > ONE)
      if (donor < 0) continue
      row[donor] -= ONE
      row[target] += ONE
      receivedByTarget[donor] -= ONE
      receivedByTarget[target] += ONE
      break
    }
  }
  const shares: ConversionLinkShare[] = []
  matrix.forEach((row, sourceIndex) => row.forEach((cents, targetIndex) => {
    if (cents > ZERO) shares.push({ sourceIndex, targetIndex, quantity: centsToYuan(cents) })
  }))
  return shares
}

/** 一条来源关联都分不到的目标行下标（Σ来源数量不足 0.01 × 目标行数）。 */
export function uncoveredConversionTargets(shares: ConversionLinkShare[], targetCount: number): number[] {
  const covered = new Set(shares.map((share) => share.targetIndex))
  return Array.from({ length: targetCount }, (_, index) => index).filter((index) => !covered.has(index))
}
