"use client"

import type { ReactNode } from "react"
import { RotateCcw } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DatePicker } from "@/components/ui/date-picker"
import { Select, SelectOption } from "@/components/ui/select"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import {
  MAX_CUSTOM_RANGE_DAYS,
  REPORT_RANGE_PRESETS,
  REPORT_RANGE_PRESET_LABELS,
  reportMonthOptions,
  type ReportPeriod,
  type ReportRangePreset,
} from "@/lib/data-center/report-period"
import type { ReportPeriodKind } from "@/lib/data-center/report-page"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"
import { cn } from "@/lib/utils"
import { ScopeSelect } from "../scope-select"

function formatMonth(month: string): string {
  const [year, mon] = month.split("-")
  return `${year}年${Number(mon)}月`
}

/**
 * 经营明细报表公共筛选器（#367）。范围部分与板块页共用 ScopeSelect，视觉同 ScopeTimeFilter；
 * 交互即时生效（写 URL），另加「重置」。三种形态：
 *   range  区间型：上月 / 本月 / 近 30 天 / 自定义
 *   month  单月型：月份下拉（最早 2026-07）
 *   none   仅范围型：不显示日期
 *
 * 当前生效的期间由服务端解析后经 `period` 传入（非法 URL 已回落默认），按钮高亮以它为准，
 * 不在客户端重复解析——否则 URL 写了非法自定义区间时，高亮与实际取数会对不上。
 */
export function ReportFilter({
  scopeOptions,
  periodKind,
  period,
  defaultQuery,
  today,
}: {
  scopeOptions: DataCenterScopeOptions
  periodKind: ReportPeriodKind
  period: ReportPeriod | null
  /** 权限默认范围对应的 URL 参数，「重置」只保留这些 */
  defaultQuery: Record<string, string>
  today: string
}) {
  // 整张卡片只用一个 useUrlFilters 实例（见 ScopeSelect 的 filters 参数说明）
  const filters = useUrlFilters()

  // 重置 = 回到权限默认范围 + 默认期间，同时清掉页面自身的搜索 / 排序 / 分页等参数
  function reset() {
    filters.replaceAll(defaultQuery)
  }

  const resetButton = (
    <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={reset}>
      <RotateCcw className="size-4" />
      重置
    </Button>
  )

  return (
    <Card className="p-4 flex flex-col gap-4">
      <ScopeSelect
        scopeOptions={scopeOptions}
        filters={filters}
        showStoreCount
        trailing={periodKind === "none" ? resetButton : undefined}
      />
      {period?.kind === "range" && <RangeRow filters={filters} period={period} trailing={resetButton} />}
      {period?.kind === "month" && (
        <MonthRow filters={filters} month={period.month} today={today} trailing={resetButton} />
      )}
    </Card>
  )
}

type UrlFilters = ReturnType<typeof useUrlFilters>

function RangeRow({
  filters,
  period,
  trailing,
}: {
  filters: UrlFilters
  period: Extract<ReportPeriod, { kind: "range" }>
  trailing: ReactNode
}) {
  const { get, setMany } = filters
  const requestedCustom = get("period") === "custom"
  // 自定义以 URL 原值回显（用户正在输入的中间态），其余预设以服务端生效值为准
  const activePreset: ReportRangePreset = requestedCustom ? "custom" : period.preset
  const start = requestedCustom ? get("start") : period.current.start
  const end = requestedCustom ? get("end") : period.current.end
  const customInvalid = requestedCustom && period.preset !== "custom"

  function onPreset(key: ReportRangePreset) {
    // 切到自定义时用当前生效区间预填，避免出现「按钮是自定义、数据却回落上月」的空窗
    if (key === "custom") setMany({ period: "custom", start: period.current.start, end: period.current.end })
    else setMany({ period: key, start: "", end: "" })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-[var(--muted-foreground)] mr-1">时间</span>
      {REPORT_RANGE_PRESETS.map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={activePreset === key}
          onClick={() => onPreset(key)}
          className={cn(
            "px-3 py-1.5 text-sm rounded-[var(--radius)] border transition-colors",
            activePreset === key
              ? "border-[var(--primary)] text-[var(--primary)] bg-[#FFF0EE]"
              : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
          )}
        >
          {REPORT_RANGE_PRESET_LABELS[key]}
        </button>
      ))}
      {activePreset === "custom" ? (
        <div className="flex items-center gap-2">
          <DatePicker
            className="w-40"
            aria-label="开始日期"
            value={start}
            max={end || undefined}
            onValueChange={(value) => setMany({ period: "custom", start: value })}
          />
          <span className="text-[var(--muted-foreground)]">~</span>
          <DatePicker
            className="w-40"
            aria-label="结束日期"
            value={end}
            min={start || undefined}
            onValueChange={(value) => setMany({ period: "custom", end: value })}
          />
          {customInvalid && (
            <span className="text-xs text-[#D94040]">
              区间不完整、无效或超过 {MAX_CUSTOM_RANGE_DAYS} 天，当前按{REPORT_RANGE_PRESET_LABELS[period.preset]}显示
            </span>
          )}
        </div>
      ) : (
        <span className="text-sm text-[var(--muted-foreground)]" data-testid="report-range-text">
          {period.current.start} ~ {period.current.end}
        </span>
      )}
      {trailing}
    </div>
  )
}

function MonthRow({
  filters,
  month,
  today,
  trailing,
}: {
  filters: UrlFilters
  month: string
  today: string
  trailing: ReactNode
}) {
  const { setMany } = filters
  const options = reportMonthOptions(today, month)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-[var(--muted-foreground)] mr-1">月份</span>
      <Select
        className="w-40"
        aria-label="月份"
        value={month}
        onChange={(e) => setMany({ month: e.target.value })}
      >
        {options.map((option) => (
          <SelectOption key={option} value={option}>
            {formatMonth(option)}
          </SelectOption>
        ))}
      </Select>
      {trailing}
    </div>
  )
}
