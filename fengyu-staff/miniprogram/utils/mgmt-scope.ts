// utils/mgmt-scope.ts — 管理层看板 scope 的「已停用门店」处理（#400，口径与文案对齐 admin #293）
//
// 「在营」只看门店组织节点 org_nodes.is_active（云函数判定，见 staffApi utils/store-status.js）。
// 首页 summary 与销售数据 salesData 的取数 SQL 会滤掉停用门店的全部数据（满屏 0，与「在营门店
// 本期无业绩」分不开）→ 以接口下发的 scope.inactive 为准出空态；在营门店无业绩照常显示 0。
//
// ⚠️ 客量 / 品项 / 顾客子页的接口不叠加启停过滤，停用门店的历史数据照常可查 —— 这三页不出空态，
// 只在范围标签上标「（已停用）」，标记经 hub 的 query（scopeInactive=1）继承。

/** 子页 query 里的停用标记键 */
export const SCOPE_INACTIVE_QUERY_KEY = 'scopeInactive'

/** 空态主文案（与 admin ScopeEmptyState 同句） */
export function inactiveScopeText(storeName: string): string {
  return `「${storeName || '该门店'}」已停用，无可展示数据`
}

/** 空态第二行：后端判定账号还有没有别的在营门店可切；未知（null / 旧云函数）不出第二行 */
export function inactiveScopeHint(hasActiveAlternative: boolean | null | undefined): string {
  if (hasActiveAlternative === true) return '请点击上方范围切换到在营门店'
  if (hasActiveAlternative === false) return '当前账号没有其它在营门店可查看'
  return ''
}

/** 子页 query 是否带停用标记（仅用于范围标签展示） */
export function isInactiveScopeQuery(query: Record<string, string | undefined> | undefined): boolean {
  return query?.[SCOPE_INACTIVE_QUERY_KEY] === '1'
}

// ---------------------------------------------------------------------------
// 默认范围（#424，staff 侧副本，规则对齐 admin lib/data-center/scope-options.ts resolveDefaultDataCenterScope #399）
// ---------------------------------------------------------------------------

export interface MgmtScopeValue {
  scopeType: 'all' | 'market' | 'store'
  scopeId: string | null
  scopeName: string
  marketId?: string
  inactive?: boolean
}

/** scopeOptions 回包中决定默认范围的部分：markets[].stores 只含在营门店 */
export interface MgmtScopeOptionsLite {
  allowAll: boolean
  /** 直接授权（scopeOrgNodeIds 含）的市场 */
  allowedMarketIds: string[]
  markets: Array<{ id: string; name: string; stores: Array<{ storeId: string; storeName: string }> }>
}

/**
 * 管理层看板默认范围，逐级取第一个有候选的档位：
 *   1. 总部 → 全部市场
 *   2. 有在营门店的直接授权市场 → 该市场（staff 无 admin 的「全部授权门店」，市场账号沿用市场范围）
 *   3. 有在营门店 → 门店（店长管辖门店优先）
 *   4. 直接授权的无门店市场（如只授权品项公司）→ 该市场
 *   5. 都没有 → null，保留页面初判（全部停用时由 #400 停用逻辑处理）
 * 与 admin 对齐的关键：有在营门店时绝不落到无门店市场（店长 + hr@品项公司 → 门店）。
 *
 * `current`（页面初判）已属于命中档位时原样保留，只在档位不对时才换——
 * 页面按绑定 / scopedStores 顺序挑的市场、门店不因下拉排序被改掉；门店档不校验是否在在营列表里（交 #400）。
 */
export function resolveDefaultMgmtScope(
  options: MgmtScopeOptionsLite,
  current: MgmtScopeValue | null,
  managerStoreIds: string[],
): MgmtScopeValue | null {
  if (options.allowAll) {
    return current?.scopeType === 'all' ? current : { scopeType: 'all', scopeId: null, scopeName: '全部市场' }
  }
  const granted = new Set(options.allowedMarketIds || [])
  const markets = options.markets || []
  const pickMarket = (candidates: typeof markets): MgmtScopeValue | null => {
    if (candidates.length === 0) return null
    if (current?.scopeType === 'market' && candidates.some((m) => m.id === current.scopeId)) return current
    const m = candidates[0]
    return { scopeType: 'market', scopeId: m.id, scopeName: m.name, marketId: m.id }
  }

  const grantedWithStores = pickMarket(markets.filter((m) => granted.has(m.id) && m.stores.length > 0))
  if (grantedWithStores) return grantedWithStores

  const stores: Array<{ storeId: string; storeName: string; marketId: string; marketName: string }> = []
  for (const m of markets) {
    for (const s of m.stores) {
      if (!stores.some((x) => x.storeId === s.storeId)) {
        stores.push({ storeId: s.storeId, storeName: s.storeName, marketId: m.id, marketName: m.name })
      }
    }
  }
  if (stores.length > 0) {
    // 页面初判的门店一律保留：它出自 scopedStores（权限内），启停由 #400 逻辑按 inactiveStores / autoCorrect 处理，
    // 这里只纠正档位（市场 ↔ 门店）。否则 inactiveStores 未知（null）或「只关店、节点在营」的门店会被换掉
    if (current?.scopeType === 'store') return current
    const managerIds = new Set(managerStoreIds || [])
    const s = stores.find((x) => managerIds.has(x.storeId)) || stores[0]
    return { scopeType: 'store', scopeId: s.storeId, scopeName: `${s.marketName} · ${s.storeName}`, marketId: s.marketId }
  }

  return pickMarket(markets.filter((m) => granted.has(m.id) && m.stores.length === 0))
}
