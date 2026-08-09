"use client"

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { RepurchaseRankingRow, RepurchaseSeriesPoint } from "@/lib/repurchase"

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[220px] items-center justify-center rounded-md bg-neutral-50 text-sm text-neutral-400">
      {label}
    </div>
  )
}

function TooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ payload: RepurchaseSeriesPoint }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <div className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-neutral-950">{label ?? row.name}</div>
      <div className="mt-1 text-neutral-600">复购率：{formatRate(row.repurchaseRate)}</div>
      <div className="text-neutral-500">进入人数：{row.entryCount}</div>
      <div className="text-neutral-500">复购人数：{row.repurchaseCount}</div>
    </div>
  )
}

export function TrendChart({ data }: { data: RepurchaseSeriesPoint[] }) {
  if (data.length === 0) return <EmptyChart label="暂无趋势数据" />

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 12, left: -12, bottom: 0 }}>
          <CartesianGrid stroke="#eeeeee" vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#737373" }} />
          <YAxis
            tickFormatter={formatRate}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 12, fill: "#737373" }}
            width={58}
          />
          <Tooltip content={<TooltipContent />} />
          <Line
            type="monotone"
            dataKey="repurchaseRate"
            stroke="#C0322A"
            strokeWidth={2.5}
            dot={{ r: 3, fill: "#C0322A", strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function RankingBarChart({
  data,
  emptyLabel,
}: {
  data: RepurchaseRankingRow[]
  emptyLabel: string
}) {
  const visible = data.slice(0, 12)
  if (visible.length === 0) return <EmptyChart label={emptyLabel} />

  const height = Math.max(260, visible.length * 36)
  return (
    <div className="w-full overflow-x-auto">
      <div style={{ height }} className="min-w-[520px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={visible} layout="vertical" margin={{ top: 4, right: 54, left: 12, bottom: 4 }}>
            <CartesianGrid stroke="#eeeeee" horizontal={false} />
            <XAxis type="number" tickFormatter={formatRate} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
            <YAxis
              type="category"
              dataKey="name"
              tickLine={false}
              axisLine={false}
              width={128}
              tick={{ fontSize: 12, fill: "#525252" }}
            />
            <Tooltip content={<TooltipContent />} />
            <Bar dataKey="repurchaseRate" fill="#C0322A" radius={[0, 4, 4, 0]}>
              <LabelList dataKey="repurchaseRate" position="right" formatter={(value) => formatRate(Number(value ?? 0))} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
