"use client"

import { Card } from "@/components/ui/card"
import { DataTable, type Column } from "@/components/ui/data-table"
import { ExportButton } from "@/components/ui/export-button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { formatByUnit } from "@/lib/data-center/format"
import type { RankingRow, MetricUnit } from "@/lib/data-center/types"
import type { DataCenterExportView } from "@/lib/export-job-types"
import { useSearchParams } from "next/navigation"

export interface RankingMetric {
  key: string // 对应 rankings 的键
  label: string
  unit: MetricUnit
}

/**
 * 排名榜（泛化）：顶部 metric 切换 Tab（组件内部状态，非 URL），下方排名表。
 * 门店榜 / 员工榜共用；showMarket 控制是否展示「所属市场」列。
 * 传入 exportFilenamePrefix 时，每个 metric 表上方显示导出按钮（导出该 metric 排名）。
 */
export function RankingBoard({
  title,
  rankings,
  metrics,
  showMarket = true,
  loading = false,
  exportFilenamePrefix,
  exportView,
}: {
  title: string
  rankings: Record<string, RankingRow[]>
  metrics: RankingMetric[]
  showMarket?: boolean
  loading?: boolean
  exportFilenamePrefix?: string
  exportView?: Extract<DataCenterExportView, 'efficiency-store-ranking' | 'efficiency-staff-ranking'>
}) {
  const searchParams = useSearchParams()
  if (metrics.length === 0) return null

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
              {exportFilenamePrefix && exportView && (
                <div className="flex justify-end">
                  <ExportButton
                    disabled={loading}
                    exportRequest={{
                      exportType: "data-center",
                      payload: {
                        view: exportView,
                        metric: m.key,
                        params: Object.fromEntries(searchParams.entries()),
                      },
                    }}
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
