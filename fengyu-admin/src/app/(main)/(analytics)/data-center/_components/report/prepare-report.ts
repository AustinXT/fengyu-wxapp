import { redirect } from "next/navigation"
import { getDataStartDates } from "@/actions/data-center/shared"
import { evaluateDataStart, type DataStartAxis, type DataStartRangeResult } from "@/lib/data-center/data-start"
import type { SearchQuery } from "@/lib/data-center/entry"
import { reportNoticeRanges, resolveReportPage, type ReportPageContext } from "@/lib/data-center/report-page"
import type { DataCenterReport } from "@/lib/data-center/reports"
import { scopeStores } from "@/lib/data-center/scope-options"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"

/**
 * 经营明细报表页的服务端准备（#367）：权限闸门 + 入口控制流 + 期间解析 + 数据起点判定。
 *
 * @param loadScopeOptions 该页的 scope 数据源，兼任 SSR 权限闸门——必须与 `report.requiredActions` 对应：
 *                         dashboard 类用 getDataCenterScopeOptions，顾客明细 / 员工提成类用各自的专用数据源
 * @param axes             该页指标所用的时间轴；仅范围型页面或不需要提示时传空数组（不查数据起点）
 */
export async function prepareReport(input: {
  report: DataCenterReport
  query: SearchQuery
  loadScopeOptions: () => Promise<DataCenterScopeOptions>
  axes: readonly DataStartAxis[]
}): Promise<{
  scopeOptions: DataCenterScopeOptions
  context: ReportPageContext
  notice: DataStartRangeResult[]
}> {
  const needsStarts = input.axes.length > 0 && input.report.periodKind !== "none"
  const [scopeOptions, starts] = await Promise.all([
    input.loadScopeOptions(),
    needsStarts ? getDataStartDates() : Promise.resolve({}),
  ])

  const page = resolveReportPage({
    path: input.report.path,
    query: input.query,
    scopeOptions,
    periodKind: input.report.periodKind,
  })
  if (page.kind === "redirect") redirect(page.url)
  const { context } = page

  const notice = needsStarts && !context.noViewableScope
    ? evaluateDataStart({
        ranges: reportNoticeRanges(context.period),
        axes: input.axes,
        stores: scopeStores(scopeOptions, context.scope),
        starts,
      })
    : []

  return { scopeOptions, context, notice }
}
