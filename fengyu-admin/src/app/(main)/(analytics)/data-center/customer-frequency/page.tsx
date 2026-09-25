import { getCustomerDetailScopeOptions } from "@/actions/data-center/shared"
import { getCustomerFrequencyReport } from "@/actions/data-center/customer-frequency"
import { listMonthDays } from "@/lib/data-center/matrix"
import { firstQueryValue } from "@/lib/data-center/params"
import { DATA_CENTER_REPORTS } from "@/lib/data-center/reports"
import { prepareReport } from "../_components/report/prepare-report"
import { ReportLayout } from "../_components/report/report-layout"
import { CustomerFrequencyView } from "./_components/customer-frequency-view"

export const dynamic = "force-dynamic"

const REPORT = DATA_CENTER_REPORTS.customerFrequency

/**
 * 顾客频率表（#370，顾客 × 当月日历到店与消费）。
 * getCustomerDetailScopeOptions 兼任 SSR 权限闸门（见 DATA_CENTER_REPORTS.requiredActions）；
 * 取数 action getCustomerFrequencyReport 用同一组权限常量再校验一次。
 *
 * 数据起点只看服务轴：本页的核心是「到店」日历，月中上线的门店以服务单起点为准
 * （业绩轴的起点是各店第一笔销售，早于它的日子门店已在营业，只是没卖东西，不该报「数据不完整」）。
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
    axes: ["service"],
  })

  // 无可查看范围时不取数（ReportLayout 渲染空态）
  const report = context.scope
    ? await getCustomerFrequencyReport(
        Object.fromEntries(Object.keys(query).map((key) => [key, firstQueryValue(query[key])])),
      )
    : null

  const infoItems = report
    ? [
        { label: "天数", value: `${listMonthDays(report.month).length} 天` },
        {
          label: "顾客",
          value: report.filtered
            ? `筛出 ${report.total} 位（共 ${report.summary.customerCount} 位）`
            : `共 ${report.summary.customerCount} 位`,
        },
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
      {report && <CustomerFrequencyView report={report} />}
    </ReportLayout>
  )
}
