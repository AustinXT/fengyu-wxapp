"use client"

import {
  Bar,
  BarChart,
  CartesianGrid,
  Funnel,
  FunnelChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type { NewCustomerFunnelComparisonRow } from "@/lib/new-customer-funnel"

interface FunnelRow {
  name: string
  value: number
}

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

function FunnelTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: FunnelRow }>
}) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <div className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-neutral-950">{row.name}</div>
      <div className="mt-1 text-neutral-600">{row.value.toLocaleString("zh-CN")} 人</div>
    </div>
  )
}

function BarTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ payload: NewCustomerFunnelComparisonRow }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  return (
    <div className="rounded-md border border-[var(--border)] bg-white px-3 py-2 text-xs shadow-sm">
      <div className="font-medium text-neutral-950">{label ?? row.name}</div>
      <div className="mt-1 text-neutral-600">新客人数：{row.newCustomerCount.toLocaleString("zh-CN")}</div>
      <div className="text-neutral-500">到店率：{formatRate(row.arrivalRate)}</div>
      <div className="text-neutral-500">会员成交率：{formatRate(row.memberConversionRate)}</div>
    </div>
  )
}

export function NewCustomerFunnelChart({ data }: { data: FunnelRow[] }) {
  const visible = data.filter((row) => row.value > 0)
  if (visible.length === 0) return <EmptyChart label="暂无漏斗数据" />

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <FunnelChart margin={{ top: 12, right: 24, bottom: 12, left: 24 }}>
          <Tooltip content={<FunnelTooltip />} />
          <Funnel dataKey="value" data={visible} fill="#C0322A" isAnimationActive={false}>
            <LabelList
              dataKey="name"
              position="right"
              fill="#262626"
              formatter={(value: unknown) => String(value)}
            />
            <LabelList
              dataKey="value"
              position="center"
              fill="#ffffff"
              formatter={(value: unknown) => Number(value ?? 0).toLocaleString("zh-CN")}
            />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    </div>
  )
}

export function NewCustomerBarChart({
  data,
  valueKey,
  emptyLabel,
}: {
  data: NewCustomerFunnelComparisonRow[]
  valueKey: "newCustomerCount" | "arrivalRate" | "memberConversionRate"
  emptyLabel: string
}) {
  const visible = data.slice(0, 12)
  if (visible.length === 0) return <EmptyChart label={emptyLabel} />

  const isRate = valueKey === "arrivalRate" || valueKey === "memberConversionRate"
  const height = Math.max(260, visible.length * 36)
  return (
    <div className="w-full overflow-x-auto">
      <div style={{ height }} className="min-w-[520px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={visible} layout="vertical" margin={{ top: 4, right: 64, left: 12, bottom: 4 }}>
            <CartesianGrid stroke="#eeeeee" horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={(value) => (isRate ? formatRate(Number(value ?? 0)) : Number(value ?? 0).toLocaleString("zh-CN"))}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12 }}
            />
            <YAxis
              type="category"
              dataKey="name"
              tickLine={false}
              axisLine={false}
              width={128}
              tick={{ fontSize: 12, fill: "#525252" }}
            />
            <Tooltip content={<BarTooltip />} />
            <Bar dataKey={valueKey} fill="#C0322A" radius={[0, 4, 4, 0]}>
              <LabelList
                dataKey={valueKey}
                position="right"
                formatter={(value: unknown) =>
                  isRate ? formatRate(Number(value ?? 0)) : Number(value ?? 0).toLocaleString("zh-CN")
                }
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
