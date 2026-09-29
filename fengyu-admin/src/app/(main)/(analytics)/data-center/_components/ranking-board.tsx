"use client"

import { Card } from "@/components/ui/card"
import { DataTable, type Column } from "@/components/ui/data-table"
import { ExportButton } from "@/components/ui/export-button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  getDataCenterRankingConfig,
  type DataCenterRankingView,
} from "@/lib/data-center/columns"
import { formatByUnit } from "@/lib/data-center/format"
import type { RankingRow, MetricUnit } from "@/lib/data-center/types"
import { useSearchParams } from "next/navigation"

/**
 * 排名榜（泛化）：顶部 metric 切换 Tab（组件内部状态，非 URL），下方排名表。
 * 门店榜 / 员工榜共用；showMarket 控制是否展示「所属市场」列；note 是标题下的口径说明，
 * 只由需要的榜单传入（员工榜传 #299 全域说明，门店榜不传）。
 * 排名指标由 data-center/columns.ts 按 exportView 统一提供。
 */
export function RankingBoard({
  title,
  rankings,
  showMarket = true,
  loading = false,
  exportFilenamePrefix,
  exportView,
  note,
}: {
  title: string
  rankings: Record<string, RankingRow[]>
  showMarket?: boolean
  loading?: boolean
  exportFilenamePrefix?: string
  exportView: DataCenterRankingView
  note?: string
}) {
  const searchParams = useSearchParams()
  const { metrics } = getDataCenterRankingConfig(exportView)
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
      {note && (
        <p className="text-xs text-[var(--muted-foreground)]" data-testid="ranking-board-note">
          {note}
        </p>
      )}
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
