import Link from "next/link"
import { Activity, BarChart3, Clock3, Download, Filter, LineChart, Store, Users } from "lucide-react"
import { MetricCard } from "@/components/metric-card"
import { RankingBarChart, TrendChart } from "@/components/repurchase-charts"
import { getSession } from "@/lib/auth"
import { getMetric, type AnalystMetric } from "@/lib/metric-catalog"
import {
  getRepurchaseDashboard,
  getRepurchaseFilterOptions,
  normalizeRepurchaseFilters,
  type RepurchaseRankingRow,
} from "@/lib/repurchase"

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

function RankingTable({ rows }: { rows: RepurchaseRankingRow[] }) {
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
        <section>
          <h1 className="text-2xl font-semibold tracking-normal text-neutral-950">经营指标看板</h1>
          <p className="mt-1 text-sm text-neutral-500">一级看板 / 二级指标目录</p>
        </section>
        <PlannedMetricPanel metric={selectedMetric} />
      </div>
    )
  }

  const session = await getSession()
  if (!session) return null
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
      <section>
        <h1 className="text-2xl font-semibold tracking-normal text-neutral-950">经营指标看板</h1>
        <p className="mt-1 text-sm text-neutral-500">一级看板 / 二级指标目录</p>
      </section>

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
          当前条件下无复购率数据，请调整年份、品项或组织范围。
        </section>
      ) : null}

      <section className="grid gap-4 2xl:grid-cols-[1.4fr_1fr]">
        <div className="rounded-lg border border-[var(--border)] bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-medium text-neutral-950">月度复购率趋势</h2>
            <span className="text-xs text-neutral-500">按首购达标月份归属</span>
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
            <RankingTable rows={data.storeRanking} />
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
