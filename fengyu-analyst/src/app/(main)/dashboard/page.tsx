import Link from "next/link"
import {
  Activity,
  AlertTriangle,
  BadgePercent,
  BarChart3,
  Clock3,
  Download,
  Filter,
  Layers3,
  LineChart,
  Package,
  Store,
  TrendingUp,
  Users,
} from "lucide-react"
import { MetricCard } from "@/components/metric-card"
import { NewCustomerBarChart, NewCustomerFunnelChart } from "@/components/new-customer-funnel-charts"
import { PenetrationBarChart } from "@/components/penetration-charts"
import { RankingBarChart, TrendChart } from "@/components/repurchase-charts"
import { getSession } from "@/lib/auth"
import { getMetric, type AnalystMetric } from "@/lib/metric-catalog"
import {
  getNewCustomerFunnelDashboard,
  getNewCustomerFunnelFilterOptions,
  normalizeNewCustomerFunnelFilters,
  type NewCustomerFunnelComparisonRow,
} from "@/lib/new-customer-funnel"
import {
  getPenetrationDashboard,
  getPenetrationFilterOptions,
  normalizePenetrationFilters,
  type PenetrationDataQuality,
  type PenetrationProductOption,
  type PenetrationRankingRow,
} from "@/lib/penetration"
import {
  getRepurchaseDashboard,
  getRepurchaseFilterOptions,
  normalizeRepurchaseFilters,
  type RepurchaseRankingRow,
} from "@/lib/repurchase"
import type { AuthSession } from "@/lib/types"

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatDelta(value: number | null): { text: string; tone: "default" | "positive" | "negative" } {
  if (value === null) return { text: "无上一年对比", tone: "default" }
  if (value === 0) return { text: "同比持平", tone: "default" }
  return {
    text: `同比 ${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}pct`,
    tone: value > 0 ? "positive" : "negative",
  }
}

function formatMoney(value: number): string {
  return value.toLocaleString("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0,
  })
}

function formatDeltaPart(current: number, previous: number, type: "count" | "rate" | "money"): string {
  if (previous === 0) return "无基数"
  if (type === "rate") {
    const delta = current - previous
    if (delta === 0) return "持平"
    return `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}pct`
  }
  const delta = (current - previous) / previous
  if (delta === 0) return "持平"
  return `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`
}

function formatMetricDelta(
  current: number,
  prevYear: number,
  prevPeriod: number,
  type: "count" | "rate" | "money" = "count",
): { text: string; tone: "default" | "positive" | "negative" } {
  const text = `同比 ${formatDeltaPart(current, prevYear, type)} / 环比 ${formatDeltaPart(current, prevPeriod, type)}`
  if (prevYear === 0 || current === prevYear) return { text, tone: "default" }
  return { text, tone: current > prevYear ? "positive" : "negative" }
}

function queryString(filters: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value))
  }
  return params.toString()
}

function getParam(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = params[key]
  return Array.isArray(value) ? value[0] : value
}

function productOptionLabel(option: PenetrationProductOption): string {
  const suffix = option.hasMultipleNames ? " · 多历史名" : option.missingName ? " · 名称缺失" : ""
  return `${option.productName} (${option.skuId})${suffix}`
}

function PlannedMetricPanel({ metric }: { metric: AnalystMetric }) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-white p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-neutral-100 text-neutral-500">
          <Clock3 className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="text-xs font-medium text-neutral-500">{metric.group}</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-normal text-neutral-950">{metric.label}</h1>
          <p className="mt-2 text-sm leading-6 text-neutral-500">{metric.description}</p>
        </div>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-[var(--border)] p-4">
          <div className="text-sm font-medium text-neutral-950">目录层级</div>
          <div className="mt-2 text-sm text-neutral-500">{metric.group} / {metric.label}</div>
        </div>
        <div className="rounded-md border border-[var(--border)] p-4">
          <div className="text-sm font-medium text-neutral-950">数据结构</div>
          <div className="mt-2 text-sm text-neutral-500">指标 ID、分组、状态、路由已固定</div>
        </div>
        <div className="rounded-md border border-[var(--border)] p-4">
          <div className="text-sm font-medium text-neutral-950">接入状态</div>
          <div className="mt-2 text-sm text-neutral-500">口径确认后接入查询与图表</div>
        </div>
      </div>
    </section>
  )
}

function PageTitle() {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-normal text-neutral-950">经营指标看板</h1>
      <p className="mt-1 text-sm text-neutral-500">一级看板 / 二级指标目录</p>
    </section>
  )
}

function RepurchaseRankingTable({ rows }: { rows: RepurchaseRankingRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-md bg-neutral-50 text-sm text-neutral-400">
        暂无门店排名数据
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {rows.slice(0, 10).map((row, index) => (
        <div key={row.name} className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-md bg-neutral-50 px-3 py-3">
          <span className="text-sm tabular-nums text-neutral-500">#{index + 1}</span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-neutral-800">{row.name}</div>
            <div className="mt-0.5 truncate text-xs text-neutral-500">{row.market || "未归属市场"}</div>
          </div>
          <div className="text-right">
            <div className="text-sm font-semibold text-neutral-950">{formatRate(row.repurchaseRate)}</div>
            <div className="mt-0.5 text-xs text-neutral-500">
              {row.repurchaseCount}/{row.entryCount}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function PenetrationRankingTable({
  rows,
  emptyLabel,
}: {
  rows: PenetrationRankingRow[]
  emptyLabel: string
}) {
  if (rows.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-md bg-neutral-50 text-sm text-neutral-400">
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {rows.slice(0, 10).map((row, index) => (
        <div key={row.id} className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-md bg-neutral-50 px-3 py-3">
          <span className="text-sm tabular-nums text-neutral-500">#{index + 1}</span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-neutral-800">{row.name}</div>
            <div className="mt-0.5 truncate text-xs text-neutral-500">
              {[row.skuId, row.seriesName, row.market].filter(Boolean).join(" · ") || "当前范围"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm font-semibold text-neutral-950">{formatRate(row.penetrationRate)}</div>
            <div className="mt-0.5 text-xs text-neutral-500">
              {row.cardHolderCount}/{row.memberCount}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function DataQualityPanel({ quality }: { quality: PenetrationDataQuality }) {
  const missing = quality.missingProductNameSkus
  const multiple = quality.multiNameSkus
  if (missing.length === 0 && multiple.length === 0) return null

  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-amber-950">商品名称数据质量提示</h2>
          <p className="mt-1 text-xs leading-5 text-amber-800">
            商品普及率按 SKU 合并计算，主商品名使用当前 SKU 名称。以下问题只影响历史名称提示，不影响持卡会员去重。
          </p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {multiple.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-white/70 p-3">
                <div className="text-xs font-medium text-amber-950">同一 SKU 多个历史名称</div>
                <div className="mt-2 space-y-1 text-xs text-amber-800">
                  {multiple.slice(0, 5).map((issue) => (
                    <div key={issue.skuId} className="truncate">
                      {issue.skuId}：{issue.productNames.join(" / ")}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {missing.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-white/70 p-3">
                <div className="text-xs font-medium text-amber-950">存在空商品名</div>
                <div className="mt-2 space-y-1 text-xs text-amber-800">
                  {missing.slice(0, 5).map((issue) => (
                    <div key={issue.skuId} className="truncate">
                      {issue.skuId}：{issue.holderCount} 个持卡会员
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}

function NewCustomerComparisonTable({
  rows,
  firstColumnLabel,
  emptyLabel,
}: {
  rows: NewCustomerFunnelComparisonRow[]
  firstColumnLabel: string
  emptyLabel: string
}) {
  if (rows.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-md bg-neutral-50 text-sm text-neutral-400">
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1120px] text-left text-sm">
        <thead className="border-b border-[var(--border)] text-xs text-neutral-500">
          <tr>
            <th className="py-2 pr-3 font-medium">{firstColumnLabel}</th>
            <th className="px-3 py-2 text-right font-medium">新客</th>
            <th className="px-3 py-2 text-right font-medium">T+30</th>
            <th className="px-3 py-2 text-right font-medium">T+60</th>
            <th className="px-3 py-2 text-right font-medium">T+90</th>
            <th className="px-3 py-2 text-right font-medium">合计到店</th>
            <th className="px-3 py-2 text-right font-medium">到店率</th>
            <th className="px-3 py-2 text-right font-medium">会员客户</th>
            <th className="px-3 py-2 text-right font-medium">会员成交率</th>
            <th className="px-3 py-2 text-right font-medium">首单金额</th>
            <th className="px-3 py-2 text-right font-medium">首单客单价</th>
            <th className="px-3 py-2 text-right font-medium">年度贡献</th>
            <th className="py-2 pl-3 text-right font-medium">贡献人均</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)] text-neutral-700">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="py-3 pr-3 font-medium text-neutral-900">{row.name}</td>
              <td className="px-3 py-3 text-right tabular-nums">{row.newCustomerCount}</td>
              <td className="px-3 py-3 text-right tabular-nums">{row.serviceT30Count}</td>
              <td className="px-3 py-3 text-right tabular-nums">{row.serviceT60Count}</td>
              <td className="px-3 py-3 text-right tabular-nums">{row.serviceT90Count}</td>
              <td className="px-3 py-3 text-right tabular-nums">{row.arrivedCount}</td>
              <td className="px-3 py-3 text-right tabular-nums">{formatRate(row.arrivalRate)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{row.memberCustomerCount}</td>
              <td className="px-3 py-3 text-right tabular-nums">{formatRate(row.memberConversionRate)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{formatMoney(row.firstMembershipAmount)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{formatMoney(row.firstMembershipAverage)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{formatMoney(row.annualContributionAmount)}</td>
              <td className="py-3 pl-3 text-right tabular-nums">{formatMoney(row.annualContributionAverage)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

async function NewCustomerDashboard({
  session,
  params,
  selectedMetric,
}: {
  session: AuthSession
  params: Record<string, string | string[] | undefined>
  selectedMetric: AnalystMetric
}) {
  const filters = normalizeNewCustomerFunnelFilters(params)
  const [data, options] = await Promise.all([
    getNewCustomerFunnelDashboard(session, filters),
    getNewCustomerFunnelFilterOptions(session, filters.market),
  ])
  const normalized = data.filters
  const newCustomerDelta = formatMetricDelta(
    data.kpi.newCustomerCount,
    data.prevYearKpi.newCustomerCount,
    data.prevPeriodKpi.newCustomerCount,
  )
  const arrivedDelta = formatMetricDelta(
    data.kpi.arrivedCount,
    data.prevYearKpi.arrivedCount,
    data.prevPeriodKpi.arrivedCount,
  )
  const arrivalRateDelta = formatMetricDelta(
    data.kpi.arrivalRate,
    data.prevYearKpi.arrivalRate,
    data.prevPeriodKpi.arrivalRate,
    "rate",
  )
  const memberCountDelta = formatMetricDelta(
    data.kpi.memberCustomerCount,
    data.prevYearKpi.memberCustomerCount,
    data.prevPeriodKpi.memberCustomerCount,
  )
  const memberRateDelta = formatMetricDelta(
    data.kpi.memberConversionRate,
    data.prevYearKpi.memberConversionRate,
    data.prevPeriodKpi.memberConversionRate,
    "rate",
  )
  const firstAmountDelta = formatMetricDelta(
    data.kpi.firstMembershipAmount,
    data.prevYearKpi.firstMembershipAmount,
    data.prevPeriodKpi.firstMembershipAmount,
    "money",
  )
  const firstAverageDelta = formatMetricDelta(
    data.kpi.firstMembershipAverage,
    data.prevYearKpi.firstMembershipAverage,
    data.prevPeriodKpi.firstMembershipAverage,
    "money",
  )
  const annualAmountDelta = formatMetricDelta(
    data.kpi.annualContributionAmount,
    data.prevYearKpi.annualContributionAmount,
    data.prevPeriodKpi.annualContributionAmount,
    "money",
  )
  const comparisonLabel =
    normalized.tableMode === "months" ? "月份" : normalized.unitLevel === "store" ? "门店" : "市场"
  const comparisonTitle = normalized.tableMode === "months" ? "多月份对比" : "单位对比"

  return (
    <div className="space-y-5">
      <PageTitle />

      <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-medium text-neutral-500">{selectedMetric.group}</div>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-neutral-950">新客漏斗指标看板</h2>
          <p className="mt-1 text-sm text-neutral-500">新客来源、T+90 到店、会员成交和年度贡献</p>
        </div>
      </section>

      <form className="grid gap-3 rounded-lg border border-[var(--border)] bg-white p-4 md:grid-cols-3 2xl:grid-cols-8" action="/dashboard">
        <input type="hidden" name="metric" value="new-customer-funnel" />
        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">起始月份</span>
          <input
            type="month"
            name="startMonth"
            defaultValue={normalized.startMonth}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">结束月份</span>
          <input
            type="month"
            name="endMonth"
            defaultValue={normalized.endMonth}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          />
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">表格视图</span>
          <select
            name="tableMode"
            defaultValue={normalized.tableMode}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="months">多月份对比</option>
            <option value="units">多单位对比</option>
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">单位层级</span>
          <select
            name="unitLevel"
            defaultValue={normalized.unitLevel}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="market">市场</option>
            <option value="store">门店</option>
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">来源</span>
          <select
            name="source"
            defaultValue={normalized.source}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部来源</option>
            {options.sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">市场</span>
          <select
            name="market"
            defaultValue={normalized.market}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部市场</option>
            {options.markets.map((market) => (
              <option key={market} value={market}>
                {market}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">门店</span>
          <select
            name="store"
            defaultValue={normalized.store}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部门店</option>
            {options.stores.map((storeName) => (
              <option key={storeName} value={storeName}>
                {storeName}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-2 self-end">
          <button className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-md bg-[var(--primary)] px-4 text-sm font-medium text-white" type="submit">
            <Filter className="size-4" />
            筛选
          </button>
          <Link
            href="/dashboard?metric=new-customer-funnel"
            className="inline-flex h-10 items-center justify-center rounded-md border border-[var(--border)] px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            重置
          </Link>
        </div>
      </form>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Users} label="新客总人数" value={data.kpi.newCustomerCount.toLocaleString("zh-CN")} helper={newCustomerDelta.text} tone={newCustomerDelta.tone} />
        <MetricCard icon={Activity} label="合计到店人数" value={data.kpi.arrivedCount.toLocaleString("zh-CN")} helper={`到店率 ${formatRate(data.kpi.arrivalRate)} · ${arrivedDelta.text}`} tone={arrivedDelta.tone} />
        <MetricCard icon={BadgePercent} label="到店率" value={formatRate(data.kpi.arrivalRate)} helper={arrivalRateDelta.text} tone={arrivalRateDelta.tone} />
        <MetricCard icon={Store} label="会员客户数" value={data.kpi.memberCustomerCount.toLocaleString("zh-CN")} helper={`成交率 ${formatRate(data.kpi.memberConversionRate)} · ${memberCountDelta.text}`} tone={memberCountDelta.tone} />
        <MetricCard icon={TrendingUp} label="会员成交率" value={formatRate(data.kpi.memberConversionRate)} helper={memberRateDelta.text} tone={memberRateDelta.tone} />
        <MetricCard icon={BarChart3} label="新会员首单金额" value={formatMoney(data.kpi.firstMembershipAmount)} helper={`客单价 ${formatMoney(data.kpi.firstMembershipAverage)} · ${firstAmountDelta.text}`} tone={firstAmountDelta.tone} />
        <MetricCard icon={BadgePercent} label="新会员首单客单价" value={formatMoney(data.kpi.firstMembershipAverage)} helper={firstAverageDelta.text} tone={firstAverageDelta.tone} />
        <MetricCard icon={LineChart} label="会员年度贡献金额" value={formatMoney(data.kpi.annualContributionAmount)} helper={`人均 ${formatMoney(data.kpi.annualContributionAverage)} · ${annualAmountDelta.text}`} tone={annualAmountDelta.tone} />
      </section>

      {data.kpi.newCustomerCount === 0 ? (
        <section className="rounded-lg border border-[var(--border)] bg-white p-4 text-sm text-neutral-600">
          当前条件下无新客漏斗数据，请调整月份、来源或组织范围。
        </section>
      ) : null}

      <section className="grid gap-4 2xl:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-medium text-neutral-950">新客转化漏斗</h2>
            <span className="text-xs text-neutral-500">T+30/T+60/T+90 已合并</span>
          </div>
          <div className="mt-4">
            <NewCustomerFunnelChart data={data.funnelRows} />
          </div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <h2 className="text-base font-medium text-neutral-950">来源新客人数</h2>
          <div className="mt-4">
            <NewCustomerBarChart data={data.sourceBreakdown} valueKey="newCustomerCount" emptyLabel="暂无来源数据" />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-white p-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-medium text-neutral-950">{comparisonTitle}</h2>
          <span className="text-xs text-neutral-500">
            {normalized.startMonth} 至 {normalized.endMonth}
          </span>
        </div>
        <div className="mt-4">
          <NewCustomerComparisonTable rows={data.comparisonRows} firstColumnLabel={comparisonLabel} emptyLabel="暂无对比数据" />
        </div>
      </section>

      <section className="rounded-lg border border-[var(--border)] bg-white p-4">
        <h2 className="text-base font-medium text-neutral-950">来源明细</h2>
        <div className="mt-4">
          <NewCustomerComparisonTable rows={data.sourceBreakdown} firstColumnLabel="来源" emptyLabel="暂无来源数据" />
        </div>
      </section>
    </div>
  )
}

async function RepurchaseDashboard({
  session,
  params,
  selectedMetric,
}: {
  session: AuthSession
  params: Record<string, string | string[] | undefined>
  selectedMetric: AnalystMetric
}) {
  const filters = normalizeRepurchaseFilters(params)
  const [data, options] = await Promise.all([
    getRepurchaseDashboard(session, filters),
    getRepurchaseFilterOptions(session, filters.market, filters.productKind),
  ])
  const normalized = data.filters
  const delta = formatDelta(data.kpi.delta)
  const exportHref = `/api/analyst/repurchase/export?${queryString({
    year: normalized.year || undefined,
    productKind: normalized.productKind,
    categoryName: normalized.categoryName,
    market: normalized.market,
    store: normalized.store,
  })}`

  return (
    <div className="space-y-5">
      <PageTitle />

      <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-medium text-neutral-500">{selectedMetric.group}</div>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-neutral-950">复购率指标看板</h2>
          <p className="mt-1 text-sm text-neutral-500">复购率、品项、市场和门店表现</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={exportHref}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-[var(--border)] bg-white px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            <Download className="size-4" />
            导出汇总
          </a>
        </div>
      </section>

      <form className="grid gap-3 rounded-lg border border-[var(--border)] bg-white p-4 md:grid-cols-[1fr_1fr_1fr] xl:grid-cols-[1fr_1fr_1fr_1fr_1fr_auto_auto]" action="/dashboard">
        <input type="hidden" name="metric" value="repurchase" />
        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">年份</span>
          <select
            name="year"
            defaultValue={normalized.year || ""}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部年份</option>
            {options.years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">一级品项</span>
          <select
            name="productKind"
            defaultValue={normalized.productKind}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部一级</option>
            {options.productKinds.map((productKind) => (
              <option key={productKind} value={productKind}>
                {productKind}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">二级品项</span>
          <select
            name="categoryName"
            defaultValue={normalized.categoryName}
            disabled={!normalized.productKind}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] disabled:bg-neutral-50 disabled:text-neutral-400"
          >
            <option value="">{normalized.productKind ? "全部二级" : "请先选一级"}</option>
            {options.categoryNames.map((categoryName) => (
              <option key={categoryName} value={categoryName}>
                {categoryName}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">市场</span>
          <select
            name="market"
            defaultValue={normalized.market}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部市场</option>
            {options.markets.map((market) => (
              <option key={market} value={market}>
                {market}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">门店</span>
          <select
            name="store"
            defaultValue={normalized.store}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部门店</option>
            {options.stores.map((storeName) => (
              <option key={storeName} value={storeName}>
                {storeName}
              </option>
            ))}
          </select>
        </label>

        <button className="inline-flex h-10 items-center justify-center gap-2 self-end rounded-md bg-[var(--primary)] px-4 text-sm font-medium text-white" type="submit">
          <Filter className="size-4" />
          筛选
        </button>
        <Link
          href="/dashboard?metric=repurchase"
          className="inline-flex h-10 items-center justify-center self-end rounded-md border border-[var(--border)] px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          重置
        </Link>
      </form>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={LineChart} label="复购率" value={formatRate(data.kpi.repurchaseRate)} helper={delta.text} tone={delta.tone} />
        <MetricCard icon={Users} label="进入人数" value={data.kpi.entryCount.toLocaleString("zh-CN")} helper={`达标门槛 ${data.threshold.toLocaleString("zh-CN")} 元`} />
        <MetricCard icon={Activity} label="复购人数" value={data.kpi.repurchaseCount.toLocaleString("zh-CN")} helper="后续非同日达标购买" />
        <MetricCard
          icon={BarChart3}
          label="品项均值"
          value={data.anomaly ? formatRate(data.anomaly.meanRate) : data.categoryComparison.length ? formatRate(data.categoryComparison.reduce((sum, row) => sum + row.repurchaseRate, 0) / data.categoryComparison.length) : "--"}
          helper={data.anomaly?.rank ? `当前品项排名 ${data.anomaly.rank}/${data.anomaly.total}` : "当前筛选品项对比"}
          tone={data.anomaly?.type === "high" ? "positive" : data.anomaly?.type === "low" ? "negative" : "default"}
        />
      </section>

      {data.kpi.entryCount === 0 ? (
        <section className="rounded-lg border border-[var(--border)] bg-white p-4 text-sm text-neutral-600">
          当前条件下无复购率数据，请调整年份、日期、品项或组织范围。
        </section>
      ) : null}

      <section className="grid gap-4 2xl:grid-cols-[1.4fr_1fr]">
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-medium text-neutral-950">月度复购率趋势</h2>
            <span className="text-xs text-neutral-500">按首次进入月份归属</span>
          </div>
          <div className="mt-4">
            <TrendChart data={data.trend} />
          </div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <div className="flex items-center gap-2">
            <Store className="size-4 text-[var(--primary)]" />
            <h2 className="text-base font-medium text-neutral-950">门店排名</h2>
          </div>
          <div className="mt-4">
            <RepurchaseRankingTable rows={data.storeRanking} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 2xl:grid-cols-2">
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <h2 className="text-base font-medium text-neutral-950">市场复购率对比</h2>
          <div className="mt-4">
            <RankingBarChart data={normalized.market ? [] : data.marketComparison} emptyLabel={normalized.market ? "已选择市场，取消市场筛选可查看全部市场" : "暂无市场数据"} />
          </div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <h2 className="text-base font-medium text-neutral-950">品项复购率对比</h2>
          <div className="mt-4">
            <RankingBarChart data={normalized.categoryName ? [] : data.categoryComparison} emptyLabel={normalized.categoryName ? "已选择二级品项，取消二级筛选可查看品项对比" : "暂无品项数据"} />
          </div>
        </div>
      </section>
    </div>
  )
}

async function PenetrationDashboard({
  session,
  params,
  selectedMetric,
}: {
  session: AuthSession
  params: Record<string, string | string[] | undefined>
  selectedMetric: AnalystMetric
}) {
  const filters = normalizePenetrationFilters(params)
  const [data, options] = await Promise.all([
    getPenetrationDashboard(session, filters),
    getPenetrationFilterOptions(session, filters.market, filters.productKind, filters.categoryName, filters.seriesName),
  ])
  const normalized = data.filters
  const exportHref = `/api/analyst/penetration/export?${queryString({
    productKind: normalized.productKind,
    categoryName: normalized.categoryName,
    seriesName: normalized.seriesName,
    skuId: normalized.skuId,
    market: normalized.market,
    store: normalized.store,
  })}`

  return (
    <div className="space-y-5">
      <PageTitle />

      <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-medium text-neutral-500">{selectedMetric.group}</div>
          <h2 className="mt-1 text-xl font-semibold tracking-normal text-neutral-950">普及率指标看板</h2>
          <p className="mt-1 text-sm text-neutral-500">当前未用完疗程卡会员覆盖情况</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={exportHref}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-[var(--border)] bg-white px-3 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            <Download className="size-4" />
            导出持卡会员
          </a>
        </div>
      </section>

      <form className="grid gap-3 rounded-lg border border-[var(--border)] bg-white p-4 md:grid-cols-3 2xl:grid-cols-[1fr_1fr_1fr_1fr_1fr_1fr_auto_auto]" action="/dashboard">
        <input type="hidden" name="metric" value="penetration" />
        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">一级品项</span>
          <select
            name="productKind"
            defaultValue={normalized.productKind}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部一级</option>
            {options.productKinds.map((productKind) => (
              <option key={productKind} value={productKind}>
                {productKind}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">二级品项</span>
          <select
            name="categoryName"
            defaultValue={normalized.categoryName}
            disabled={!normalized.productKind}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)] disabled:bg-neutral-50 disabled:text-neutral-400"
          >
            <option value="">{normalized.productKind ? "全部二级" : "请先选一级"}</option>
            {options.categoryNames.map((categoryName) => (
              <option key={categoryName} value={categoryName}>
                {categoryName}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">系列</span>
          <select
            name="seriesName"
            defaultValue={normalized.seriesName}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部系列</option>
            {options.seriesNames.map((seriesName) => (
              <option key={seriesName} value={seriesName}>
                {seriesName}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">商品</span>
          <select
            name="skuId"
            defaultValue={normalized.skuId}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部商品</option>
            {options.products.map((product) => (
              <option key={product.skuId} value={product.skuId}>
                {productOptionLabel(product)}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">市场</span>
          <select
            name="market"
            defaultValue={normalized.market}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部市场</option>
            {options.markets.map((market) => (
              <option key={market} value={market}>
                {market}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium text-neutral-500">门店</span>
          <select
            name="store"
            defaultValue={normalized.store}
            className="h-10 w-full rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none focus:border-[var(--ring)]"
          >
            <option value="">全部门店</option>
            {options.stores.map((storeName) => (
              <option key={storeName} value={storeName}>
                {storeName}
              </option>
            ))}
          </select>
        </label>

        <button className="inline-flex h-10 items-center justify-center gap-2 self-end rounded-md bg-[var(--primary)] px-4 text-sm font-medium text-white" type="submit">
          <Filter className="size-4" />
          筛选
        </button>
        <Link
          href="/dashboard?metric=penetration"
          className="inline-flex h-10 items-center justify-center self-end rounded-md border border-[var(--border)] px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          重置
        </Link>
      </form>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={BadgePercent} label="普及率" value={formatRate(data.kpi.penetrationRate)} helper="持卡会员 / 总会员" />
        <MetricCard icon={Users} label="持卡会员" value={data.kpi.cardHolderCount.toLocaleString("zh-CN")} helper="当前剩余次数 > 0" />
        <MetricCard icon={Store} label="总会员" value={data.kpi.memberCount.toLocaleString("zh-CN")} helper="按顾客绑定门店归属" />
        <MetricCard icon={Activity} label="剩余总次数" value={data.kpi.remainingSessions.toLocaleString("zh-CN")} helper="当前筛选下疗程余次" />
      </section>

      {data.kpi.memberCount === 0 || data.kpi.cardHolderCount === 0 ? (
        <section className="rounded-lg border border-[var(--border)] bg-white p-4 text-sm text-neutral-600">
          当前条件下无普及率数据，请调整品项、商品或组织范围。
        </section>
      ) : null}

      <DataQualityPanel quality={data.dataQuality} />

      <section className="grid gap-4 2xl:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <div className="flex items-center gap-2">
            <Store className="size-4 text-[var(--primary)]" />
            <h2 className="text-base font-medium text-neutral-950">门店普及率排名</h2>
          </div>
          <div className="mt-4">
            <PenetrationRankingTable rows={data.storeRanking} emptyLabel="暂无门店普及率数据" />
          </div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <h2 className="text-base font-medium text-neutral-950">市场普及率对比</h2>
          <div className="mt-4">
            <PenetrationBarChart data={normalized.market ? [] : data.marketComparison} emptyLabel={normalized.market ? "已选择市场，取消市场筛选可查看全部市场" : "暂无市场数据"} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 2xl:grid-cols-2">
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <div className="flex items-center gap-2">
            <Layers3 className="size-4 text-[var(--primary)]" />
            <h2 className="text-base font-medium text-neutral-950">一级品项普及率</h2>
          </div>
          <div className="mt-4">
            <PenetrationBarChart data={normalized.productKind ? [] : data.productKindComparison} emptyLabel={normalized.productKind ? "已选择一级品项，取消筛选可查看全部一级" : "暂无一级品项数据"} />
          </div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <h2 className="text-base font-medium text-neutral-950">二级品项普及率</h2>
          <div className="mt-4">
            <PenetrationBarChart data={normalized.categoryName ? [] : data.categoryComparison} emptyLabel={normalized.categoryName ? "已选择二级品项，取消二级筛选可查看对比" : "暂无二级品项数据"} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 2xl:grid-cols-2">
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <h2 className="text-base font-medium text-neutral-950">系列普及率</h2>
          <div className="mt-4">
            <PenetrationBarChart data={normalized.seriesName ? [] : data.seriesComparison} emptyLabel={normalized.seriesName ? "已选择系列，取消系列筛选可查看对比" : "暂无系列数据"} />
          </div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <div className="flex items-center gap-2">
            <Package className="size-4 text-[var(--primary)]" />
            <h2 className="text-base font-medium text-neutral-950">商品普及率</h2>
          </div>
          <div className="mt-4">
            <PenetrationBarChart data={normalized.skuId ? [] : data.productComparison} emptyLabel={normalized.skuId ? "已选择商品，取消商品筛选可查看对比" : "暂无商品数据"} />
          </div>
        </div>
      </section>
    </div>
  )
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const selectedMetric = getMetric(getParam(params, "metric"))

  if (selectedMetric.status !== "available") {
    return (
      <div className="space-y-5">
        <PageTitle />
        <PlannedMetricPanel metric={selectedMetric} />
      </div>
    )
  }

  const session = await getSession()
  if (!session) return null

  if (selectedMetric.id === "penetration") {
    return <PenetrationDashboard session={session} params={params} selectedMetric={selectedMetric} />
  }

  if (selectedMetric.id === "new-customer-funnel") {
    return <NewCustomerDashboard session={session} params={params} selectedMetric={selectedMetric} />
  }

  return <RepurchaseDashboard session={session} params={params} selectedMetric={selectedMetric} />
}
