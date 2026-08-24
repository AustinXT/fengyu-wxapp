export interface TreatmentCardGroup<T> {
  groupKey: string
  primary: T
  sourceItems: T[]
  cardCount: number
}

export interface TreatmentCardGroupOptions<T> {
  getId: (item: T) => string
  getIdentity: (item: T) => unknown
  getQuantity?: (item: T) => number | null | undefined
  /** 操作列表中，历史 quantity > 1 的单行继续作为一个不可拆来源。 */
  preserveNonUnitQuantity?: boolean
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, item]) => `${JSON.stringify(field)}:${stableKey(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? String(value)
}

const TREATMENT_CARD_IDENTITY_IGNORED_FIELDS = new Set([
  'saleItemId',
  'saleItemGroupId',
  'saleOrderId',
  'sourceSaleOrderId',
  'sale_item_id',
  'sale_item_group_id',
  'sale_order_id',
  'source_sale_order_id',
  'orderRemark',
  'order_remark',
])

export interface SourceOrderRemark {
  saleOrderId: string
  orderRemark: string
}

/** 按来源订单去重并保留各自备注；空备注不产生展示项。 */
export function collectSourceOrderRemarks<T extends { saleOrderId?: string; orderRemark?: string | null }>(
  items: readonly T[],
): SourceOrderRemark[] {
  const remarks = new Map<string, SourceOrderRemark>()
  for (const item of items) {
    const saleOrderId = item.saleOrderId?.trim() || ''
    const orderRemark = item.orderRemark?.trim() || ''
    if (saleOrderId && orderRemark && !remarks.has(saleOrderId)) {
      remarks.set(saleOrderId, { saleOrderId, orderRemark })
    }
  }
  return Array.from(remarks.values())
}

/** 展示合并忽略订单/卡行技术 ID，其余业务快照字段必须完全一致。 */
export function getTreatmentCardBusinessIdentity(snapshot: object): Record<string, unknown> {
  const identity: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(snapshot)) {
    if (!TREATMENT_CARD_IDENTITY_IGNORED_FIELDS.has(field)) {
      identity[field] = value
    }
  }
  return identity
}

export function groupTreatmentCards<T>(
  items: readonly T[],
  options: TreatmentCardGroupOptions<T>,
): TreatmentCardGroup<T>[] {
  const groups = new Map<string, TreatmentCardGroup<T>>()
  const preserveNonUnitQuantity = options.preserveNonUnitQuantity ?? true

  for (const item of items) {
    const quantity = Number(options.getQuantity?.(item) ?? 1)
    const groupable = !preserveNonUnitQuantity || quantity === 1
    const identity = groupable
      ? options.getIdentity(item)
      : { identity: options.getIdentity(item), sourceId: options.getId(item) }
    const groupKey = stableKey(identity)
    const existing = groups.get(groupKey)

    if (existing) {
      existing.sourceItems.push(item)
      existing.cardCount += Number.isFinite(quantity) && quantity > 0 ? quantity : 1
      continue
    }

    groups.set(groupKey, {
      groupKey,
      primary: item,
      sourceItems: [item],
      cardCount: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    })
  }

  return Array.from(groups.values())
}

export function sumGroupValue<T>(
  group: TreatmentCardGroup<T>,
  getValue: (item: T) => number | string | null | undefined,
): number {
  return group.sourceItems.reduce((total, item) => total + (Number(getValue(item)) || 0), 0)
}

export function expandGroupServiceSessions<T>(
  group: TreatmentCardGroup<T>,
  requestedSessions: number,
  getId: (item: T) => string,
  getAvailableSessions: (item: T) => number | null | undefined,
): Array<{ saleItemId: string; sessionUsed: number }> {
  let remaining = Math.max(0, Math.floor(requestedSessions))
  const expanded: Array<{ saleItemId: string; sessionUsed: number }> = []

  for (const item of group.sourceItems) {
    if (remaining <= 0) break
    const available = Math.max(0, Math.floor(Number(getAvailableSessions(item)) || 0))
    const sessionUsed = Math.min(available, remaining)
    if (sessionUsed > 0) {
      expanded.push({ saleItemId: getId(item), sessionUsed })
      remaining -= sessionUsed
    }
  }

  return expanded
}

export function selectGroupSourceIds<T>(
  group: TreatmentCardGroup<T>,
  count: number,
  getId: (item: T) => string,
): string[] {
  const selectedCount = Math.max(0, Math.min(group.sourceItems.length, Math.floor(count)))
  return group.sourceItems.slice(0, selectedCount).map(getId)
}
