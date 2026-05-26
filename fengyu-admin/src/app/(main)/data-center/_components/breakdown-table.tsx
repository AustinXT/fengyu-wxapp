"use client"

import { DataTable, type Column } from "@/components/ui/data-table"
import { formatByUnit } from "@/lib/data-center/format"
import type { BreakdownRow, MetricUnit } from "@/lib/data-center/types"

export interface BreakdownColumn {
  key: string // 对应 BreakdownRow.metrics 的键
  label: string
  unit: MetricUnit
}

/**
 * 按市场/按门店明细表（泛化，4 板块复用）。
 * 第一列为分组名（市场/门店）；showMarket=true 时额外插入「所属市场」列（按门店分组用）。
 */
export function BreakdownTable({
  title,
  rows,
  columns,
  firstColLabel = "名称",
  showMarket = false,
  loading = false,
}: {
  title?: string
  rows: BreakdownRow[]
  columns: BreakdownColumn[]
  firstColLabel?: string
  showMarket?: boolean
  loading?: boolean
}) {
  const tableColumns: Column<BreakdownRow>[] = [
    {
      key: "groupName",
      header: firstColLabel,
      cell: (r) => <span className="font-medium">{r.groupName}</span>,
    },
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

  return (
    <div className="flex flex-col gap-2">
      {title && <h3 className="text-sm font-semibold text-[var(--foreground)]">{title}</h3>}
      <DataTable columns={tableColumns} data={rows} loading={loading} emptyText="暂无数据" />
    </div>
  )
}
