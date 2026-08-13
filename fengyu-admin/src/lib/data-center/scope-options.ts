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
