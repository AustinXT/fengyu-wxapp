"use client"

import { Card } from "@/components/ui/card"
import { DELTA_DIGITS, formatByUnit, formatDelta } from "@/lib/data-center/format"
import { deltaTone, type DeltaDisplay } from "@/lib/delta-display"
import type { KpiCell } from "@/lib/data-center/types"
import { cn } from "@/lib/utils"

const TONE_CLASS = {
  positive: "text-[#3D8A5A]",
  negative: "text-[#D94040]",
  neutral: "text-[#999999]",
} as const

/** 基期区间 → hover 文案，如「环比基期：2026-08-01 ~ 2026-08-22（22 天）」 */
function basePeriodTitle(label: string, range: { start: string; end: string } | null): string | undefined {
  if (!range) return undefined
  // 含首尾两端，所以 +1；start/end 都是 'YYYY-MM-DD' 的纯日期串，用 UTC 解析避免本地时区偏移。
  const days =
    Math.round((Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86400000) + 1
  return `${label}基期：${range.start} ~ ${range.end}（${days} 天）`
}

/**
 * 同比/环比 delta 徽章（#310 决策 1）。
 *
 * hover 露出基期实际区间是本次的核心诉求：「本月」预设与「自定义同起止日」会给出
 * 两个不同的环比值（实测差 15.63pp），这是正确的语义差异，但用户从界面上得不到解释，
 * 看到同一个当期窗口两个数只会认为是 bug。
 */
function DeltaBadge({
  label,
  display,
  baseRange,
}: {
  label: string
  display: DeltaDisplay | undefined
  baseRange: { start: string; end: string } | null
}) {
  const tone = display ? deltaTone(display, DELTA_DIGITS) : "neutral"
  return (
    <span className={cn("text-xs", TONE_CLASS[tone])} title={basePeriodTitle(label, baseRange)}>
      {label} {formatDelta(display)}
    </span>
  )
}

/**
 * 基期实际区间。来自 `BoardMeta.timeRange`，仅用于 hover 提示。
 * 可选——省略时徽章照常渲染、只是没有 hover（明细表等 `withComparison:false` 的场景）。
 */
export interface BasePeriodRanges {
  previous: { start: string; end: string } | null
  lastYear: { start: string; end: string } | null
}

/** 单个 KPI 卡片（值 + 同比/环比） */
export function KpiCard({
  label,
  cell,
  hint,
  baseRanges,
}: {
  label: string
  cell: KpiCell
  hint?: string
  baseRanges?: BasePeriodRanges
}) {
  return (
    <Card className="p-4 flex flex-col gap-1">
      <div className="text-sm text-[var(--muted-foreground)]">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{formatByUnit(cell.value, cell.unit)}</div>
      {(cell.mom !== undefined || cell.yoy !== undefined) && (
        <div className="flex items-center gap-3">
          {cell.mom !== undefined && (
            <DeltaBadge label="环比" display={cell.mom} baseRange={baseRanges?.previous ?? null} />
          )}
          {cell.yoy !== undefined && (
            <DeltaBadge label="同比" display={cell.yoy} baseRange={baseRanges?.lastYear ?? null} />
          )}
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
  baseRanges,
}: {
  items: KpiGridItem[]
  kpis: Record<string, KpiCell>
  columns?: 2 | 3 | 4
  baseRanges?: BasePeriodRanges
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
        return (
          <KpiCard key={it.key} label={it.label} cell={cell} hint={it.hint} baseRanges={baseRanges} />
        )
      })}
    </div>
  )
}
