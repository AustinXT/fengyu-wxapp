import { getStaffCommissionScopeOptions } from "@/actions/data-center/shared"
import { getCommissionDetail } from "@/actions/data-center/commission"
import { DATA_CENTER_REPORTS } from "@/lib/data-center/reports"
import { formatAmount, formatCount } from "@/lib/data-center/format"
import { scopeStores } from "@/lib/data-center/scope-options"
import { prepareReport } from "../../_components/report/prepare-report"
import { ReportLayout } from "../../_components/report/report-layout"
import { CommissionDetailView } from "../_components/commission-detail-view"

export const dynamic = "force-dynamic"

const REPORT = DATA_CENTER_REPORTS.commissionDetail

/**
 * 提成明细（#375，从员工提成日报下钻，不进菜单）：UNION 销售分配（spia）与服务提成两张表，
 * keyset 分页 (日期 DESC, 来源类型, 来源表主键 DESC)。面包屑「数据中心 / 员工提成日报 / 提成明细」，
 * 中间一级经 returnTo 回到下钻前的日报筛选。
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
  const data = context.scope ? await getCommissionDetail(query) : null
  const stores = context.scope ? scopeStores(scopeOptions, context.scope) : []
  const employee = data?.filters.employeeId
    ? data.employeeOptions.find((option) => option.employeeId === data.filters.employeeId)?.label ?? data.filters.employeeId
    : "全部员工"
  const store = data?.filters.storeId
    ? stores.find((item) => item.storeId === data.filters.storeId)?.storeName ?? data.filters.storeId
    : "全部门店"

  return (
    <ReportLayout
      title={REPORT.title}
      scopeOptions={scopeOptions}
      periodKind={REPORT.periodKind}
      context={context}
      notice={notice}
      infoItems={data ? [
        { label: "员工", value: employee },
        { label: "门店", value: store },
        ...(data.filters.date ? [{ label: "日期", value: data.filters.date }] : []),
        { label: "明细", value: `${formatCount(data.summary.count)} 条` },
        { label: "分配金额合计", value: `¥${formatAmount(data.summary.allocated)}` },
        { label: "提成合计", value: `¥${formatAmount(data.summary.commission)}` },
        { label: "实收合计", value: `¥${formatAmount(data.summary.received)}` },
      ] : []}
    >
      {data && context.period && (
        <CommissionDetailView
          data={data}
          stores={stores}
          monthStart={context.period.current.start}
          monthEnd={context.period.current.end}
        />
      )}
    </ReportLayout>
  )
}
