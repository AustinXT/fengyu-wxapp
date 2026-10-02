import { getCustomerDetailScopeOptions } from "@/actions/data-center/shared"
import { getRemainingCardsReport } from "@/actions/data-center/remaining-cards"
import { firstQueryValue } from "@/lib/data-center/params"
import { DATA_CENTER_REPORTS } from "@/lib/data-center/reports"
import { prepareReport } from "../_components/report/prepare-report"
import { ReportLayout } from "../_components/report/report-layout"
import { RemainingCardsView } from "./_components/remaining-cards-view"

export const dynamic = "force-dynamic"

const REPORT = DATA_CENTER_REPORTS.remainingCards

/**
 * 顾客剩余卡项清单（#371，当前快照，不设日期）。
 * getCustomerDetailScopeOptions 兼任 SSR 权限闸门（见 DATA_CENTER_REPORTS.requiredActions）；
 * 取数 action getRemainingCardsReport 用同一组权限常量再校验一次。
 * 按卡的权益门店归属 scope；不查数据起点（本页不按时间轴取数，axes 为空）。
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
    loadScopeOptions: getCustomerDetailScopeOptions,
    axes: [],
  })

  // 无可查看范围时不取数（ReportLayout 渲染空态）
  const report = context.scope
    ? await getRemainingCardsReport(
        Object.fromEntries(Object.keys(query).map((key) => [key, firstQueryValue(query[key])])),
      )
    : null

  const summary = report?.summary
  const infoItems = report && summary
    ? [
        {
          label: "顾客",
          value: report.filtered
            ? `筛出 ${report.filteredCustomerCount} 位（共 ${summary.customerCount} 位）`
            : `${summary.customerCount} 位`,
        },
        { label: "品项", value: `一级 ${summary.kindCount} / 二级 ${summary.categoryCount}` },
        { label: "有余额品项", value: `${summary.remainingCells} 项次` },
        { label: "待服务剩余", value: `${summary.remainingSessions} 次` },
        { label: "快照", value: report.asOf },
      ]
    : []

  return (
    <ReportLayout
      title={REPORT.title}
      scopeOptions={scopeOptions}
      periodKind={REPORT.periodKind}
      context={context}
      notice={notice}
      infoItems={infoItems}
    >
      {report && <RemainingCardsView report={report} />}
    </ReportLayout>
  )
}
