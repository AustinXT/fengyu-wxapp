import type { DataCenterScope, DataCenterScopeOptions, ScopeOptionInactiveStore, ScopeOptionStore } from './types'

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

/**
 * scope 的展示名（信息条用）。用语与板块 meta / 导出件的 `resolveScopeName`（context.ts，查库版）一致；
 * 这里只在筛选器数据源里找，找不到（越权 / 已关店的 scopeId）回落同样的「未知」名，不抛错。
 * 已停用门店不会走到这里：入口把它的 scope 置 null，信息条不渲染（#293）。
 */
export function scopeLabel(scopeOptions: DataCenterScopeOptions, scope: DataCenterScope): string {
  if (scope.type === 'all') return '全部'
  if (scope.type === 'authorized') return '全部授权门店'
  if (scope.type === 'market') return scopeOptions.markets.find((m) => m.id === scope.id)?.name ?? '未知市场'
  for (const market of scopeOptions.markets) {
    const store = market.stores.find((s) => s.storeId === scope.id)
    if (store) return store.storeName
  }
  return '未知门店'
}

/**
 * URL 选中的门店是否是权限内的已停用门店（#293）。
 *
 * 停用门店仍在账号 scopeStoreIds 里（validateScope 放行），但取数 SQL 的启用门店过滤会把它的数据全部滤掉，
 * 不拦在入口就是满屏 0，和「在营门店本期无业绩」分不开。判定只看筛选器数据源：
 *   - 仍在在营列表里 → 不是停用（数据源以在营列表为准，防两份列表同时出现同一家时误判空态）
 *   - 市场 / 全部 / 授权汇总 → 不判（市场下没有在营门店仍可能有锚定市场的无门店员工数据，见 orgAnchorScopeSql）
 */
export function findInactiveScopeStore(
  scopeOptions: DataCenterScopeOptions,
  scope: DataCenterScope,
): ScopeOptionInactiveStore | null {
  if (scope.type !== 'store') return null
  if (visibleScopeStores(scopeOptions).some((store) => store.storeId === scope.id)) return null
  return scopeOptions.inactiveStores.find((store) => store.storeId === scope.id) ?? null
}
