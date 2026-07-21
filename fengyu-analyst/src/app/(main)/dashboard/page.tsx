import { Activity, BarChart3, LineChart, Users } from "lucide-react"
import { MetricCard } from "@/components/metric-card"

export default function DashboardPage() {
  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-neutral-950">经营分析</h1>
          <p className="mt-1 text-sm text-neutral-500">复购率、品项、市场和门店表现</p>
        </div>
        <div className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-sm text-neutral-600">
          本月 · 全部范围
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={LineChart} label="复购率" value="--" />
        <MetricCard icon={Users} label="进入人数" value="--" />
        <MetricCard icon={Activity} label="复购人数" value="--" />
        <MetricCard icon={BarChart3} label="对比均值" value="--" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="min-h-[320px] rounded-lg border border-[var(--border)] bg-white p-4">
          <h2 className="text-base font-medium text-neutral-950">月度复购率趋势</h2>
          <div className="mt-4 flex h-60 items-center justify-center rounded-md bg-neutral-50 text-sm text-neutral-400">
            chart
          </div>
        </div>
        <div className="min-h-[320px] rounded-lg border border-[var(--border)] bg-white p-4">
          <h2 className="text-base font-medium text-neutral-950">门店排名</h2>
          <div className="mt-4 space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-3">
                <span className="text-sm text-neutral-500">#{i}</span>
                <span className="text-sm font-medium text-neutral-700">--</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

