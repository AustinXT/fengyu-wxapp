import { redirect, unstable_rethrow } from "next/navigation"
import { getDataStartDates } from "@/actions/data-center/shared"
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
    // 数据起点只是辅助提示：取数失败时降级为不提示，不能把整张报表页变成错误页。
    // 权限闸门由 loadScopeOptions 承担（它先于或同时 reject），这里吞掉的不会是页面级的 403。
    needsStarts
      ? getDataStartDates().catch((error: unknown): StoreDataStarts => {
          unstable_rethrow(error) // 会话过期的登录跳转等 Next 控制流错误照常上抛
          console.error("[data-center] 数据起点取数失败，本次不显示提示", error)
          return {}
        })
      : Promise.resolve<StoreDataStarts>({}),
  ])

  const page = resolveReportPage({
    path: input.report.path,
    query: input.query,
    scopeOptions,
    periodKind: input.report.periodKind,
  })
  if (page.kind === "redirect") redirect(page.url)
  const { context } = page

  const notice = needsStarts && context.scope
    ? evaluateDataStart({
        ranges: reportNoticeRanges(context.period),
        axes: input.axes,
        stores: scopeStores(scopeOptions, context.scope),
        starts,
      })
    : []

  return { scopeOptions, context, notice }
}
