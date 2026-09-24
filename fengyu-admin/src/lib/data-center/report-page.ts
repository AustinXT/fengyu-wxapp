/**
 * 经营明细报表页的服务端入口解析（#367，纯函数）。
 *
 * 5 张报表页（及提成明细下钻）共用：入口控制流（默认 scope 补齐 / 重复 key 规范化 / 空范围）
 * 与板块页同源（`resolveDataCenterEntry`），期间按页面形态解析，返回页面渲染所需的上下文。
 */
import { defaultScopeParams, resolveDataCenterEntry, type SearchQuery } from './entry'
import { firstQueryValue, parseScope } from './params'
import { parseReportMonth, parseReportRange, type ReportPeriod } from './report-period'
import { shanghaiToday } from './time-range'
import type { DataCenterScope, DataCenterScopeOptions, ResolvedRange } from './types'

export type ReportPeriodKind = 'range' | 'month' | 'none'

export interface ReportPageContext {
  scope: DataCenterScope
  /** 仅范围型页面为 null */
  period: ReportPeriod | null
  /** 非总部却没有可查看的门店：页面渲染空态，不取数 */
  noViewableScope: boolean
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
  const period: ReportPeriod | null =
    input.periodKind === 'range'
      ? parseReportRange({ period: get('period'), start: get('start'), end: get('end') }, today)
      : input.periodKind === 'month'
        ? parseReportMonth({ month: get('month') }, today)
        : null

  return {
    kind: 'render',
    context: {
      scope: parseScope({ scope: get('scope'), scopeId: get('scopeId') }),
      period,
      noViewableScope: entry.noViewableScope,
      defaultQuery: defaultScopeParams(input.scopeOptions) ?? {},
      today,
    },
  }
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
