"use client"

import { useEffect, useState } from "react"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseBoardParams } from "@/lib/data-center/params"
import type { SalesBoardResult } from "@/lib/data-center/types"
import { getSalesBoard } from "@/actions/data-center/sales"
import { KpiGrid, type KpiGridItem } from "../kpi-card"
import { BreakdownTable, type BreakdownColumn } from "../breakdown-table"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"


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


const MARKET_COLUMNS: BreakdownColumn[] = [
  { key: "storeCount", label: "门店数", unit: "count" },
  { key: "technicianCount", label: "技师人数", unit: "count" },
  { key: "storeRevenue", label: "总业绩", unit: "amount" },
  { key: "shengmeiRevenue", label: "生美业绩", unit: "amount" },
  { key: "revenuePerStore", label: "业绩店均", unit: "amount" },
  { key: "shengmeiRevenuePerStore", label: "生美店均", unit: "amount" },
  { key: "newCustomerRevenue", label: "新增客业绩", unit: "amount" },
  { key: "trafficCustomerRevenue", label: "流量客业绩", unit: "amount" },
  { key: "storeConsume", label: "总实耗", unit: "amount" },
  { key: "shengmeiConsume", label: "生美实耗", unit: "amount" },
  { key: "consumePerStore", label: "实耗店均", unit: "amount" },
  { key: "shengmeiConsumePerStore", label: "生美实耗店均", unit: "amount" },
]


const STORE_COLUMNS: BreakdownColumn[] = [
  { key: "technicianCount", label: "技师人数", unit: "count" },
  { key: "storeRevenue", label: "总业绩", unit: "amount" },
  { key: "shengmeiRevenue", label: "生美业绩", unit: "amount" },
  { key: "newCustomerRevenue", label: "新增客业绩", unit: "amount" },
  { key: "trafficCustomerRevenue", label: "流量客业绩", unit: "amount" },
  { key: "storeConsume", label: "总实耗", unit: "amount" },
  { key: "shengmeiConsume", label: "生美实耗", unit: "amount" },
]

export function SalesBoard() {
  const { searchParams } = useUrlFilters()
  const params = parseBoardParams(Object.fromEntries(searchParams.entries()))

  const [data, setData] = useState<SalesBoardResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  
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
        if (!cancelled) setError(e instanceof Error ? e.message : "加载失败")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    
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
      {}
      <Tabs defaultValue="market">
        <TabsList>
          <TabsTrigger value="market">按市场</TabsTrigger>
          <TabsTrigger value="store">按门店</TabsTrigger>
        </TabsList>
        <TabsContent value="market">
          <BreakdownTable
            rows={data?.byMarket ?? []}
            columns={MARKET_COLUMNS}
            firstColLabel="市场"
            loading={loading}
            exportFilename={`销售明细_按市场_${label}`}
            exportSheetName="销售明细_按市场"
          />
        </TabsContent>
        <TabsContent value="store">
          <BreakdownTable
            rows={data?.byStore ?? []}
            columns={STORE_COLUMNS}
            firstColLabel="门店"
            showMarket
            loading={loading}
            exportFilename={`销售明细_按门店_${label}`}
            exportSheetName="销售明细_按门店"
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
