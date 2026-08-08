export interface AllocationGroupSource {
  sale_item_id: string
  sku_id?: string | null
  product_name?: string | null
  product_type?: string | null
  received?: string | number | null
  sales_category?: string | null
  item_direction?: string | null
}

export interface AllocationSignatureLine {
  employeeId?: string | null
  roleType?: string | null
  allocationRatio?: string | number | null
}

export interface PaymentAllocationGroup<T extends AllocationGroupSource> {
  groupId: string
  saleItemIds: string[]
  sourceItems: T[]
  skuId: string | null
  productName: string
  productType: string | null
  salesCategory: string
  itemDirection: string
  sourceCount: number
  received: number
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function asMoney(value: string | number | null | undefined): number {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : 0
}

function allocationSignature(lines: AllocationSignatureLine[]): string {
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
 * Groups only source rows that can share one editing state. Existing allocation
 * signatures are part of the bucket so a historical mismatch remains editable
 * as separate rows instead of being overwritten on the next save.
 */
export function groupPaymentItems<T extends AllocationGroupSource>(
  items: T[],
  allocationsBySaleItem: ReadonlyMap<string, AllocationSignatureLine[]> = new Map(),
): PaymentAllocationGroup<T>[] {
  const buckets = new Map<string, T[]>()

  for (const item of items) {
    const skuId = item.sku_id?.trim() || ''
    const salesCategory = item.sales_category || '自销自耗'
    const itemDirection = item.item_direction || '购买'
    const signature = allocationSignature(allocationsBySaleItem.get(item.sale_item_id) || [])
    // Rows without a SKU cannot be proven to represent the same product.
    const bucketKey = skuId
      ? JSON.stringify([skuId, salesCategory, itemDirection, signature])
      : `single:${item.sale_item_id}`
    const bucket = buckets.get(bucketKey)
    if (bucket) bucket.push(item)
    else buckets.set(bucketKey, [item])
  }

  return Array.from(buckets.values()).map((sourceItems) => {
    const first = sourceItems[0]
    const skuId = first.sku_id?.trim() || null
    return {
      groupId: `payment-allocation:${first.sale_item_id}`,
      saleItemIds: sourceItems.map((item) => item.sale_item_id),
      sourceItems,
      skuId,
      productName: first.product_name || '未命名商品',
      productType: first.product_type || null,
      salesCategory: first.sales_category || '自销自耗',
      itemDirection: first.item_direction || '购买',
      sourceCount: sourceItems.length,
      received: roundMoney(sourceItems.reduce((sum, item) => sum + asMoney(item.received), 0)),
    }
  })
}

/**
 * The API saves each receipt independently. Mirror that rounding here, then
 * sum the rounded source amounts for the grouped display.
 */
export function calculateGroupedAmounts<T extends AllocationGroupSource>(
  sourceItems: T[],
  allocationRatio: number,
  commissionRate: number,
): { allocatedAmount: string; commissionAmount: string } {
  const ratio = Number.isFinite(allocationRatio) ? allocationRatio : 0
  const rate = Number.isFinite(commissionRate) ? commissionRate : 0
  let allocated = 0
  let commission = 0

  for (const item of sourceItems) {
    const itemAllocated = roundMoney(asMoney(item.received) * ratio)
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
