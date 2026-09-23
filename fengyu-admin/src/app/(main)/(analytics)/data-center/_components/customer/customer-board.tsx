"use client"

import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { actionErrorMessage } from "@/lib/action-error"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseBoardParams } from "@/lib/data-center/params"
import { getCustomerBoard } from "@/actions/data-center/customer"
import { KpiGrid, type KpiGridItem } from "../kpi-card"
import { BreakdownTable } from "../breakdown-table"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import type { CustomerBoardResult } from "@/lib/data-center/types"

// ── KPI 分组（按语义：注册/会员状态 + 客活 / 经营）────────────────
const KPI_REGISTER: KpiGridItem[] = [
  { key: "registeredMembers", label: "会员注册人数" },
  { key: "retainedMembers", label: "有效保有会员" },
  { key: "visitOnce", label: "当月一次人数" },
  { key: "visitTwice", label: "当月二次人数" },
]

const KPI_STATUS: KpiGridItem[] = [
  { key: "dormant", label: "沉睡人数" },
  { key: "reactivatedDormant", label: "激活沉睡" },
  { key: "frozen", label: "冰冻人数" },
  { key: "reactivatedFrozen", label: "激活冰冻" },
  { key: "deep", label: "休眠人数" },
  { key: "reactivatedDeep", label: "激活休眠" },
]

const KPI_OPERATION: KpiGridItem[] = [
  { key: "operatedMembers", label: "会员经营人数", hint: "区间内消费合计 ≥ 1990" },
  { key: "newMembers", label: "会员新增" },
  { key: "trafficCustomers", label: "当月流量客人数" },
  { key: "convRate", label: "成交率", hint: "会员新增 ÷ 流量客" },
  { key: "memberAvgTicket", label: "会员客单" },
  { key: "newCustomerAvgTicket", label: "新客客单" },
  { key: "serviceCount", label: "服务人次" },
  { key: "projectCount", label: "服务项目数" },
  { key: "consumePerVisit", label: "单次客耗", hint: "生美实耗 ÷ 频率" },
]

export function CustomerBoard() {
  const { searchParams } = useUrlFilters()
  const [data, setData] = useState<CustomerBoardResult | null>(null)
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
    getCustomerBoard(params)
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
    return (
      <Card className="p-6 text-sm text-[#D94040]">加载失败：{error}</Card>
    )
  }

  const kpis = data?.kpis ?? {}
  const label = data?.timeRange.presetLabel ?? ""

  return (
    <div className="flex flex-col gap-6">
      {/* 客活/激活随每日重算更新提示 */}
      <div className="text-xs text-[var(--muted-foreground)]">
        客活 / 激活随每日重算更新，上线初期可能为 0。
      </div>

      {/* KPI：注册 + 保有 + 回店 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">注册与保有</h2>
        <KpiGrid items={KPI_REGISTER} kpis={kpis} columns={4} baseRanges={data?.timeRange} />
      </section>

      {/* KPI：会员状态 + 客活激活 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">会员状态与客活</h2>
        <KpiGrid items={KPI_STATUS} kpis={kpis} columns={3} baseRanges={data?.timeRange} />
      </section>

      {/* KPI：经营 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">经营</h2>
        <KpiGrid items={KPI_OPERATION} kpis={kpis} columns={3} baseRanges={data?.timeRange} />
      </section>

      {/* 明细表分 Tab：每张表独立标签（维度 × 表型）*/}
      <Tabs defaultValue="market-reg">
        <TabsList>
          <TabsTrigger value="market-reg">市场·注册客活</TabsTrigger>
          <TabsTrigger value="market-ops">市场·消费经营</TabsTrigger>
          <TabsTrigger value="store-reg">门店·注册客活</TabsTrigger>
          <TabsTrigger value="store-ops">门店·消费经营</TabsTrigger>
        </TabsList>
        <TabsContent value="market-reg">
          <BreakdownTable rows={data?.byMarket ?? []} loading={loading} exportFilename={`客量明细_市场注册客活_${label}`} exportView="customer-market-reg" />
        </TabsContent>
        <TabsContent value="market-ops">
          <BreakdownTable rows={data?.byMarket ?? []} loading={loading} exportFilename={`客量明细_市场消费经营_${label}`} exportView="customer-market-ops" />
        </TabsContent>
        <TabsContent value="store-reg">
          <BreakdownTable rows={data?.byStore ?? []} loading={loading} exportFilename={`客量明细_门店注册客活_${label}`} exportView="customer-store-reg" />
        </TabsContent>
        <TabsContent value="store-ops">
          <BreakdownTable rows={data?.byStore ?? []} loading={loading} exportFilename={`客量明细_门店消费经营_${label}`} exportView="customer-store-ops" />
        </TabsContent>
      </Tabs>
    </div>
  )
}
