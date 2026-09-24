import { Card, CardContent } from "@/components/ui/card"
import { getDataCenterScopeOptions } from "@/actions/data-center/shared"
import { getOperatingMaster } from "@/actions/data-center/operating-master"
import { DATA_CENTER_REPORTS } from "@/lib/data-center/reports"
import {
  operatingMasterEmptyText,
  operatingMasterExportParams,
  ytdRange,
} from "@/lib/data-center/operating-master"
import { prepareReport } from "../_components/report/prepare-report"
import { ReportLayout } from "../_components/report/report-layout"
import { OperatingMasterTable } from "../_components/operating-master/operating-master-table"

export const dynamic = "force-dynamic"

const REPORT = DATA_CENTER_REPORTS.operatingMaster

/**
 * 经营数据主表（#372）。单月型筛选；行 = 权限内且在筛选范围内的在营门店。
 * getDataCenterScopeOptions 兼任 SSR 权限闸门（见 DATA_CENTER_REPORTS.requiredActions）。
 *
 * 数据起点提示：所选月份按业绩 + 服务两条轴；R 列年度累计（当年 1 月起）另按业绩轴提示——
 * 本期不接 WorkFine 历史单，2026 年内年度累计必然早于各市场上线日。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { scopeOptions, context, notice } = await prepareReport({
    report: REPORT,
    query: await searchParams,
    loadScopeOptions: getDataCenterScopeOptions,
    axes: ["performance", "service"],
    extraNotices: (period) =>
      period?.kind === "month"
        ? [{ label: "年度累计（R 列）", range: ytdRange(period.month), axes: ["performance"] }]
        : [],
  })

  const { scope, period } = context
  // scope 为 null（无可查看范围）时不取数，ReportLayout 渲染空态
  const data = scope && period?.kind === "month"
    ? await getOperatingMaster({ scope, month: period.month })
    : null
  const emptyText = data ? operatingMasterEmptyText(data) : null

  return (
    <ReportLayout
      title={REPORT.title}
      scopeOptions={scopeOptions}
      periodKind={REPORT.periodKind}
      context={context}
      notice={notice}
      periodLabel="统计月份"
      infoItems={data ? [{ label: "展示", value: `${data.storeCount} 行` }] : []}
    >
      {data && scope && (
        emptyText ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-[var(--muted-foreground)]">{emptyText}</CardContent>
          </Card>
        ) : (
          <OperatingMasterTable
            rows={data.rows}
            totals={data.totals}
            multiMarket={data.multiMarket}
            exportParams={operatingMasterExportParams(scope, data.month)}
          />
        )
      )}
    </ReportLayout>
  )
}
