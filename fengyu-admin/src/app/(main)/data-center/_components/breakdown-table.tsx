"use client"

import { DataTable, type Column } from "@/components/ui/data-table"
import { ExportButton } from "@/components/ui/export-button"
import { formatByUnit } from "@/lib/data-center/format"
import { exportToXlsx, type ExportColumn } from "@/lib/export-xlsx"
import { headerWithUnit, metricCell } from "@/lib/data-center/export"
import type { BreakdownRow, MetricUnit } from "@/lib/data-center/types"

export interface BreakdownColumn {
  key: string // 对应 BreakdownRow.metrics 的键
  label: string
  unit: MetricUnit
}

/**
 * 按市场/按门店明细表（泛化，4 板块复用）。
 * 第一列为分组名（市场/门店）；showMarket=true 时额外插入「所属市场」列（按门店分组用）。
 * textColumns：分组名之后插入的额外文本列（取 row.labels[key]，如按技师明细的门店/职级）。
 * 传入 exportFilename 时，标题行右侧显示导出按钮（导出当前 rows，原始数值）。
 */
export function BreakdownTable({
  title,
  rows,
  columns,
  firstColLabel = "名称",
  showMarket = false,
  textColumns = [],
  loading = false,
  exportFilename,
  exportSheetName = "明细",
}: {
  title?: string
  rows: BreakdownRow[]
  columns: BreakdownColumn[]
  firstColLabel?: string
  showMarket?: boolean
  textColumns?: { key: string; label: string }[]
  loading?: boolean
  exportFilename?: string
  exportSheetName?: string
}) {
  const tableColumns: Column<BreakdownRow>[] = [
    {
      key: "groupName",
      header: firstColLabel,
      cell: (r) => <span className="font-medium">{r.groupName}</span>,
    },
    ...textColumns.map((t) => ({
      key: t.key,
      header: t.label,
      cell: (r: BreakdownRow) => r.labels?.[t.key] ?? "—",
    })),
    ...(showMarket
      ? [{ key: "marketName", header: "所属市场", cell: (r: BreakdownRow) => r.marketName ?? "—" }]
      : []),
    ...columns.map((c) => ({
      key: c.key,
      header: c.label,
      className: "text-right tabular-nums",
      cell: (r: BreakdownRow) => formatByUnit(r.metrics[c.key], c.unit),
    })),
  ]

  async function handleExport() {
    if (!exportFilename) return
    const exportColumns: ExportColumn<BreakdownRow>[] = [
      { header: firstColLabel, width: 18, accessor: (r) => r.groupName },
      ...textColumns.map((t) => ({
        header: t.label,
        width: 14,
        accessor: (r: BreakdownRow) => r.labels?.[t.key] ?? "",
      })),
      ...(showMarket
        ? [{ header: "所属市场", width: 16, accessor: (r: BreakdownRow) => r.marketName ?? "" }]
        : []),
      ...columns.map((c) => ({
        header: headerWithUnit(c.label, c.unit),
        accessor: (r: BreakdownRow) => metricCell(r.metrics[c.key], c.unit),
      })),
    ]
    await exportToXlsx({
      filename: exportFilename,
      sheetName: exportSheetName,
      columns: exportColumns,
      rows,
    })
  }

  return (
    <div className="flex flex-col gap-2">
      {(title || exportFilename) && (
        <div className="flex items-center justify-between gap-2">
          {title ? (
            <h3 className="text-sm font-semibold text-[var(--foreground)]">{title}</h3>
          ) : (
            <span />
          )}
          {exportFilename && (
            <ExportButton onExport={handleExport} disabled={loading || rows.length === 0} />
          )}
        </div>
      )}
      <DataTable columns={tableColumns} data={rows} loading={loading} emptyText="暂无数据" />
    </div>
  )
}
