"use client"

import { useEffect, useState } from "react"
import { actionErrorMessage } from "@/lib/action-error"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseBoardParams } from "@/lib/data-center/params"
import type { SalesBoardResult } from "@/lib/data-center/types"
import { getSalesBoard } from "@/actions/data-center/sales"
import { KpiGrid, type KpiGridItem } from "../kpi-card"
import { BreakdownTable } from "../breakdown-table"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

/** KPI 卡片矩阵定义（key 对应后端 SalesBoardResult.kpis） */
const KPI_ITEMS: KpiGridItem[] = [
  { key: "storeRevenue", label: "总业绩" },
  { key: "shengmeiRevenue", label: "生美业绩" },
  { key: "storeConsume", label: "总实耗" },
  { key: "shengmeiConsume", label: "生美实耗" },
  { key: "newCustomerRevenue", label: "新增客业绩", hint: "新增会员业绩" },
  { key: "trafficCustomerRevenue", label: "流量客业绩", hint: "流量/体验/小美客" },
  { key: "revenuePerStore", label: "总业绩店均" },
  { key: "shengmeiRevenuePerStore", label: "生美业绩店均" },
  { key: "consumePerStore", label: "实耗店均" },
  { key: "storeCount", label: "门店数" },
  { key: "employeeCount", label: "员工数", hint: "美容师 + 养生师" },
]

export function SalesBoard() {
  const { searchParams } = useUrlFilters()
  const params = parseBoardParams(Object.fromEntries(searchParams.entries()))

  const [data, setData] = useState<SalesBoardResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // searchParams 变化（scope / 时间 / 同比环比开关）→ 重新拉取
  const depsKey = searchParams.toString()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getSalesBoard(params)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((e: unknown) => {
        // 生产构建会脱敏 throw 出来的 message（scope 解析失败等业务拦截理由都在 digest 里），issue #133
        if (!cancelled) setError(actionErrorMessage(e, "加载失败"))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // 仅依赖 URL 序列化结果（params 是每次渲染新对象，不可直接入依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey])

  if (error) {
    return (
      <Card className="p-6 text-sm text-[#D94040]">数据加载失败：{error}</Card>
    )
  }

  const kpis = data?.kpis ?? {}
  const label = data?.timeRange.presetLabel ?? ""

  return (
    <div className="flex flex-col gap-6">
      <KpiGrid items={KPI_ITEMS} kpis={kpis} columns={4} />
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
            exportFilename={`销售明细_按市场_${label}`}
            exportView="sales-market"
          />
        </TabsContent>
        <TabsContent value="store">
          <BreakdownTable
            rows={data?.byStore ?? []}
            loading={loading}
            exportFilename={`销售明细_按门店_${label}`}
            exportView="sales-store"
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
