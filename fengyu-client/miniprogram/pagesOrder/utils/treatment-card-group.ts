// 仅供 pagesOrder 分包使用，不能迁回主包 utils，否则会增加主包体积。
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
  /**
   * 操作列表不能把历史 quantity > 1 的单行拆成多张卡；默认让该行独立成组。
   * 纯展示场景可显式设为 false。
   */
  preserveNonUnitQuantity?: boolean
}

function stableKey(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
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
