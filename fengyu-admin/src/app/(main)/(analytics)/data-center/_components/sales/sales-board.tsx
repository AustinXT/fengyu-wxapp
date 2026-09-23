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
  // 生美业绩与生美实耗的标记分别来自 sale_items / service_items 两张表（#294 AC5：
  // 存量有 23 行 is_shengmei 为 NULL、父子标记 4 行不一致，口径来源在 hint 里标明而非改数）。
  // ⚠ 表名与列名**必须拆开写**，不能连成 `sale_items.is_shengmei`：hint 容器
  // （kpi-card.tsx:45）没有 break-words，而 columns=4 在 <lg 视口是 grid-cols-2
  // （不降到 1 列），单卡内容宽仅约 130px —— 26 字符的不可断词会溢出卡片（评审 P2）。
  { key: "shengmeiRevenue", label: "生美业绩", hint: "取自 sale_items 的 is_shengmei 标记" },
  { key: "storeConsume", label: "总实耗" },
  {
    key: "shengmeiConsume",
    label: "生美实耗",
    hint: "取自 service_items 的 is_shengmei 标记，与业绩侧非同一张表",
  },
  { key: "newCustomerRevenue", label: "新增客业绩", hint: "新增会员业绩" },
  // #294：SQL 是 customer_type = '流量客'（2026-05-26 拍板，metrics.md:675），
  // 原 hint「流量/体验/小美客」暗示三类合计，与卡面只含纯流量客一类不符
  { key: "trafficCustomerRevenue", label: "流量客业绩", hint: "仅纯流量客，不含体验客/小美客" },
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
