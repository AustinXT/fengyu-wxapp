import { getStaffCommissionScopeOptions } from "@/actions/data-center/shared"
import { getCommissionDaily } from "@/actions/data-center/commission"
import { DATA_CENTER_REPORTS } from "@/lib/data-center/reports"
import { formatAmount, formatCount } from "@/lib/data-center/format"
import { prepareReport } from "../_components/report/prepare-report"
import { ReportLayout } from "../_components/report/report-layout"
import { CommissionDailyView } from "./_components/commission-daily-view"

export const dynamic = "force-dynamic"

const REPORT = DATA_CENTER_REPORTS.commissionDaily

/**
 * 员工提成日报（#375）：行 = 员工 × 单据门店，列 = 所选月份每日，格 = 当日提成。
 * 业绩提成按款项归属日期、消耗提成按服务日期（数据起点提示按这两条轴判定）。
 * getStaffCommissionScopeOptions 兼任 SSR 权限闸门（见 DATA_CENTER_REPORTS.requiredActions）。
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
    loadScopeOptions: getStaffCommissionScopeOptions,
    axes: ["performance", "service"],
  })
  // scope 为 null = 无可查看范围，不取数（ReportLayout 渲染空态）
  const data = context.scope ? await getCommissionDaily(query) : null

  return (
    <ReportLayout
      title={REPORT.title}
      scopeOptions={scopeOptions}
      periodKind={REPORT.periodKind}
      context={context}
      notice={notice}
      infoItems={data ? [
        { label: "提成合计", value: `¥${formatAmount(data.kpis.total)}` },
        { label: "订单", value: `${formatCount(data.kpis.orders)} 单` },
      ] : []}
    >
      {data && <CommissionDailyView data={data} today={context.today} />}
    </ReportLayout>
  )
}
