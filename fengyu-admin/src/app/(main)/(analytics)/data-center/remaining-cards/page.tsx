import { getCustomerDetailScopeOptions } from "@/actions/data-center/shared"
import { DATA_CENTER_REPORTS } from "@/lib/data-center/reports"
import { prepareReport } from "../_components/report/prepare-report"
import { ReportLayout, ReportPendingState } from "../_components/report/report-layout"

export const dynamic = "force-dynamic"

const REPORT = DATA_CENTER_REPORTS.remainingCards

/**
 * 顾客剩余卡项清单（当前快照，不设日期）。
 * 骨架（#367）：筛选器 + 数据起点提示 + 信息条 + 空态；页面内容由 #371 实现。
 * getCustomerDetailScopeOptions 兼任 SSR 权限闸门（见 DATA_CENTER_REPORTS.requiredActions）。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { scopeOptions, context, notice } = await prepareReport({
    report: REPORT,
    query: await searchParams,
    loadScopeOptions: getCustomerDetailScopeOptions,
    axes: [],
  })

  return (
    <ReportLayout
      title={REPORT.title}
      scopeOptions={scopeOptions}
      periodKind={REPORT.periodKind}
      context={context}
      notice={notice}
    >
      <ReportPendingState />
    </ReportLayout>
  )
}
