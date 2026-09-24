"use client"

import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { actionErrorMessage } from "@/lib/action-error"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseBoardParams } from "@/lib/data-center/params"
import { getEfficiencyBoard } from "@/actions/data-center/efficiency"
import { KpiGrid, type KpiGridItem } from "../kpi-card"
import { BreakdownTable } from "../breakdown-table"
import { RankingBoard } from "../ranking-board"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { EfficiencyBoardResult } from "@/lib/data-center/types"

// ── KPI 卡片矩阵（key 对应 EfficiencyBoardResult.kpis）────────────────
const KPI_ITEMS: KpiGridItem[] = [
  { key: "empAvgRevenue", label: "员工人均业绩" },
  { key: "empAvgConsume", label: "员工人均实耗" },
  { key: "empAvgIncome", label: "员工人均收入", hint: "销售提成 + 服务提成" },
  { key: "empAvgMembers", label: "人均会员量", hint: "有效到店 ÷ 员工" },
  { key: "empAvgProjects", label: "人均项目数", hint: "生美项目 ÷ 员工" },
  { key: "managerAvgMembers", label: "店长人均会员数", hint: "会员数 ÷ 店长数" },
  { key: "managerAvgEmployees", label: "店长人均员工数", hint: "员工数 ÷ 店长数" },
]

export function EfficiencyBoard() {
  const { searchParams } = useUrlFilters()
  const [data, setData] = useState<EfficiencyBoardResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // searchParams.toString() 作为依赖：scope/时间/同比环比 任一变化即重新取数
  const qs = searchParams.toString()

  useEffect(() => {
    const raw = Object.fromEntries(new URLSearchParams(qs).entries())
    const params = parseBoardParams(raw)
    let cancelled = false
    setLoading(true)
    setError(null)
    getEfficiencyBoard(params)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((e: unknown) => {
        // 生产构建会脱敏 message，必须走 actionErrorMessage 取 digest（issue #133）；
        // validateScope 的 4 条拒绝理由为何到不了这里，见 lib/data-center/context.ts 的说明。
        if (!cancelled) setError(actionErrorMessage(e, "请稍后重试"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [qs])

  if (error) {
    return <Card className="p-6 text-sm text-[#D94040]">加载失败：{error}</Card>
  }

  const kpis = data?.kpis ?? {}
  const label = data?.timeRange.presetLabel ?? ""

  return (
    <div className="flex flex-col gap-6">
      {/* 人均派生 KPI */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">人均效能</h2>
        <KpiGrid items={KPI_ITEMS} kpis={kpis} columns={4} baseRanges={loading ? undefined : data?.timeRange} />
      </section>

      {/* 明细 + 排名榜分 Tab（排名榜跟随顶部时间维度，不算同比环比）*/}
      <Tabs defaultValue="detail">
        <TabsList>
          <TabsTrigger value="detail">按市场人效</TabsTrigger>
          <TabsTrigger value="staff-detail">按技师人效</TabsTrigger>
          <TabsTrigger value="store-rank">门店排名榜</TabsTrigger>
          <TabsTrigger value="staff-rank">员工排名榜</TabsTrigger>
        </TabsList>
        <TabsContent value="detail">
          <BreakdownTable
            rows={data?.byMarket ?? []}
            loading={loading}
            exportFilename={`人效明细_按市场_${label}`}
            exportView="efficiency-market"
          />
        </TabsContent>
        <TabsContent value="staff-detail">
          <BreakdownTable
            rows={data?.byStaff ?? []}
            loading={loading}
            exportFilename={`人效明细_按技师_${label}`}
            exportView="efficiency-staff"
          />
        </TabsContent>
        <TabsContent value="store-rank">
          <RankingBoard
            title="门店排名榜"
            rankings={data?.storeRankings ?? {}}
            showMarket
            loading={loading}
            exportFilenamePrefix={`人效_门店排名榜_${label}`}
            exportView="efficiency-store-ranking"
          />
        </TabsContent>
        <TabsContent value="staff-rank">
          <RankingBoard
            title="员工排名榜"
            rankings={data?.staffRankings ?? {}}
            showMarket
            loading={loading}
            exportFilenamePrefix={`人效_员工排名榜_${label}`}
            exportView="efficiency-staff-ranking"
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
