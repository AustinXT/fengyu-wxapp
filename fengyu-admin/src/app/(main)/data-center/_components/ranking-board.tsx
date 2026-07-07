"use client"

import { Card } from "@/components/ui/card"
import { DataTable, type Column } from "@/components/ui/data-table"
import { ExportButton } from "@/components/ui/export-button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { formatByUnit } from "@/lib/data-center/format"
import { exportToXlsx, type ExportColumn } from "@/lib/export-xlsx"
import { headerWithUnit, metricCell } from "@/lib/data-center/export"
import type { RankingRow, MetricUnit } from "@/lib/data-center/types"

export interface RankingMetric {
  key: string 
  label: string
  unit: MetricUnit
}


export function RankingBoard({
  title,
  rankings,
  metrics,
  showMarket = true,
  loading = false,
  exportFilenamePrefix,
}: {
  title: string
  rankings: Record<string, RankingRow[]>
  metrics: RankingMetric[]
  showMarket?: boolean
  loading?: boolean
  exportFilenamePrefix?: string
}) {
  if (metrics.length === 0) return null

  async function exportMetric(m: RankingMetric) {
    if (!exportFilenamePrefix) return
    const exportColumns: ExportColumn<RankingRow>[] = [
      { header: "排名", width: 8, accessor: (r) => r.rank },
      { header: "名称", width: 20, accessor: (r) => r.name },
      ...(showMarket
        ? [{ header: "所属市场", width: 16, accessor: (r: RankingRow) => r.marketName ?? "" }]
        : []),
      {
        header: headerWithUnit(m.label, m.unit),
        accessor: (r: RankingRow) => metricCell(r.value, m.unit),
      },
    ]
    await exportToXlsx({
      filename: `${exportFilenamePrefix}_${m.label}`,
      sheetName: m.label,
      columns: exportColumns,
      rows: rankings[m.key] ?? [],
    })
  }

  const columnsFor = (unit: MetricUnit): Column<RankingRow>[] => [
    { key: "rank", header: "排名", className: "w-16", cell: (r) => `#${r.rank}` },
    { key: "name", header: "名称", cell: (r) => <span className="font-medium">{r.name}</span> },
    ...(showMarket
      ? [{ key: "marketName", header: "所属市场", cell: (r: RankingRow) => r.marketName ?? "—" }]
      : []),
    {
      key: "value",
      header: "数值",
      className: "text-right tabular-nums",
      cell: (r: RankingRow) => formatByUnit(r.value, unit),
    },
  ]

  return (
    <Card className="p-4 flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <Tabs defaultValue={metrics[0].key}>
        <TabsList>
          {metrics.map((m) => (
            <TabsTrigger key={m.key} value={m.key}>
              {m.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {metrics.map((m) => (
          <TabsContent key={m.key} value={m.key}>
            <div className="flex flex-col gap-2">
              {exportFilenamePrefix && (
                <div className="flex justify-end">
                  <ExportButton
                    onExport={() => exportMetric(m)}
                    disabled={loading || (rankings[m.key]?.length ?? 0) === 0}
                  />
                </div>
              )}
              <DataTable
                columns={columnsFor(m.unit)}
                data={rankings[m.key] ?? []}
                loading={loading}
                emptyText="暂无排名数据"
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </Card>
  )
}
