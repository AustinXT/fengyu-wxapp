"use client"

import { useEffect, useState } from "react"
import { Card } from "@/components/ui/card"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseBoardParams } from "@/lib/data-center/params"
import { getCustomerBoard } from "@/actions/data-center/customer"
import { KpiGrid, type KpiGridItem } from "../kpi-card"
import { BreakdownTable, type BreakdownColumn } from "../breakdown-table"
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
  { key: "operatedMembers", label: "会员经营人数", hint: "单笔消费 ≥ 1990" },
  { key: "newMembers", label: "会员新增" },
  { key: "trafficCustomers", label: "当月流量客人数" },
  { key: "convRate", label: "成交率", hint: "会员新增 ÷ 流量客" },
  { key: "memberAvgTicket", label: "会员客单" },
  { key: "newCustomerAvgTicket", label: "新客客单" },
  { key: "serviceCount", label: "服务人次" },
  { key: "projectCount", label: "服务项目数" },
  { key: "consumePerVisit", label: "单次客耗", hint: "生美实耗 ÷ 频率" },
]

// ── 明细表列定义 ──────────────────────────────────────────────
// 表1：注册客活
const COLS_REG_ACTIVE: BreakdownColumn[] = [
  { key: "registered", label: "会员注册", unit: "count" },
  { key: "retained", label: "保有会员", unit: "count" },
  { key: "visitOnce", label: "回店1次", unit: "count" },
  { key: "visitOnceRate", label: "1次达成率", unit: "percent" },
  { key: "visitTwice", label: "回店2次", unit: "count" },
  { key: "visitTwiceRate", label: "2次达成率", unit: "percent" },
  { key: "dormant", label: "沉睡", unit: "count" },
  { key: "reactivatedDormant", label: "激活沉睡", unit: "count" },
  { key: "frozen", label: "冰冻", unit: "count" },
  { key: "reactivatedFrozen", label: "激活冰冻", unit: "count" },
  { key: "deep", label: "休眠", unit: "count" },
  { key: "reactivatedDeep", label: "激活休眠", unit: "count" },
]

// 表2：消费分桶 + 经营
const COLS_OPS: BreakdownColumn[] = [
  { key: "bucketD", label: "<1990", unit: "count" },
  { key: "bucketC", label: "≥1990", unit: "count" },
  { key: "bucketB", label: "≥1万", unit: "count" },
  { key: "bucketA", label: "≥3万", unit: "count" },
  { key: "bucketV", label: "≥6万", unit: "count" },
  { key: "bucketVIC", label: "≥10万", unit: "count" },
  { key: "operatedTotal", label: "被经营总数", unit: "count" },
  { key: "newMembers", label: "会员新增", unit: "count" },
  { key: "trafficCustomers", label: "流量客", unit: "count" },
  { key: "convRate", label: "成交率", unit: "percent" },
  { key: "memberAvgTicket", label: "会员客单", unit: "amount" },
  { key: "newCustomerAvgTicket", label: "新客客单", unit: "amount" },
  { key: "trafficVisits", label: "流量人次", unit: "count" },
  { key: "memberVisits", label: "会员人次", unit: "count" },
  { key: "projectCount", label: "项目数", unit: "count" },
  { key: "consumePerVisit", label: "单次客耗", unit: "amount" },
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
    return (
      <Card className="p-6 text-sm text-[#D94040]">加载失败：{error}</Card>
    )
  }

  const kpis = data?.kpis ?? {}

  return (
    <div className="flex flex-col gap-6">
      {/* 客活/激活随每日重算更新提示 */}
      <div className="text-xs text-[var(--muted-foreground)]">
        客活 / 激活随每日重算更新，上线初期可能为 0。
      </div>

      {/* KPI：注册 + 保有 + 回店 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">注册与保有</h2>
        <KpiGrid items={KPI_REGISTER} kpis={kpis} columns={4} />
      </section>

      {/* KPI：会员状态 + 客活激活 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">会员状态与客活</h2>
        <KpiGrid items={KPI_STATUS} kpis={kpis} columns={3} />
      </section>

      {/* KPI：经营 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">经营</h2>
        <KpiGrid items={KPI_OPERATION} kpis={kpis} columns={3} />
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
          <BreakdownTable rows={data?.byMarket ?? []} columns={COLS_REG_ACTIVE} firstColLabel="市场" loading={loading} />
        </TabsContent>
        <TabsContent value="market-ops">
          <BreakdownTable rows={data?.byMarket ?? []} columns={COLS_OPS} firstColLabel="市场" loading={loading} />
        </TabsContent>
        <TabsContent value="store-reg">
          <BreakdownTable rows={data?.byStore ?? []} columns={COLS_REG_ACTIVE} firstColLabel="门店" showMarket loading={loading} />
        </TabsContent>
        <TabsContent value="store-ops">
          <BreakdownTable rows={data?.byStore ?? []} columns={COLS_OPS} firstColLabel="门店" showMarket loading={loading} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
