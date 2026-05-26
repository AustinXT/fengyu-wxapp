"use client"

import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseBoardParams } from "@/lib/data-center/params"
import { getEfficiencyBoard } from "@/actions/data-center/efficiency"
import { KpiGrid, type KpiGridItem } from "../kpi-card"
import { BreakdownTable, type BreakdownColumn } from "../breakdown-table"
import { RankingBoard, type RankingMetric } from "../ranking-board"
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

// ── 按市场人效明细列（key 对应 byMarket[].metrics）────────────────────
const MARKET_COLUMNS: BreakdownColumn[] = [
  { key: "managerCount", label: "店长人数", unit: "count" },
  { key: "managerAvgIncome", label: "店长人均收入", unit: "amount" },
  { key: "technicianCount", label: "技师人数", unit: "count" },
  { key: "techAvgRevenue", label: "技师人均业绩", unit: "amount" },
  { key: "techAvgConsume", label: "技师人均实耗", unit: "amount" },
  { key: "techAvgShengmeiConsume", label: "技师人均生美实耗", unit: "amount" },
  { key: "techAvgIncome", label: "技师人均收入", unit: "amount" },
  { key: "techAvgMembers", label: "技师人均会员量", unit: "count" },
  { key: "techAvgProjects", label: "技师人均项目数", unit: "count" },
]

// ── 门店排名榜 metric（key 对应 storeRankings）────────────────────────
const STORE_RANK_METRICS: RankingMetric[] = [
  { key: "revenue", label: "业绩", unit: "amount" },
  { key: "consume", label: "实耗", unit: "amount" },
  { key: "retainedMember", label: "保有会员", unit: "count" },
  { key: "newMember", label: "新会员", unit: "count" },
  { key: "projectCount", label: "项目数", unit: "count" },
]

// ── 员工排名榜 metric（key 对应 staffRankings）────────────────────────
const STAFF_RANK_METRICS: RankingMetric[] = [
  { key: "revenue", label: "业绩", unit: "amount" },
  { key: "consume", label: "实耗", unit: "amount" },
  { key: "newMember", label: "新会员", unit: "count" },
  { key: "projectCount", label: "项目数", unit: "count" },
  { key: "income", label: "收入", unit: "amount" },
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
        if (!cancelled) setError(e instanceof Error ? e.message : "加载失败")
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

  return (
    <div className="flex flex-col gap-6">
      {/* 人均派生 KPI */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">人均效能</h2>
        <KpiGrid items={KPI_ITEMS} kpis={kpis} columns={4} />
      </section>

      {/* 明细 + 排名榜分 Tab（排名榜跟随顶部时间维度，不算同比环比）*/}
      <Tabs defaultValue="detail">
        <TabsList>
          <TabsTrigger value="detail">按市场人效</TabsTrigger>
          <TabsTrigger value="store-rank">门店排名榜</TabsTrigger>
          <TabsTrigger value="staff-rank">员工排名榜</TabsTrigger>
        </TabsList>
        <TabsContent value="detail">
          <BreakdownTable
            rows={data?.byMarket ?? []}
            columns={MARKET_COLUMNS}
            firstColLabel="市场"
            loading={loading}
          />
        </TabsContent>
        <TabsContent value="store-rank">
          <RankingBoard
            title="门店排名榜"
            rankings={data?.storeRankings ?? {}}
            metrics={STORE_RANK_METRICS}
            showMarket
            loading={loading}
          />
        </TabsContent>
        <TabsContent value="staff-rank">
          <RankingBoard
            title="员工排名榜"
            rankings={data?.staffRankings ?? {}}
            metrics={STAFF_RANK_METRICS}
            showMarket
            loading={loading}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
