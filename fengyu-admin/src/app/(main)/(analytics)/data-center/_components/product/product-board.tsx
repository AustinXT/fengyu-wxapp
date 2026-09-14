"use client"

import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { Select, SelectOption } from "@/components/ui/select"
import { actionErrorMessage } from "@/lib/action-error"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseBoardParams } from "@/lib/data-center/params"
import { getProductBoard } from "@/actions/data-center/product"
import { KpiGrid, type KpiGridItem } from "../kpi-card"
import { BreakdownTable } from "../breakdown-table"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { ProductBoardParams, ProductBoardResult } from "@/lib/data-center/types"

// ── KPI 卡片矩阵（key 对应后端 ProductBoardResult.kpis）────────────────
const KPI_CARD: KpiGridItem[] = [
  { key: "cardHolders", label: "持卡人数", hint: "以当前时刻未用完疗程卡为准，不随时间区间变化" },
  { key: "cardHolderRate", label: "持卡占比", hint: "持卡人数 ÷ 会员数（以当前时刻未用完疗程卡为准）" },
]
const KPI_CYCLE: KpiGridItem[] = [
  { key: "trialCount", label: "体验人数", hint: "区间内有购买但全历史未达标" },
  { key: "newCount", label: "品项进入人数", hint: "首次达标日落在区间内" },
  { key: "newRevenue", label: "进入业绩" },
  { key: "newAvgTicket", label: "进入客单价" },
  { key: "repurchaseCount", label: "复购人数", hint: "进入后的后续达标购买" },
  { key: "repurchaseRevenue", label: "复购业绩" },
  { key: "repurchaseAvgTicket", label: "复购客单价" },
  { key: "repurchaseRate", label: "复购率", hint: "复购人数 ÷ 品项进入人数" },
]

export function ProductBoard() {
  const { get, setMany, searchParams } = useUrlFilters()
  const [data, setData] = useState<ProductBoardResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // scope/时间/同比环比 + 一级(kind)/二级(category) 任一变化即重新取数
  const qs = searchParams.toString()
  const kind = get("kind")
  const category = get("category")

  useEffect(() => {
    const raw = Object.fromEntries(new URLSearchParams(qs).entries())
    const base = parseBoardParams(raw)
    const params: ProductBoardParams = {
      ...base,
      productKind: raw.kind || undefined,
      categoryName: raw.category || undefined,
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    getProductBoard(params)
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

  const filterOptions = data?.filterOptions ?? []
  // 二级选项跟随当前一级（kind）；未选一级时无二级可选
  const secondLevel = filterOptions.find((o) => o.kind === kind)?.categories ?? []

  if (error) {
    return <Card className="p-6 text-sm text-[#D94040]">数据加载失败：{error}</Card>
  }

  const kpis = data?.kpis ?? {}
  const label = data?.timeRange.presetLabel ?? ""

  return (
    <div className="flex flex-col gap-6">
      {/* 品项筛选器：一级 kind → 二级 category（切一级清二级）*/}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">一级品项</span>
          <Select
            className="w-40"
            value={kind}
            onChange={(e) => setMany({ kind: e.target.value, category: "" })}
          >
            <SelectOption value="">全部品项</SelectOption>
            {filterOptions.map((o) => (
              <SelectOption key={o.kind} value={o.kind}>
                {o.kind}
              </SelectOption>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--muted-foreground)]">二级品项</span>
          <Select
            className="w-48"
            value={category}
            disabled={!kind}
            onChange={(e) => setMany({ category: e.target.value })}
          >
            <SelectOption value="">{kind ? "全部二级" : "请先选一级"}</SelectOption>
            {secondLevel.map((c) => (
              <SelectOption key={c} value={c}>
                {c}
              </SelectOption>
            ))}
          </Select>
        </div>
      </div>

      {/* KPI：持卡（截面）*/}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">持卡情况</h2>
        <div className="text-xs text-[var(--muted-foreground)]">
          持卡人数 / 占比为截面快照（以当前时刻未用完疗程卡为准），不随时间区间变化。
        </div>
        <KpiGrid items={KPI_CARD} kpis={kpis} columns={2} />
      </section>

      {/* KPI：体验 / 进入 / 复购（区间）*/}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">体验 / 进入 / 复购</h2>
        <KpiGrid items={KPI_CYCLE} kpis={kpis} columns={4} />
      </section>

      {/* 明细表分 Tab：按市场 / 按门店 */}
      <Tabs defaultValue="market">
        <TabsList>
          <TabsTrigger value="market">按市场</TabsTrigger>
          <TabsTrigger value="store">按门店</TabsTrigger>
        </TabsList>
        <TabsContent value="market">
          <BreakdownTable
            rows={data?.byMarket ?? []}
            loading={loading}
            exportFilename={`品项明细_按市场_${label}`}
            exportView="product-market"
          />
        </TabsContent>
        <TabsContent value="store">
          <BreakdownTable
            rows={data?.byStore ?? []}
            loading={loading}
            exportFilename={`品项明细_按门店_${label}`}
            exportView="product-store"
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
