"use client"

import { useMemo, type ReactNode } from "react"
import { Select, SelectOption } from "@/components/ui/select"
import { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseScope } from "@/lib/data-center/params"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"
import { scopeStores, visibleScopeStores } from "@/lib/data-center/scope-options"

/**
 * 数据中心范围选择（授权汇总 + 市场/门店级联），板块页 ScopeTimeFilter 与经营明细报表 ReportFilter 共用。
 * 状态写 URL 的 `scope` / `scopeId`（与全站 useUrlFilters 一致）。
 *
 * @param showStoreCount 在下拉旁显示「共 N 家门店」（报表页用；原型的数据权限横幅本期只保留这一项）
 * @param trailing       同一行右侧的附加控件（如报表页「重置」）
 */
export function ScopeSelect({
  scopeOptions,
  showStoreCount = false,
  trailing,
}: {
  scopeOptions: DataCenterScopeOptions
  showStoreCount?: boolean
  trailing?: ReactNode
}) {
  const { get, setMany } = useUrlFilters()
  const { topLevel, markets } = scopeOptions

  const scope = get("scope")
  const scopeId = get("scopeId")
  const visibleStoreCount = useMemo(() => visibleScopeStores(scopeOptions).length, [scopeOptions])
  const canAggregateAuthorized = topLevel !== "all" && visibleStoreCount > 1
  const scopeLocked = topLevel !== "all" && visibleStoreCount <= 1

  // 从 URL 推导当前选中的市场/门店
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
  const scopedStoreCount = useMemo(
    () => scopeStores(scopeOptions, parseScope({ scope, scopeId })).length,
    [scopeOptions, scope, scopeId],
  )

  function onMarketChange(mid: string) {
    if (!mid) {
      setMany(
        topLevel === "all"
          ? { scope: "", scopeId: "" }
          : { scope: "authorized", scopeId: "" },
      )
    } else {
      setMany({ scope: "market", scopeId: mid }) // 选市场（清门店）
    }
  }
  function onStoreChange(sid: string) {
    if (!sid) {
      // 回到市场级
      setMany(selectedMarketId ? { scope: "market", scopeId: selectedMarketId } : { scope: "", scopeId: "" })
    } else {
      setMany({ scope: "store", scopeId: sid })
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-[var(--muted-foreground)]">范围</span>
      <Select
        className="w-40"
        value={selectedMarketId}
        disabled={scopeLocked}
        onChange={(e) => onMarketChange(e.target.value)}
      >
        {topLevel === "all" && <SelectOption value="">全部市场</SelectOption>}
        {canAggregateAuthorized && <SelectOption value="">全部授权门店</SelectOption>}
        {markets.map((m) => (
          <SelectOption key={m.id} value={m.id}>
            {m.name}
          </SelectOption>
        ))}
      </Select>
      <Select
        className="w-40"
        value={selectedStoreId}
        disabled={scopeLocked || !selectedMarketId}
        onChange={(e) => onStoreChange(e.target.value)}
      >
        <SelectOption value="">全部门店</SelectOption>
        {storesOfMarket.map((s) => (
          <SelectOption key={s.storeId} value={s.storeId}>
            {s.storeName}
          </SelectOption>
        ))}
      </Select>
      {showStoreCount && (
        <span className="text-sm text-[var(--muted-foreground)]" data-testid="scope-store-count">
          共 {scopedStoreCount} 家门店
        </span>
      )}
      {trailing}
    </div>
  )
}
