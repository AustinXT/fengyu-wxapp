"use client"

import { useMemo } from "react"
import { Card } from "@/components/ui/card"
import { Select, SelectOption } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"
import { cn } from "@/lib/utils"

const PRESETS = [
  { key: "today", label: "今日" },
  { key: "week", label: "本周" },
  { key: "month", label: "本月" },
  { key: "year", label: "今年" },
  { key: "custom", label: "自定义" },
] as const


export function ScopeTimeFilter({ scopeOptions }: { scopeOptions: DataCenterScopeOptions }) {
  const { get, setMany } = useUrlFilters()
  const { topLevel, markets } = scopeOptions

  const scope = get("scope")
  const scopeId = get("scopeId")
  const preset = get("preset") || "month"
  const cmpOn = get("cmp") !== "0"

  
  const selectedMarketId = useMemo(() => {
    if (scope === "market") return scopeId
    if (scope === "store") {
      return markets.find((m) => m.stores.some((s) => s.storeId === scopeId))?.id ?? ""
    }
    return ""
  }, [scope, scopeId, markets])
  const selectedStoreId = scope === "store" ? scopeId : ""

  const storesOfMarket = useMemo(
    () => markets.find((m) => m.id === selectedMarketId)?.stores ?? [],
    [markets, selectedMarketId],
  )

  function onMarketChange(mid: string) {
    if (!mid) {
      setMany({ scope: "", scopeId: "" }) 
    } else {
      setMany({ scope: "market", scopeId: mid }) 
    }
  }
  function onStoreChange(sid: string) {
    if (!sid) {
      
      setMany(selectedMarketId ? { scope: "market", scopeId: selectedMarketId } : { scope: "", scopeId: "" })
    } else {
      setMany({ scope: "store", scopeId: sid })
    }
  }
  function onPreset(key: string) {
    if (key === "custom") setMany({ preset: "custom" })
    else setMany({ preset: key, start: "", end: "" })
  }

  return (
    <Card className="p-4 flex flex-col gap-4">
      {}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-[var(--muted-foreground)]">范围</span>
        <Select
          className="w-40"
          value={selectedMarketId}
          disabled={topLevel === "store"}
          onChange={(e) => onMarketChange(e.target.value)}
        >
          {topLevel === "all" && <SelectOption value="">全部市场</SelectOption>}
          {markets.map((m) => (
            <SelectOption key={m.id} value={m.id}>
              {m.name}
            </SelectOption>
          ))}
        </Select>
        <Select
          className="w-40"
          value={selectedStoreId}
          disabled={topLevel === "store" || !selectedMarketId}
          onChange={(e) => onStoreChange(e.target.value)}
        >
          <SelectOption value="">全部门店</SelectOption>
          {storesOfMarket.map((s) => (
            <SelectOption key={s.storeId} value={s.storeId}>
              {s.storeName}
            </SelectOption>
          ))}
        </Select>
      </div>

      {}
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
            <Input
              type="date"
              className="w-40"
              value={get("start")}
              onChange={(e) => setMany({ start: e.target.value })}
            />
            <span className="text-[var(--muted-foreground)]">~</span>
            <Input
              type="date"
              className="w-40"
              value={get("end")}
              onChange={(e) => setMany({ end: e.target.value })}
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
