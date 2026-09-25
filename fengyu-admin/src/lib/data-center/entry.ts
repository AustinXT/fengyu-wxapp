/**
 * 数据中心页面入口控制流（纯函数，板块页与经营明细报表页共用，#367）。
 *
 * 由 `[board]/page.tsx` 原内联逻辑抽出，行为逐条不变：
 *   1. 非总部账号 + URL 无有效 scope → 重定向补上权限默认 scope（非总部绝不以 'all' 取数）
 *   2. 重复 query key → 规范化成单值（服务端按首值判定、客户端按末值取数，两边必须看同一份 query）
 *   3. 非总部却没有可用默认 scope → 不跳转，交给页面渲染空态（不进入无限重定向）
 *   4. URL 选中权限内的已停用门店 → 不跳转，交给页面渲染「已停用」空态（#293）
 *
 * 背景见 memory `project-data-center-default-scope-non-hq`：scope='all' 抵达取数 action 会抛
 * PERMISSION_DENIED，生产脱敏后表现为「数据加载失败」。
 */
import { collapseQuery, firstQueryValue, hasRepeatedQueryKey, parseScope } from './params'
import { findInactiveScopeStore, resolveDefaultDataCenterScope } from './scope-options'
import type { DataCenterScope, DataCenterScopeOptions, ScopeOptionInactiveStore } from './types'

export type SearchQuery = Record<string, string | string[] | undefined>

export type DataCenterEntry =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'render'
      noViewableScope: boolean
      /**
       * URL 选中的是权限内已停用门店（#293）：页面渲染「已停用」空态、不取数。
       * 取数 SQL 的启用门店过滤会把它的数据全部滤掉，放行取数只会得到满屏 0。
       */
      inactiveStore: ScopeOptionInactiveStore | null
      /**
       * 停用门店空态的出口：本页 + 权限默认范围（保留其余参数）。没有可回的默认范围时为 null。
       * 单在营门店账号的范围下拉是锁定的、板块页也没有「重置」，不给这个出口就只能靠侧边栏离开。
       */
      defaultScopeHref: string | null
    }

type ConcreteScope = Exclude<DataCenterScope, { type: 'all' }>

/**
 * 默认 scope 必须是「redirect 后 parseScope 还认得出」的具体值，否则下一跳又回落 'all'、
 * 再次需要补 scope —— 无限重定向，浏览器直接转死。
 *
 * `resolveDefaultDataCenterScope` 的契约本就保证非总部只会给 authorized/store（storeId 是 DB uuid），
 * 这里显式校验一次，把「依赖另一个文件的隐式契约」变成「不满足就降级成空态」。
 */
function isUsableDefaultScope(scope: DataCenterScope | null): scope is ConcreteScope {
  if (scope === null || scope.type === 'all') return false
  return scope.type === 'authorized' || Boolean(scope.id)
}

/**
 * 权限默认范围对应的 URL 参数：总部为空（即「全部市场」），其余为具体 scope。
 * 非总部且无可用默认范围时返回 null。筛选器「重置」与入口补 scope 共用这一份。
 */
export function defaultScopeParams(scopeOptions: DataCenterScopeOptions): Record<string, string> | null {
  if (scopeOptions.topLevel === 'all') return {}
  const scope = resolveDefaultDataCenterScope(scopeOptions)
  if (!isUsableDefaultScope(scope)) return null
  return scope.type === 'authorized' ? { scope: 'authorized' } : { scope: scope.type, scopeId: scope.id }
}

/**
 * @param path        当前页面路径（redirect 必须停在本页——退回裸路径或硬编码别的页会把用户弹走）
 * @param legacyKeys  规范化时一并剔除的遗留参数（板块页传 `['tab']`：板块已由路径承载）
 */
export function resolveDataCenterEntry(
  path: string,
  query: SearchQuery,
  scopeOptions: DataCenterScopeOptions,
  legacyKeys: readonly string[] = [],
): DataCenterEntry {
  const rawScope = parseScope({
    scope: firstQueryValue(query.scope),
    scopeId: firstQueryValue(query.scopeId),
  })
  const defaults = defaultScopeParams(scopeOptions)
  const needsDefaultScope = rawScope.type === 'all' && scopeOptions.topLevel !== 'all'

  if (needsDefaultScope && defaults) {
    const next = collapseQuery(query, [...legacyKeys, 'scope', 'scopeId'])
    for (const [key, value] of Object.entries(defaults)) next.set(key, value)
    return { kind: 'redirect', url: `${path}?${next.toString()}` }
  }

  // 走到这里说明 URL 的 scope 已可用，但重复 key（?scope=store&scope=all）会让服务端按首值放行、
  // 客户端按末值取数被 validateScope 拒成「数据加载失败」。先规范化成单值，让两边看同一份 query。
  // 规范化后不再有数组，不会二次进入本分支。
  if (hasRepeatedQueryKey(query)) {
    const qs = collapseQuery(query, legacyKeys).toString()
    return { kind: 'redirect', url: `${path}${qs ? `?${qs}` : ''}` }
  }

  // 两者可同时成立：店长唯一的门店被停用、URL 又指向它。此时仍带出 inactiveStore，
  // 让空态说「已停用」而不是泛化的「暂无可查看范围」（筛选器此时也回显「XX（已停用）」，两处口径一致）。
  const inactiveStore = findInactiveScopeStore(scopeOptions, rawScope)
  let defaultScopeHref: string | null = null
  if (inactiveStore && defaults) {
    const next = collapseQuery(query, [...legacyKeys, 'scope', 'scopeId'])
    for (const [key, value] of Object.entries(defaults)) next.set(key, value)
    const qs = next.toString()
    defaultScopeHref = `${path}${qs ? `?${qs}` : ''}`
  }
  return {
    kind: 'render',
    noViewableScope: scopeOptions.topLevel !== 'all' && defaults === null,
    inactiveStore,
    defaultScopeHref,
  }
}
