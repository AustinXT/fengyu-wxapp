"use client"

import { DataTable, type Column } from "@/components/ui/data-table"
import { ExportButton } from "@/components/ui/export-button"
import {
  getDataCenterBreakdownConfig,
  type DataCenterBreakdownView,
} from "@/lib/data-center/columns"
import { formatByUnit } from "@/lib/data-center/format"
import type { BreakdownRow } from "@/lib/data-center/types"
import { useSearchParams } from "next/navigation"

/**
 * 按市场/按门店明细表（泛化，4 板块复用）。
 * 列布局由 data-center/columns.ts 按 exportView 统一提供，页面与异步导出不会漂移。
 */
export function BreakdownTable({
  title,
  rows,
  loading = false,
  exportFilename,
  exportView,
}: {
  title?: string
  rows: BreakdownRow[]
  loading?: boolean
  exportFilename?: string
  exportView: DataCenterBreakdownView
}) {
  const searchParams = useSearchParams()
  const config = getDataCenterBreakdownConfig(exportView)
  const tableColumns: Column<BreakdownRow>[] = [
    {
      key: "groupName",
      header: config.groupLabel,
      cell: (r) => <span className="font-medium">{r.groupName}</span>,
    },
    ...config.textColumns.map((column) => ({
      key: column.key,
      header: column.label,
      cell: (r: BreakdownRow) => column.source === "marketName"
        ? r.marketName ?? "—"
        : r.labels?.[column.key] ?? "—",
    })),
    ...config.metricColumns.map((column) => ({
      key: column.key,
      header: column.label,
      className: "text-right tabular-nums",
      cell: (r: BreakdownRow) => formatByUnit(r.metrics[column.key], column.unit),
    })),
  ]

  return (
    <div className="flex flex-col gap-2">
      {(title || exportFilename) && (
        <div className="flex items-center justify-between gap-2">
          {title ? (
            <h3 className="text-sm font-semibold text-[var(--foreground)]">{title}</h3>
          ) : (
            <span />
          )}
          {exportFilename && exportView && (
            <ExportButton
              disabled={loading}
              exportRequest={{
                exportType: "data-center",
                payload: {
                  view: exportView,
                  params: Object.fromEntries(searchParams.entries()),
                },
              }}
            />
          )}
        </div>
      )}
      <DataTable columns={tableColumns} data={rows} loading={loading} emptyText="暂无数据" />
    </div>
  )
}
