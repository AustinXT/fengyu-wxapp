/**
 * 经营明细报表页的服务端入口解析（#367，纯函数）。
 *
 * 5 张报表页（及提成明细下钻）共用：入口控制流（默认 scope 补齐 / 重复 key 规范化 / 空范围）
 * 与板块页同源（`resolveDataCenterEntry`），期间按页面形态解析，返回页面渲染所需的上下文。
 */
import { defaultScopeParams, resolveDataCenterEntry, type SearchQuery } from './entry'
import { collapseQuery, firstQueryValue, parseScope } from './params'
import { parseReportMonth, parseReportRange, type ReportPeriod } from './report-period'
import { shanghaiToday } from './time-range'
import { visibleScopeStores } from './scope-options'
import type { DataCenterScope, DataCenterScopeOptions, ResolvedRange, ScopeOptionInactiveStore } from './types'

export type ReportPeriodKind = 'range' | 'month' | 'none'

export interface ReportPageContext {
  /**
   * 生效的 scope。非总部且没有可用默认范围（noViewableScope：既无可见在营门店、也无直接授权的无门店市场，#399）
   * 时为 null——此时 URL 里只可能是 'all' / 'authorized'，
   * 拿它取数必被 validateScope 拒成 PERMISSION_DENIED；置 null 让页面漏判 noViewableScope 在 tsc 就报错。
   * 选中已停用门店（inactiveStore）时同样为 null：拿它取数只会得到满屏 0。
   * ⚠️ 页面判「要不要取数 / 渲染自定义空态」一律以 `scope === null` 为准，别只看 noViewableScope——会漏掉停用门店。
   */
  scope: DataCenterScope | null
  /** 仅范围型页面为 null */
  period: ReportPeriod | null
  /** 非总部却没有可用默认范围（无可见在营门店且无直接授权的无门店市场，#399）：页面渲染空态，不取数 */
  noViewableScope: boolean
  /** URL 选中权限内的已停用门店（#293）：页面渲染「已停用」空态，不取数、不跳回默认范围 */
  inactiveStore: ScopeOptionInactiveStore | null
  /** 停用门店空态里「回到默认范围」的目标（见 DataCenterEntry.defaultScopeHref） */
  defaultScopeHref: string | null
  /** 「重置」目标：权限默认范围对应的 URL 参数（总部为空对象） */
  defaultQuery: Record<string, string>
  /** Asia/Shanghai 的今天，服务端算好传给筛选器，避免客户端跨午夜算出另一天 */
  today: string
}

export type ReportPageResolution =
  | { kind: 'redirect'; url: string }
  | { kind: 'render'; context: ReportPageContext }

export function resolveReportPage(input: {
  path: string
  query: SearchQuery
  scopeOptions: DataCenterScopeOptions
  periodKind: ReportPeriodKind
  today?: string
}): ReportPageResolution {
  const entry = resolveDataCenterEntry(input.path, input.query, input.scopeOptions)
  if (entry.kind === 'redirect') return entry

  const today = input.today ?? shanghaiToday()
  const get = (key: string) => firstQueryValue(input.query[key])
  const scope = parseScope({ scope: get('scope'), scopeId: get('scopeId') })
  const defaultQuery = defaultScopeParams(input.scopeOptions) ?? {}

  // URL 指向的市场 / 门店不在筛选器数据源里（调岗后的旧书签、已撤市场、手改 URL）：回到权限默认范围，
  // 保留其余参数。不这么做，页面会显示「未知门店（0 家门店）」且下拉回显错位，取数时再被 validateScope 拒成 403。
  // 终止性显式校验：默认范围本身必须在数据源内才跳（按构造恒成立：authorized / 数据源里的门店 / 总部 all），
  // 否则降级成空态，绝不冒无限重定向的险。
  // 已停用门店不在筛选器数据源里，但不能按「数据源外」跳回默认范围：那样用户点开停用门店的链接会被悄悄换成
  // 别的范围、看到别家的数，照样分不清「已停用」。entry 已识别出它，这里直接渲染空态。
  const { inactiveStore, defaultScopeHref } = entry
  let noViewableScope = entry.noViewableScope
  if (!noViewableScope && !inactiveStore && !isScopeInOptions(scope, input.scopeOptions)) {
    const fallback = parseScope({ scope: defaultQuery.scope, scopeId: defaultQuery.scopeId })
    if (isScopeInOptions(fallback, input.scopeOptions)) {
      const next = collapseQuery(input.query, ['scope', 'scopeId'])
      for (const [key, value] of Object.entries(defaultQuery)) next.set(key, value)
      const qs = next.toString()
      return { kind: 'redirect', url: `${input.path}${qs ? `?${qs}` : ''}` }
    }
    noViewableScope = true
  }

  const period: ReportPeriod | null =
    input.periodKind === 'range'
      ? parseReportRange({ period: get('period'), start: get('start'), end: get('end') }, today)
      : input.periodKind === 'month'
        ? parseReportMonth({ month: get('month') }, today)
        : null

  return {
    kind: 'render',
    context: {
      scope: noViewableScope || inactiveStore ? null : scope,
      period,
      noViewableScope,
      inactiveStore,
      defaultScopeHref,
      defaultQuery,
      today,
    },
  }
}

function isScopeInOptions(scope: DataCenterScope, scopeOptions: DataCenterScopeOptions): boolean {
  if (scope.type === 'market') return scopeOptions.markets.some((market) => market.id === scope.id)
  // 授权汇总要有可见在营门店才成立（#399：只授权无门店市场的账号拿到 ?scope=authorized 链接）
  if (scope.type === 'authorized') return scopeOptions.topLevel === 'all' || visibleScopeStores(scopeOptions).length > 0
  if (scope.type === 'store') {
    return scopeOptions.markets.some((market) => market.stores.some((store) => store.storeId === scope.id))
  }
  return true
}

/**
 * 数据起点提示要检查的期间：区间型 = 所选期间 + 较上期基期；单月型 = 所选月份。
 * 页面有额外时间窗口（如主表的年度累计）时在此基础上追加。
 */
export function reportNoticeRanges(period: ReportPeriod | null): Array<{ label: string; range: ResolvedRange }> {
  if (!period) return []
  if (period.kind === 'month') return [{ label: '所选月份', range: period.current }]
  return [
    { label: '所选期间', range: period.current },
    { label: '较上期基期', range: period.previous },
  ]
}
