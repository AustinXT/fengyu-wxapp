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
  // #298：按到店天数分档（同一天多张服务单只算 1 天），与顾客列表「月度客活」同口径
  { key: "visitOnce", label: "当月一次人数", hint: "所选区间内到店 1 天的保有会员（同日多单算 1 天）" },
  { key: "visitTwice", label: "当月二次人数", hint: "所选区间内到店 ≥2 天的保有会员（同日多单算 1 天）" },
]

// #294：左三格读 cron 每日重算的 customer_status 截面，**不随所选区间变化**；
// 右三格按区间实时反推（anchor = startDate-1）。并排却不同时态，选「今年」时
// 集团会显示 68 vs 1273（18.7 倍）—— 这是口径差异不是数据错，靠角标区分。
// metrics.md:240 的权威措辞即「截面快照」/「区间统计」。
// 口径本身不改（历史重建代价大，metrics.md:244-246 已记录该取舍）。
// ⚠ 沉睡格的 hint 与另两档**不能**逐字相同：queryStatusCount（customer.ts:181）只在
// status === '沉睡' 时追加 AND c.customer_type = '会员客'，冰冻/休眠没有这层过滤。
// 该差异是 metrics.md:251 的既定决策（D-6）且被 consistency.customer.test.ts 守护，
// 三卡并排用同一句会制造「三档口径对等」的错觉（评审 P1，见 concurrency.md）。
const KPI_STATUS: KpiGridItem[] = [
  { key: "dormant", label: "沉睡人数", hint: "截面快照（仅会员客），不随时间区间变化" },
  { key: "reactivatedDormant", label: "激活沉睡", hint: "区间统计" },
  { key: "frozen", label: "冰冻人数", hint: "截面快照，不随时间区间变化" },
  { key: "reactivatedFrozen", label: "激活冰冻", hint: "区间统计" },
  { key: "deep", label: "休眠人数", hint: "截面快照，不随时间区间变化" },
  { key: "reactivatedDeep", label: "激活休眠", hint: "区间统计" },
]

const KPI_OPERATION: KpiGridItem[] = [
  { key: "operatedMembers", label: "会员经营人数", hint: "区间内消费合计 ≥ 1990" },
  { key: "newMembers", label: "会员新增" },
  // #284：分母不再是「流量客」这个 customer_type 枚举值（新口径恰恰不含流量客），
  // 改名避免与「流量人次」「流量客业绩」两个真·流量客指标混淆
  { key: "trafficCustomers", label: "成交率分母", hint: "期初未达会员的到店活跃池 ∪ 本期全部新增会员" },
  { key: "convRate", label: "成交率", hint: "会员新增 ÷ 成交率分母" },
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
        <KpiGrid items={KPI_REGISTER} kpis={kpis} columns={4} baseRanges={loading ? undefined : data?.timeRange} />
      </section>

      {/* KPI：会员状态 + 客活激活 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">会员状态与客活</h2>
        <KpiGrid items={KPI_STATUS} kpis={kpis} columns={3} baseRanges={loading ? undefined : data?.timeRange} />
      </section>

      {/* KPI：经营 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">经营</h2>
        <KpiGrid items={KPI_OPERATION} kpis={kpis} columns={3} baseRanges={loading ? undefined : data?.timeRange} />
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
