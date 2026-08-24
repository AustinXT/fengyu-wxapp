export interface PaymentAllocationItem {
  saleItemId: string
  skuId: string | null
  productName: string | null
  productType: string | null
  allocatableAmount: number
  received: number
  salesCategory: string | null
  itemDirection: string | null
  suggestedRate: number
}

export interface PaymentAllocationSignatureLine {
  saleItemId: string
  employeeId: string
  roleType: string | null
  allocationRatio: string
}

export interface PaymentAllocationGroup {
  groupId: string
  saleItemIds: string[]
  sourceItems: PaymentAllocationItem[]
  skuId: string | null
  productName: string
  productType: string | null
  salesCategory: string
  itemDirection: string
  sourceCount: number
  allocatableAmount: number
  received: number
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function allocationSignature(lines: PaymentAllocationSignatureLine[]): string {
  return JSON.stringify(
    lines
      .map((line) => [
        line.roleType || '',
        line.employeeId || '',
        Number(line.allocationRatio || 0).toFixed(3),
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  )
}

/**
 * A response contains exactly one payment. Group its editable rows by SKU,
 * sales category, direction, and current allocation signature. The signature
 * keeps mismatched historical allocations separate until a user resolves them.
 */
export function groupPaymentItems(
  items: PaymentAllocationItem[],
  allocations: PaymentAllocationSignatureLine[],
): PaymentAllocationGroup[] {
  const allocationsBySaleItem = new Map<string, PaymentAllocationSignatureLine[]>()
  for (const allocation of allocations) {
    const lines = allocationsBySaleItem.get(allocation.saleItemId) || []
    lines.push(allocation)
    allocationsBySaleItem.set(allocation.saleItemId, lines)
  }

  const buckets = new Map<string, PaymentAllocationItem[]>()
  for (const item of items) {
    const skuId = item.skuId?.trim() || ''
    const salesCategory = item.salesCategory || '自销自耗'
    const itemDirection = item.itemDirection || '购买'
    const signature = allocationSignature(allocationsBySaleItem.get(item.saleItemId) || [])
    // Do not merge legacy rows with no SKU; their product identity is unknown.
    const bucketKey = skuId
      ? JSON.stringify([skuId, salesCategory, itemDirection, signature])
      : `single:${item.saleItemId}`
    const bucket = buckets.get(bucketKey)
    if (bucket) bucket.push(item)
    else buckets.set(bucketKey, [item])
  }

  return Array.from(buckets.values()).map((sourceItems) => {
    const first = sourceItems[0]
    const received = roundMoney(sourceItems.reduce((sum, item) => sum + (Number(item.received) || 0), 0))
    return {
      groupId: `payment-allocation:${first.saleItemId}`,
      saleItemIds: sourceItems.map((item) => item.saleItemId),
      sourceItems,
      skuId: first.skuId?.trim() || null,
      productName: first.productName || '未命名商品',
      productType: first.productType || null,
      salesCategory: first.salesCategory || '自销自耗',
      itemDirection: first.itemDirection || '购买',
      sourceCount: sourceItems.length,
      allocatableAmount: received,
      received,
    }
  })
}

/**
 * Keep display totals byte-for-byte aligned with receipt-level server writes:
 * round each source item's allocation and commission before aggregating them.
 */
export function calculateGroupedAmounts(
  sourceItems: PaymentAllocationItem[],
  allocationRatio: number,
  commissionRate: number,
): { allocatedAmount: string; commissionAmount: string } {
  const ratio = Number.isFinite(allocationRatio) ? allocationRatio : 0
  const rate = Number.isFinite(commissionRate) ? commissionRate : 0
  let allocated = 0
  let commission = 0

  for (const item of sourceItems) {
    const itemAllocated = roundMoney((Number(item.received) || 0) * ratio)
    allocated += itemAllocated
    commission += roundMoney(itemAllocated * rate)
  }

  return {
    allocatedAmount: roundMoney(allocated).toFixed(2),
    commissionAmount: roundMoney(commission).toFixed(2),
  }
}

export function expandGroupedAllocationLines<T extends { saleItemIds: string[] }>(
  lines: T[],
): Array<Omit<T, 'saleItemIds'> & { saleItemId: string }> {
  return lines.flatMap((line) => {
    const { saleItemIds, ...rest } = line
    return saleItemIds.map((saleItemId) => ({ ...rest, saleItemId }))
  }) as Array<Omit<T, 'saleItemIds'> & { saleItemId: string }>
}
