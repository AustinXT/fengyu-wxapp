import type { DataCenterScope, DataCenterScopeOptions, ScopeOptionStore } from './types'

/** 去重后的可见在营门店，用于决定数据中心默认范围及筛选器锁定状态。 */
export function visibleScopeStores(scopeOptions: DataCenterScopeOptions): ScopeOptionStore[] {
  const stores = new Map<string, ScopeOptionStore>()
  for (const market of scopeOptions.markets) {
    for (const store of market.stores) stores.set(store.storeId, store)
  }
  return Array.from(stores.values())
}

/**
 * 数据中心默认范围：总部看全部，多店账号看全部授权门店，单店账号落到该店。
 * 非总部账号没有可见在营门店时返回 null，由页面展示空状态。
 */
export function resolveDefaultDataCenterScope(
  scopeOptions: DataCenterScopeOptions,
): DataCenterScope | null {
  if (scopeOptions.topLevel === 'all') return { type: 'all' }

  const stores = visibleScopeStores(scopeOptions)
  if (stores.length === 0) return null
  if (stores.length > 1) return { type: 'authorized' }
  return { type: 'store', id: stores[0].storeId }
}

export interface ScopeStoreEntry {
  storeId: string
  storeName: string
  marketId: string
  marketName: string
}

/** 当前 scope 覆盖的在营门店（按筛选器数据源展开，与页面取数同一范围），带出所属市场。 */
export function scopeStores(scopeOptions: DataCenterScopeOptions, scope: DataCenterScope): ScopeStoreEntry[] {
  const result: ScopeStoreEntry[] = []
  const seen = new Set<string>()
  for (const market of scopeOptions.markets) {
    if (scope.type === 'market' && market.id !== scope.id) continue
    for (const store of market.stores) {
      if (scope.type === 'store' && store.storeId !== scope.id) continue
      if (seen.has(store.storeId)) continue
      seen.add(store.storeId)
      result.push({ storeId: store.storeId, storeName: store.storeName, marketId: market.id, marketName: market.name })
    }
  }
  return result
}

/** scope 的展示名（信息条用）。找不到对应市场 / 门店时回落通用名，不抛错。 */
export function scopeLabel(scopeOptions: DataCenterScopeOptions, scope: DataCenterScope): string {
  if (scope.type === 'all') return '全部市场'
  if (scope.type === 'authorized') return '全部授权门店'
  if (scope.type === 'market') return scopeOptions.markets.find((m) => m.id === scope.id)?.name ?? '所选市场'
  for (const market of scopeOptions.markets) {
    const store = market.stores.find((s) => s.storeId === scope.id)
    if (store) return store.storeName
  }
  return '所选门店'
}
