"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { ExportButton } from "@/components/ui/export-button"
import { cn } from "@/lib/utils"
import type { DailyOverviewKpiKey, DailyOverviewResult } from "@/actions/data-center/daily-overview"
import {
  DAILY_OVERVIEW_TABS,
  DAILY_OVERVIEW_TAB_LABELS,
  DEFAULT_DAILY_OVERVIEW_TAB,
  buildDailyOverviewColumns,
  parseDailyOverviewTab,
  type DailyOverviewColumn,
  type DailyOverviewRow,
  type DailyOverviewTab,
} from "@/lib/data-center/daily-overview"
import { sortMatrixRows, type MatrixSort } from "@/lib/data-center/matrix"
import { DAILY_OVERVIEW_EXPORT_VIEW } from "@/lib/export-job-types"
import { KpiCard } from "../../_components/kpi-card"
import { MatrixTable, type MatrixColumn } from "../../_components/matrix-table"

type ViewColumn = MatrixColumn<DailyOverviewRow> & Pick<DailyOverviewColumn, "text">

const KPI_ITEMS: Array<{ key: DailyOverviewKpiKey; label: string }> = [
  { key: "performanceTotal", label: "销售业绩合计（元）" },
  { key: "serviceTotal", label: "服务业绩合计（元）" },
  { key: "selfShare", label: "自销自耗业绩占比" },
  { key: "ecoShare", label: "生态合作业绩占比" },
  { key: "averagePerStore", label: "平均单店业绩（元）" },
]

/**
 * 日常数据一览表的页面主体（#369）：指标卡 + 三视角页签 + 矩阵表 + 导出。
 *
 * 三视角共用同一份服务端数据，切换页签不重新取数：`tab` 用 history.replaceState 写回 URL
 * （Next 会同步给 useSearchParams），刷新 / 分享链接仍停在当前视角，导出也带上它（☆ 默认只导当前页签）。
 */
export function DailyOverviewView({ result }: { result: DailyOverviewResult }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const tab = parseDailyOverviewTab(searchParams.get("tab"))
  const [sort, setSort] = React.useState<MatrixSort | null>(null)

  const switchTab = (next: DailyOverviewTab) => {
    const params = new URLSearchParams(searchParams.toString())
    if (next === DEFAULT_DAILY_OVERVIEW_TAB) params.delete("tab")
    else params.set("tab", next)
    const qs = params.toString()
    window.history.replaceState(null, "", `${pathname}${qs ? `?${qs}` : ""}`)
    setSort(null)
  }

  const { data } = result
  const columns: ViewColumn[] = React.useMemo(
    () =>
      buildDailyOverviewColumns(tab, data).map((column) => ({
        ...column,
        align: column.text ? "left" : "right",
        sortable: true,
        cell: column.text
          ? (row: DailyOverviewRow) => (column.text === "store" ? row.storeName : row.marketName)
          : undefined,
      })),
    [tab, data],
  )

  const rows = React.useMemo(() => {
    if (!sort) return data.rows
    const column = columns.find((item) => item.key === sort.key)
    if (!column) return data.rows
    const sortValue = (row: DailyOverviewRow) =>
      column.text === "store" ? row.storeName : column.text === "market" ? row.marketName : column.value?.(row)
    return sortMatrixRows(data.rows, sortValue, sort.direction, (row) => row.storeId)
  }, [columns, data.rows, sort])

  const exportParams = Object.fromEntries(searchParams.entries())

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {KPI_ITEMS.map((item) => (
          <KpiCard
            key={item.key}
            label={item.label}
            cell={result.kpis[item.key]}
            momLabel="较上期"
            baseRanges={item.key === "performanceTotal" || item.key === "serviceTotal"
              ? { previous: result.period.previous, lastYear: null }
              : undefined}
            hint={item.key === "averagePerStore" ? `${result.storeCount} 家门店` : undefined}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="统计视角" className="inline-flex rounded-[var(--radius-md)] border border-[var(--border)] p-0.5">
          {DAILY_OVERVIEW_TABS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={item === tab}
              onClick={() => switchTab(item)}
              className={cn(
                "rounded-[var(--radius-sm)] px-3 py-1.5 text-sm",
                item === tab
                  ? "bg-[var(--color-brand)] text-white"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
              )}
            >
              {DAILY_OVERVIEW_TAB_LABELS[item]}
            </button>
          ))}
        </div>
        <ExportButton
          label="导出当前页签"
          exportRequest={{
            exportType: "data-center",
            payload: { view: DAILY_OVERVIEW_EXPORT_VIEW, params: exportParams },
          }}
        />
      </div>

      <MatrixTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.storeId}
        totals={{ label: "合计", values: data.totals }}
        sort={sort}
        onSortChange={setSort}
        maxHeight={640}
        emptyText="当前范围内没有门店"
      />
    </div>
  )
}
