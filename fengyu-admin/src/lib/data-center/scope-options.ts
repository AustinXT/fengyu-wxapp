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
 * 直接授权、且没有可见在营门店的市场（如品项公司）：只能以「市场」范围进入，看锚定到它的无门店员工（#399）。
 * 门店级账号补进来的祖先市场（granted=false）不算——唯一门店被停用的店长不能因此被带到整个市场。
 */
function isGrantedEmptyMarket(market: DataCenterScopeOptions['markets'][number]): boolean {
  return market.granted === true && market.stores.length === 0
}

/**
 * 数据中心默认范围：总部看全部，多店账号看全部授权门店，单店账号落到该店。
 * 非总部账号没有可见在营门店、但有直接授权的无门店市场（如只授权到品项公司）时落到第一个这样的市场（#399）：
 * 该市场的人效榜仍有锚定到它的无门店员工（orgAnchorScopeSql），其余板块按实为 0。
 * 两者都没有才返回 null，由页面展示空状态。
 */
export function resolveDefaultDataCenterScope(
  scopeOptions: DataCenterScopeOptions,
): DataCenterScope | null {
  if (scopeOptions.topLevel === 'all') return { type: 'all' }

  const stores = visibleScopeStores(scopeOptions)
  if (stores.length > 1) return { type: 'authorized' }
  if (stores.length === 1) return { type: 'store', id: stores[0].storeId }
  const market = scopeOptions.markets.find(isGrantedEmptyMarket)
  return market ? { type: 'market', id: market.id } : null
}

/**
 * 非总部账号可切换到的范围个数 = 可见在营门店 + 直接授权的无门店市场（#399）。
 * 后者只能以「市场」范围进入（看锚定员工），必须计入；有门店的市场不单独计数——
 * 门店级账号的所属市场也在市场列表里（expandVisibleMarketIds 补的祖先市场），单店店长不能因此被解锁。
 */
export function selectableScopeCount(scopeOptions: DataCenterScopeOptions): number {
  return visibleScopeStores(scopeOptions).length + scopeOptions.markets.filter(isGrantedEmptyMarket).length
}

/** 范围下拉是否锁定：非总部且只有一个可选范围（单店账号 / 只授权一个无门店市场的账号）。 */
export function isScopeLocked(scopeOptions: DataCenterScopeOptions): boolean {
  return scopeOptions.topLevel !== 'all' && selectableScopeCount(scopeOptions) <= 1
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
      if (scope.type === 'stores' && !scope.ids.includes(store.storeId)) continue
      if (seen.has(store.storeId)) continue
      seen.add(store.storeId)
      result.push({ storeId: store.storeId, storeName: store.storeName, marketId: market.id, marketName: market.name })
    }
  }
  return result
}

/**
 * scope 的展示名（信息条用）。用语与板块 meta / 导出件的 `resolveScopeName`（context.ts，查库版）一致；
 * 这里只在筛选器数据源里找，找不到（越权的 scopeId）回落同样的「未知」名，不抛错。
 * 只关店、节点仍启用的门店在数据源里（#401 在营只看节点），能正常显示店名。
 * 已停用门店不会走到这里：入口把它的 scope 置 null，信息条不渲染（#293）。
 */
export function scopeLabel(scopeOptions: DataCenterScopeOptions, scope: DataCenterScope): string {
  if (scope.type === 'all') return '全部'
  if (scope.type === 'authorized') return '全部授权门店'
  if (scope.type === 'market') return scopeOptions.markets.find((m) => m.id === scope.id)?.name ?? '未知市场'
  if (scope.type === 'stores') return multiStoreName(scope.ids.map((id) => storeNameIn(scopeOptions, id)))
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
  if (scope.type === 'stores') {
    // 多店（#376 拍板）：所选门店**全部**停用才走空态；部分停用照常取数（SQL 只算在营部分），由下拉提示
    const inactive = scope.ids.map((id) => findInactiveStore(scopeOptions, id))
    if (inactive.some((store) => store === null)) return null
    const stores = inactive as ScopeOptionInactiveStore[]
    return {
      storeId: scope.ids.join(','),
      storeName: multiStoreName(stores.map((store) => store.storeName)),
      marketId: null,
    }
  }
  if (scope.type !== 'store') return null
  return findInactiveStore(scopeOptions, scope.id)
}

/** 单个门店 id 是否权限内已停用（在营列表优先，见 findInactiveScopeStore 注释） */
function findInactiveStore(scopeOptions: DataCenterScopeOptions, storeId: string): ScopeOptionInactiveStore | null {
  if (visibleScopeStores(scopeOptions).some((store) => store.storeId === storeId)) return null
  return scopeOptions.inactiveStores.find((store) => store.storeId === storeId) ?? null
}

/**
 * 多店范围里已停用的那部分（#376）：有在营门店时才返回（全部停用走 findInactiveScopeStore 的空态）。
 * 这些门店的数据被取数 SQL 的在营过滤滤掉，下拉据此提示「N 家已停用，不计入统计」。
 */
export function inactiveStoresInScope(
  scopeOptions: DataCenterScopeOptions,
  scope: DataCenterScope,
): ScopeOptionInactiveStore[] {
  if (scope.type !== 'stores') return []
  const inactive = scope.ids
    .map((id) => findInactiveStore(scopeOptions, id))
    .filter((store): store is ScopeOptionInactiveStore => store !== null)
  return inactive.length < scope.ids.length ? inactive : []
}

/** 多店展示名（#376）：≤3 家列全名，更多时列前 3 家 + 「等 N 家门店」。信息条、空态与导出元信息共用。 */
export function multiStoreName(names: readonly string[]): string {
  if (names.length <= 3) return names.join('、')
  return `${names.slice(0, 3).join('、')} 等 ${names.length} 家门店`
}

function storeNameIn(scopeOptions: DataCenterScopeOptions, storeId: string): string {
  for (const market of scopeOptions.markets) {
    const store = market.stores.find((s) => s.storeId === storeId)
    if (store) return store.storeName
  }
  return scopeOptions.inactiveStores.find((s) => s.storeId === storeId)?.storeName ?? '未知门店'
}

/**
 * 范围规范化（#376）：前端写 URL 与服务端入口共用，保证同一选择只有一种编码。
 *   - 多店恰好等于账号全部可见在营门店 → 总部 'all'、非总部 'authorized'（沿用现有编码）
 *   - 多店恰好等于某一市场下全部可见在营门店（且未勾别的）→ 折叠成 'market'。
 *     与 stores 语义等价：scopeFilterSql 两边都是「该市场的可见在营门店」；orgAnchorScopeSql 两边都是
 *     「锚定 = 该市场」且该市场下有可见在营门店（祖先市场走同一条可见性，#399）。
 *     同时勾满两个及以上市场不折叠（没有「多市场」形态），保持 stores。
 *   - 含停用 / 数据源外门店 → 原样返回：停用要保留「N 家已停用」提示，数据源外由入口跳默认范围 / validateScope 拒。
 * 其余范围原样返回。
 */
export function canonicalizeScope(scopeOptions: DataCenterScopeOptions, scope: DataCenterScope): DataCenterScope {
  if (scope.type !== 'stores') return scope
  const visible = new Set(visibleScopeStores(scopeOptions).map((store) => store.storeId))
  if (!scope.ids.every((id) => visible.has(id))) return scope
  if (scope.ids.length === visible.size) {
    return scopeOptions.topLevel === 'all' ? { type: 'all' } : { type: 'authorized' }
  }
  const market = scopeOptions.markets.find(
    (m) => m.stores.length === scope.ids.length && m.stores.every((store) => scope.ids.includes(store.storeId)),
  )
  return market ? { type: 'market', id: market.id } : scope
}
