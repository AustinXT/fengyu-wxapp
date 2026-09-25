import { getDataCenterScopeOptions } from "@/actions/data-center/shared"
import { getDailyOverview } from "@/actions/data-center/daily-overview"
import { firstQueryValue } from "@/lib/data-center/params"
import { DATA_CENTER_REPORTS } from "@/lib/data-center/reports"
import { prepareReport } from "../_components/report/prepare-report"
import { ReportLayout } from "../_components/report/report-layout"
import { DailyOverviewView } from "./_components/daily-overview-view"

export const dynamic = "force-dynamic"

const REPORT = DATA_CENTER_REPORTS.dailyOverview

/**
 * 日常数据一览表（经营类型 / 具体品项 / 二级品项三视角，#369）。
 * getDataCenterScopeOptions 兼任 SSR 权限闸门（见 DATA_CENTER_REPORTS.requiredActions）。
 * 业绩按款项归属日期、服务按服务日期，两条时间轴都参与数据起点提示。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const query = await searchParams
  const { scopeOptions, context, notice } = await prepareReport({
    report: REPORT,
    query,
    loadScopeOptions: getDataCenterScopeOptions,
    axes: ["performance", "service"],
  })

  // scope 为 null = 非总部且没有可查看范围：不取数（URL 里只可能是 'all'，取数必被拒）
  const result = context.scope
    ? await getDailyOverview({
        scope: firstQueryValue(query.scope),
        scopeId: firstQueryValue(query.scopeId),
        period: firstQueryValue(query.period),
        start: firstQueryValue(query.start),
        end: firstQueryValue(query.end),
      })
    : null

  return (
    <ReportLayout
      title={REPORT.title}
      scopeOptions={scopeOptions}
      periodKind={REPORT.periodKind}
      context={context}
      notice={notice}
      infoItems={result ? [{ label: "展示", value: `${result.storeCount} 家门店` }] : []}
    >
      {result && <DailyOverviewView result={result} />}
    </ReportLayout>
  )
}
