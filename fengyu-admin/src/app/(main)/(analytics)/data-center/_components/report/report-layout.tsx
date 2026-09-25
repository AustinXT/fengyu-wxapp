import type { ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import type { DataStartRangeResult } from "@/lib/data-center/data-start"
import type { ReportPageContext, ReportPeriodKind } from "@/lib/data-center/report-page"
import { scopeLabel, scopeStores } from "@/lib/data-center/scope-options"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"
import { DataStartNotice } from "../data-start-notice"
import { ScopeEmptyState } from "../scope-empty-state"
import { ReportFilter } from "./report-filter"
import { ReportInfoBar, type ReportInfoItem } from "./report-info-bar"

/**
 * 经营明细报表页骨架（#367）：标题 + 公共筛选器 + 数据起点提示 + 信息条 + 页面内容。
 * 结构与板块页（`[board]/page.tsx`）一致：h1 → 筛选卡片 → 内容；非总部无可查看范围 / 选中已停用门店时
 * 渲染同一个空态组件（ScopeEmptyState）。
 *
 * 信息条默认给出「范围 · 期间」，页面在 `infoItems` 里追加条数 / 合计等数据性标签。
 */
export function ReportLayout({
  title,
  scopeOptions,
  periodKind,
  context,
  notice = [],
  infoItems = [],
  children,
}: {
  title: string
  scopeOptions: DataCenterScopeOptions
  periodKind: ReportPeriodKind
  context: ReportPageContext
  notice?: readonly DataStartRangeResult[]
  infoItems?: readonly ReportInfoItem[]
  children: ReactNode
}) {
  const { period, scope } = context
  const baseItems: ReportInfoItem[] = scope
    ? [
        { label: "范围", value: `${scopeLabel(scopeOptions, scope)}（${scopeStores(scopeOptions, scope).length} 家门店）` },
        ...(period ? [{ label: "期间", value: `${period.label} ${period.current.start} ~ ${period.current.end}` }] : []),
      ]
    : []

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-[var(--foreground)]">{title}</h1>
      <ReportFilter
        scopeOptions={scopeOptions}
        periodKind={periodKind}
        period={period}
        defaultQuery={context.defaultQuery}
        today={context.today}
      />
      {!scope ? (
        <ScopeEmptyState inactiveStore={context.inactiveStore} defaultScopeHref={context.defaultScopeHref} />
      ) : (
        <>
          <DataStartNotice results={notice} />
          <ReportInfoBar items={[...baseItems, ...infoItems]} />
          {children}
        </>
      )}
    </div>
  )
}

/** 骨架阶段的页面内容占位：各页面单合入时替换为真实表格。 */
export function ReportPendingState() {
  return (
    <Card>
      <CardContent className="p-8 text-center text-sm text-[var(--muted-foreground)]">
        报表建设中，暂无数据
      </CardContent>
    </Card>
  )
}
