"use client"

import { Card } from "@/components/ui/card"
import { formatByUnit, formatDelta } from "@/lib/data-center/format"
import type { KpiCell } from "@/lib/data-center/types"
import { cn } from "@/lib/utils"

/** 同比/环比 delta 徽章：正绿 / 负红 / null 灰('--') */
function DeltaBadge({ label, value }: { label: string; value: number | null | undefined }) {
  const invalid = value == null || !Number.isFinite(value)
  const color = invalid
    ? "text-[#999999]"
    : value! > 0
      ? "text-[#3D8A5A]"
      : value! < 0
        ? "text-[#D94040]"
        : "text-[#999999]"
  return (
    <span className={cn("text-xs", color)}>
      {label} {formatDelta(value)}
    </span>
  )
}

/** 单个 KPI 卡片（值 + 同比/环比） */
export function KpiCard({
  label,
  cell,
  hint,
}: {
  label: string
  cell: KpiCell
  hint?: string
}) {
  return (
    <Card className="p-4 flex flex-col gap-1">
      <div className="text-sm text-[var(--muted-foreground)]">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{formatByUnit(cell.value, cell.unit)}</div>
      {(cell.mom !== undefined || cell.yoy !== undefined) && (
        <div className="flex items-center gap-3">
          {cell.mom !== undefined && <DeltaBadge label="环比" value={cell.mom} />}
          {cell.yoy !== undefined && <DeltaBadge label="同比" value={cell.yoy} />}
        </div>
      )}
      {hint && <div className="text-xs text-[var(--muted-foreground)]">{hint}</div>}
    </Card>
  )
}

export interface KpiGridItem {
  key: string
  label: string
  hint?: string
}

/** KPI 卡片网格：按 items 顺序从 kpis 取 cell 渲染 */
export function KpiGrid({
  items,
  kpis,
  columns = 4,
}: {
  items: KpiGridItem[]
  kpis: Record<string, KpiCell>
  columns?: 2 | 3 | 4
}) {
  const colClass =
    columns === 2
      ? "grid-cols-1 sm:grid-cols-2"
      : columns === 3
        ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        : "grid-cols-2 lg:grid-cols-4"
  return (
    <div className={cn("grid gap-3", colClass)}>
      {items.map((it) => {
        const cell = kpis[it.key] ?? { value: null, unit: "count" as const }
        return <KpiCard key={it.key} label={it.label} cell={cell} hint={it.hint} />
      })}
    </div>
  )
}
