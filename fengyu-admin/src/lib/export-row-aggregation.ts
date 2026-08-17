type ExportRow = Record<string, unknown>

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function cents(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed == null ? null : Math.round(parsed * 100)
}

function money(value: number): string {
  return (value / 100).toFixed(2)
}

function stableValue(value: unknown): unknown {
  return value == null ? null : value
}

function normalizedDecimal(value: unknown, digits = 6): string | null {
  const parsed = finiteNumber(value)
  return parsed == null ? null : parsed.toFixed(digits)
}

function positiveQuantity(row: ExportRow): number {
  const quantity = finiteNumber(row.__quantity)
  return quantity != null && quantity > 0 ? quantity : 1
}

function displayQuantity(row: ExportRow): number | null {
  const sessions = finiteNumber(row.sessionCount)
  if (sessions != null) return sessions
  return finiteNumber(row.__quantity)
}

function sumNullableNumbers(rows: ExportRow[], key: string): number | null {
  let total = 0
  for (const row of rows) {
    const value = finiteNumber(row[key])
    if (value == null) return null
    total += value
  }
  return total
}

function sumMoney(rows: ExportRow[], key: string): string | number | null {
  let total = 0
  let found = false
  for (const row of rows) {
    const value = cents(row[key])
    if (value == null) continue
    total += value
    found = true
  }
  return found ? money(total) : null
}

/**
 * 按累计权重边界分摊整数分。每个边界只做一次四舍五入，因此同时满足：
 * - sum(parts) === totalCents；
 * - 每个分片都不与 totalCents 异号；
 * - 小额拆到多行时不会由最后一行吸收出负尾差。
 */
export function splitCentsWithLastRemainder(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  const integralTotal = Math.round(totalCents)
  if (weights.length === 1) return [integralTotal]
  const normalized = weights.map((weight) => Math.max(0, Number.isFinite(weight) ? weight : 0))
  const weightTotal = normalized.reduce((sum, weight) => sum + weight, 0)
  const effective = weightTotal > 0 ? normalized : normalized.map(() => 1)
  const effectiveTotal = effective.reduce((sum, weight) => sum + weight, 0)
  const sign = integralTotal < 0 ? -1 : 1
  const absoluteTotal = Math.abs(integralTotal)
  const parts: number[] = []
  let allocated = 0
  let cumulativeWeight = 0
  for (const weight of effective) {
    cumulativeWeight += weight
    const cumulativeAllocation = Math.round((absoluteTotal * cumulativeWeight) / effectiveTotal)
    const absolutePart = cumulativeAllocation - allocated
    parts.push(absolutePart === 0 ? 0 : sign * absolutePart)
    allocated = cumulativeAllocation
  }
  return parts
}

/**
 * 按 receipt 的有符号金额占事件净额的比例分摊通道金额。
 * 先向零取整，再把剩余的分补给同方向的最大余数，避免把转出行分成正通道金额。
 */
function splitSignedCentsByEventNet(
  totalCents: number,
  signedWeights: number[],
  eventNetCents: number,
): number[] {
  if (signedWeights.length === 0) return []
  if (totalCents === 0) return signedWeights.map(() => 0)
  if (eventNetCents === 0) return splitCentsWithLastRemainder(totalCents, signedWeights.map(Math.abs))

  const exact = signedWeights.map((weight) => (weight * totalCents) / eventNetCents)
  const parts = exact.map((value) => Math.trunc(value))
  let remainder = totalCents - parts.reduce((sum, value) => sum + value, 0)

  if (remainder > 0) {
    const candidates = exact
      .map((value, index) => ({ index, fraction: value - parts[index] }))
      .filter(({ fraction }) => fraction > 0)
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    for (let index = 0; index < remainder; index += 1) {
      const candidate = candidates[index % candidates.length]
      if (!candidate) break
      parts[candidate.index] += 1
    }
  } else if (remainder < 0) {
    const candidates = exact
      .map((value, index) => ({ index, fraction: value - parts[index] }))
      .filter(({ fraction }) => fraction < 0)
      .sort((a, b) => a.fraction - b.fraction || a.index - b.index)
    for (let index = 0; index < -remainder; index += 1) {
      const candidate = candidates[index % candidates.length]
      if (!candidate) break
      parts[candidate.index] -= 1
    }
  }

  remainder = totalCents - parts.reduce((sum, value) => sum + value, 0)
  if (remainder !== 0) {
    // 非标准脏数据（例如通道净额与 receipt 净额方向相反）仍需守恒；选择绝对金额最大的行吸收。
    const fallbackIndex = signedWeights.reduce(
      (best, weight, index) => Math.abs(weight) > Math.abs(signedWeights[best] ?? 0) ? index : best,
      0,
    )
    parts[fallbackIndex] += remainder
  }
  return parts
}

function perUnitKey(value: unknown, quantity: number, monetary = false): string | null {
  const parsed = monetary ? cents(value) : finiteNumber(value)
  if (parsed == null) return null
  return (parsed / quantity).toFixed(8)
}

function orderBusinessKey(row: ExportRow): string {
  const sourceId = String(row.__sourceId ?? '')
  const skuId = String(row.__skuId ?? '').trim()
  if (!skuId) return `legacy:${sourceId}`
  const quantity = positiveQuantity(row)
  return JSON.stringify([
    skuId,
    stableValue(row.__itemDirection),
    stableValue(row.productType),
    stableValue(row.categoryL1),
    stableValue(row.categoryL2),
    stableValue(row.productName),
    stableValue(row.unit),
    stableValue(row.salesCategory),
    stableValue(row.unitRealPrice),
    perUnitKey(row.sessionCount, quantity),
    perUnitKey(row.__remainingSessions, quantity),
    perUnitKey(row.__paidSessions, quantity),
    perUnitKey(row.paidUnusedSessions, quantity),
    perUnitKey(row.totalAmount, quantity, true),
    perUnitKey(row.prepaidCardAmount, quantity, true),
    perUnitKey(row.cashAmount, quantity, true),
    perUnitKey(row.received, quantity, true),
    perUnitKey(row.refundedAmount, quantity, true),
  ])
}

function allocationWeights(rows: ExportRow[]): number[] {
  // 退款 receipt 完全缺失时，received 已是退款后的净额；用它作权重会让
  // 全退行权重归零，并把退款错分给未退款行。sale_items.sale_amount（导出字段
  // totalAmount）是退款前的行应付事实，兜底分摊应优先使用它。
  const saleAmounts = rows.map((row) => Math.abs(cents(row.totalAmount) ?? 0))
  if (saleAmounts.some((value) => value > 0)) return saleAmounts
  const received = rows.map((row) => Math.abs(cents(row.received) ?? 0))
  if (received.some((value) => value > 0)) return received
  return rows.map((row) => positiveQuantity(row))
}

/** 同一订单的源明细必须完整传入；返回最终写入订单 Excel 的聚合行。 */
export function aggregateOrderExportRows<T extends ExportRow>(sourceRows: T[]): T[] {
  if (sourceRows.length === 0) return []
  const rows: ExportRow[] = sourceRows.map((row) => ({ ...row }))
  if (rows.every((row) => row.__sourceKind === 'recharge')) return rows as T[]

  const weights = allocationWeights(rows)
  const refundTotal = cents(rows[0].refundedAmount)
  if (refundTotal != null) {
    // 商品退款 receipt 记录的是退款前毛额，订单 refunded_amount 是扣除手续费、
    // 透支扣除后的实际净退款，两者不应要求数值相等。只要存在逐项退款事实，
    // 就以其毛额作为权重缩放净退款；仅在历史数据完全没有 receipt 时按行应付兜底。
    const refundReceiptWeights = rows.map((row) => Math.abs(cents(row.__itemRefundedAmount) ?? 0))
    const hasRefundReceipt = refundReceiptWeights.some((value) => value > 0)
    const parts = splitCentsWithLastRemainder(
      refundTotal,
      hasRefundReceipt ? refundReceiptWeights : weights,
    )
    rows.forEach((row, index) => {
      row.refundedAmount = money(parts[index])
    })
  }

  const buckets = new Map<string, ExportRow[]>()
  for (const row of rows) {
    const key = orderBusinessKey(row)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  return Array.from(buckets.values()).map((bucket) => {
    const result: ExportRow = { ...bucket[0] }
    const totalQuantity = bucket.reduce((sum, row) => sum + (displayQuantity(row) ?? 0), 0)
    result.sessionCount = bucket.every((row) => displayQuantity(row) == null) ? null : totalQuantity
    result.paidUnusedSessions = sumNullableNumbers(bucket, 'paidUnusedSessions')
    result.__quantity = bucket.reduce((sum, row) => sum + positiveQuantity(row), 0)
    result.__remainingSessions = sumNullableNumbers(bucket, '__remainingSessions')
    result.__paidSessions = sumNullableNumbers(bucket, '__paidSessions')
    for (const key of ['totalAmount', 'prepaidCardAmount', 'cashAmount', 'received', 'refundedAmount'] as const) {
      if (bucket[0][key] === '') continue
      result[key] = sumMoney(bucket, key)
    }
    return result as T
  })
}

interface ReceiptBucket<T extends ExportRow> {
  id: string
  base: T
  rows: T[]
  amountCents: number
  prepaidCents: number
  refundCents: number
  signature: string
}

function allocationLineSignature(row: ExportRow): string {
  return JSON.stringify([
    stableValue(row.__employeeId ?? row.employeeName),
    stableValue(row.__roleType ?? row.positionName),
    normalizedDecimal(row.allocationRatio),
    normalizedDecimal(row.commissionRate),
  ])
}

function itemAllocationSignature(rows: ExportRow[]): string {
  return JSON.stringify(rows.map(allocationLineSignature).sort())
}

function allocationItemKey<T extends ExportRow>(receipt: ReceiptBucket<T>): string {
  const skuId = String(receipt.base.__skuId ?? '').trim()
  if (!skuId) return `legacy:${receipt.id}`
  return JSON.stringify([
    skuId,
    stableValue(receipt.base.__itemDirection),
    stableValue(receipt.base.salesCategory),
    stableValue(receipt.base.productType),
    stableValue(receipt.base.categoryL1),
    stableValue(receipt.base.categoryL2),
    stableValue(receipt.base.productName),
    stableValue(receipt.base.unit),
    receipt.signature,
  ])
}

function aggregateAllocationOutput<T extends ExportRow>(
  receipts: ReceiptBucket<T>[],
  allocationRows: T[] | null,
): T {
  const result: ExportRow = { ...(allocationRows?.[0] ?? receipts[0].base) }
  const sourceRows = receipts.map((receipt) => receipt.base)
  const totalQuantity = sourceRows.reduce((sum, row) => sum + (displayQuantity(row) ?? 0), 0)
  result.sessionCount = sourceRows.every((row) => displayQuantity(row) == null) ? null : totalQuantity
  result.paidUnusedSessions = sumNullableNumbers(sourceRows, 'paidUnusedSessions')
  result.saleAmount = sumMoney(sourceRows, 'saleAmount')
  result.received = money(receipts.reduce((sum, receipt) => sum + receipt.amountCents, 0))
  result.prepaidCardAmount = money(receipts.reduce((sum, receipt) => sum + receipt.prepaidCents, 0))
  result.refundedAmount = money(receipts.reduce((sum, receipt) => sum + receipt.refundCents, 0))
  result.__quantity = sourceRows.reduce((sum, row) => sum + positiveQuantity(row), 0)
  result.__remainingSessions = sumNullableNumbers(sourceRows, '__remainingSessions')
  result.__paidSessions = sumNullableNumbers(sourceRows, '__paidSessions')

  const saleAmount = finiteNumber(result.saleAmount)
  if (saleAmount != null && totalQuantity > 0) {
    result.unitRealPrice = Math.round((saleAmount / totalQuantity) * 100) / 100
  }

  if (allocationRows) {
    result.allocationAmount = sumMoney(allocationRows, 'allocationAmount')
    result.commissionAmount = sumMoney(allocationRows, 'commissionAmount')
  } else {
    result.employeeName = null
    result.positionName = null
    result.allocationRatio = null
    result.allocationAmount = null
    result.commissionRate = null
    result.commissionAmount = null
  }
  return result as T
}

/** 同一回款/退款事件的源明细必须完整传入；返回最终写入销售提成 Excel 的聚合行。 */
export function aggregateAllocationExportRows<T extends ExportRow>(sourceRows: T[]): T[] {
  if (sourceRows.length === 0) return []
  const receiptMap = new Map<string, ReceiptBucket<T>>()
  sourceRows.forEach((source, index) => {
    const row = { ...source } as T
    const id = String(row.__receiptId ?? row.__sourceId ?? `row:${index}`)
    const existing = receiptMap.get(id)
    if (existing) {
      existing.rows.push(row)
      return
    }
    receiptMap.set(id, {
      id,
      base: row,
      rows: [row],
      amountCents: cents(row.__receiptAmount ?? row.received) ?? 0,
      prepaidCents: 0,
      refundCents: 0,
      signature: '',
    })
  })
  const receipts = Array.from(receiptMap.values())
  const eventTotal = receipts.reduce((sum, receipt) => sum + receipt.amountCents, 0)
  const first = receipts[0].base
  const changeType = String(first.__paymentChangeType ?? '')
  const paymentMethod = String(first.__paymentMethod ?? '')
  const paymentAmount = cents(first.__paymentAmount) ?? eventTotal
  let prepaidTotal = 0
  if (changeType === '储值卡抵扣' || paymentMethod === '储值卡') {
    prepaidTotal = eventTotal
  } else if (eventTotal > 0 && paymentAmount >= 0) {
    // 混合收款只把 receipt 挂在现金主流水上；超出主流水金额的部分即同事件储值卡抵扣。
    prepaidTotal = Math.max(0, Math.min(eventTotal, eventTotal - paymentAmount))
  }
  const prepaidParts = splitSignedCentsByEventNet(
    prepaidTotal,
    receipts.map((receipt) => receipt.amountCents),
    eventTotal,
  )
  receipts.forEach((receipt, index) => {
    receipt.prepaidCents = prepaidParts[index] ?? 0
    receipt.refundCents = changeType === '退款' ? Math.abs(receipt.amountCents) : 0
    receipt.signature = itemAllocationSignature(receipt.rows)
  })

  const itemGroups = new Map<string, ReceiptBucket<T>[]>()
  for (const receipt of receipts) {
    const key = allocationItemKey(receipt)
    const group = itemGroups.get(key)
    if (group) group.push(receipt)
    else itemGroups.set(key, [receipt])
  }

  const output: T[] = []
  for (const group of itemGroups.values()) {
    const hasAllocations = group.some((receipt) => receipt.rows.some((row) => row.__employeeId != null || row.employeeName != null))
    if (!hasAllocations) {
      output.push(aggregateAllocationOutput(group, null))
      continue
    }
    const dimensions = new Map<string, { receipts: ReceiptBucket<T>[]; rows: T[] }>()
    for (const receipt of group) {
      for (const row of receipt.rows) {
        const key = allocationLineSignature(row)
        const dimension = dimensions.get(key)
        if (dimension) {
          dimension.receipts.push(receipt)
          dimension.rows.push(row)
        } else {
          dimensions.set(key, { receipts: [receipt], rows: [row] })
        }
      }
    }
    for (const dimension of dimensions.values()) {
      output.push(aggregateAllocationOutput(dimension.receipts, dimension.rows))
    }
  }
  return output
}

/** 对已按 key 排序的异步流做跨分页聚合；内存中只保留一个订单或一笔回款。 */
export async function* aggregateContiguousExportRows<T extends ExportRow>(
  source: AsyncIterable<T>,
  keyOf: (row: T) => string,
  aggregate: (rows: T[]) => T[],
): AsyncGenerator<T> {
  let currentKey: string | null = null
  let buffer: T[] = []
  for await (const row of source) {
    const key = keyOf(row)
    if (currentKey != null && key !== currentKey) {
      for (const aggregated of aggregate(buffer)) yield aggregated
      buffer = []
    }
    currentKey = key
    buffer.push(row)
  }
  if (buffer.length > 0) {
    for (const aggregated of aggregate(buffer)) yield aggregated
  }
}
