"use client"

import { Card } from "@/components/ui/card"
import { DatePicker } from "@/components/ui/date-picker"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"
import { cn } from "@/lib/utils"
import { ScopeSelect } from "./scope-select"

const PRESETS = [
  { key: "today", label: "今日" },
  { key: "week", label: "本周" },
  { key: "month", label: "本月" },
  { key: "year", label: "今年" },
  { key: "custom", label: "自定义" },
] as const

/**
 * 数据中心公共筛选器（4 板块共用）：授权汇总 + 市场/门店级联 + 时间维度 + 同比/环比开关。
 * 状态全部写 URL searchParams（与全站 useUrlFilters 一致），板块组件从 URL 读取并取数。
 * 范围部分与经营明细报表的 ReportFilter 共用 ScopeSelect。
 */
export function ScopeTimeFilter({ scopeOptions }: { scopeOptions: DataCenterScopeOptions }) {
  const filters = useUrlFilters()
  const { get, setMany } = filters

  const preset = get("preset") || "month"
  const cmpOn = get("cmp") !== "0"

  function onPreset(key: string) {
    if (key === "custom") setMany({ preset: "custom" })
    else setMany({ preset: key, start: "", end: "" })
  }

  return (
    <Card className="p-4 flex flex-col gap-4">
      {/* scope 三级 */}
      <ScopeSelect scopeOptions={scopeOptions} filters={filters} />

      {/* 时间维度 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-[var(--muted-foreground)] mr-1">时间</span>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onPreset(p.key)}
            className={cn(
              "px-3 py-1.5 text-sm rounded-[var(--radius)] border transition-colors",
              preset === p.key
                ? "border-[var(--primary)] text-[var(--primary)] bg-[#FFF0EE]"
                : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
            )}
          >
            {p.label}
          </button>
        ))}
        {preset === "custom" && (
          <div className="flex items-center gap-2">
            <DatePicker
              className="w-40"
              value={get("start")}
              onValueChange={(value) => setMany({ start: value })}
            />
            <span className="text-[var(--muted-foreground)]">~</span>
            <DatePicker
              className="w-40"
              value={get("end")}
              onValueChange={(value) => setMany({ end: value })}
            />
          </div>
        )}
        <label className="flex items-center gap-1.5 ml-auto text-sm text-[var(--muted-foreground)] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={cmpOn}
            onChange={(e) => setMany({ cmp: e.target.checked ? "" : "0" })}
          />
          显示同比/环比
        </label>
      </div>
    </Card>
  )
}
