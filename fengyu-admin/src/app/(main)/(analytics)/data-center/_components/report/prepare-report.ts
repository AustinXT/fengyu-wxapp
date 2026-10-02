import { redirect } from "next/navigation"
import {
  evaluateDataStart,
  type DataStartAxis,
  type DataStartRangeResult,
  type StoreDataStarts,
} from "@/lib/data-center/data-start"
import type { SearchQuery } from "@/lib/data-center/entry"
import { reportNoticeRanges, resolveReportPage, type ReportPageContext } from "@/lib/data-center/report-page"
import type { DataCenterReport } from "@/lib/data-center/reports"
import { scopeStores } from "@/lib/data-center/scope-options"
import type { DataCenterScopeOptions, ResolvedRange } from "@/lib/data-center/types"
import { loadDataStartsSafely } from "../load-data-starts"

/**
 * 经营明细报表页的服务端准备（#367）：权限闸门 + 入口控制流 + 期间解析 + 数据起点判定。
 *
 * @param loadScopeOptions 该页的 scope 数据源，兼任 SSR 权限闸门——必须与 `report.requiredActions` 对应：
 *                         dashboard 类用 getDataCenterScopeOptions，顾客明细 / 员工提成类用各自的专用数据源
 * @param axes             该页指标所用的时间轴；仅范围型页面或不需要提示时传空数组（不查数据起点）
 * @param extraNotices     页面额外的时间窗口（如主表 R 列的年度累计），各自带轴，追加在所选期间之后判定
 */
export async function prepareReport(input: {
  report: DataCenterReport
  query: SearchQuery
  loadScopeOptions: () => Promise<DataCenterScopeOptions>
  axes: readonly DataStartAxis[]
  extraNotices?: (period: ReportPageContext['period']) => ReadonlyArray<{
    label: string
    range: ResolvedRange
    axes: readonly DataStartAxis[]
  }>
}): Promise<{
  scopeOptions: DataCenterScopeOptions
  context: ReportPageContext
  notice: DataStartRangeResult[]
}> {
  // 主轴或额外窗口任一需要提示就查起点（只声明 extraNotices 的页面也要能出提示）
  const needsStarts = (input.axes.length > 0 || !!input.extraNotices) && input.report.periodKind !== "none"
  const [scopeOptions, starts] = await Promise.all([
    input.loadScopeOptions(),
    // 数据起点只是辅助提示：取数失败时降级为不提示（见 loadDataStartsSafely）
    needsStarts ? loadDataStartsSafely() : Promise.resolve<StoreDataStarts>({}),
  ])

  const page = resolveReportPage({
    path: input.report.path,
    query: input.query,
    scopeOptions,
    periodKind: input.report.periodKind,
  })
  if (page.kind === "redirect") redirect(page.url)
  const { context } = page

  const stores = context.scope ? scopeStores(scopeOptions, context.scope) : []
  const notice = needsStarts && context.scope
    ? [
        ...evaluateDataStart({ ranges: reportNoticeRanges(context.period), axes: input.axes, stores, starts }),
        ...(input.extraNotices?.(context.period) ?? []).flatMap((extra) =>
          evaluateDataStart({ ranges: [{ label: extra.label, range: extra.range }], axes: extra.axes, stores, starts }),
        ),
      ]
    : []

  return { scopeOptions, context, notice }
}
