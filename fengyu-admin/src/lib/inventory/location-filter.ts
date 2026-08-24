import type {
  InventoryLocationFilterMarket,
  InventoryLocationFilterOptions,
  InventoryLocationRow,
} from './types'

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name, 'zh-CN')
}

/**
 * 将库存主体行裁剪成精确主体选择模型。
 *
 * 门店级用户仍需要看到所属市场作为导航分组，但市场本级库存不可选；因此市场分组
 * 可以来自可见门店的 parentLocationId，而 canSelectInventory 只由 scopedLocationIds 决定。
 */
export function buildInventoryLocationFilterOptions(
  activeLocations: InventoryLocationRow[],
  scopedLocationIds: readonly string[] | null,
): InventoryLocationFilterOptions {
  const accessibleIds = scopedLocationIds === null ? null : new Set(scopedLocationIds)
  const isAccessible = (locationId: string) => accessibleIds === null || accessibleIds.has(locationId)

  const headquarters = activeLocations
    .filter((location) => location.locationType === '总部' && isAccessible(location.locationId))
    .map((location) => ({ locationId: location.locationId, name: location.name }))
    .sort(byName)

  const accessibleStores = activeLocations
    .filter((location) => location.locationType === '门店' && isAccessible(location.locationId))
  const storesByMarket = new Map<string, Array<{ locationId: string; name: string }>>()
  for (const store of accessibleStores) {
    if (!store.parentLocationId) continue
    const stores = storesByMarket.get(store.parentLocationId) ?? []
    stores.push({ locationId: store.locationId, name: store.name })
    storesByMarket.set(store.parentLocationId, stores)
  }

  const markets: InventoryLocationFilterMarket[] = activeLocations
    .filter((location) => location.locationType === '市场')
    .filter((location) => isAccessible(location.locationId) || storesByMarket.has(location.locationId))
    .map((location) => ({
      locationId: location.locationId,
      name: location.name,
      canSelectInventory: isAccessible(location.locationId),
      stores: (storesByMarket.get(location.locationId) ?? []).sort(byName),
    }))
    .sort(byName)

  const defaultLocationId = headquarters[0]?.locationId
    ?? markets.find((market) => market.canSelectInventory)?.locationId
    ?? markets.flatMap((market) => market.stores)[0]?.locationId
    ?? null

  return { headquarters, markets, defaultLocationId }
}

export function inventoryFilterSelectableLocationIds(
  options: InventoryLocationFilterOptions,
): Set<string> {
  return new Set([
    ...options.headquarters.map((location) => location.locationId),
    ...options.markets.flatMap((market) => [
      ...(market.canSelectInventory ? [market.locationId] : []),
      ...market.stores.map((store) => store.locationId),
    ]),
  ])
}

/** URL 未传或传入越权主体时，稳定回退到当前 action scope 的最高授权本级。 */
export function resolveInventoryFilterLocationId(
  options: InventoryLocationFilterOptions,
  requestedLocationId?: string | null,
): string | null {
  if (
    requestedLocationId
    && inventoryFilterSelectableLocationIds(options).has(requestedLocationId)
  ) {
    return requestedLocationId
  }
  return options.defaultLocationId
}
