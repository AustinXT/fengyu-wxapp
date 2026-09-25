"use client"

import { useMemo, type ReactNode } from "react"
import { Select, SelectOption } from "@/components/ui/select"
import type { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseScope } from "@/lib/data-center/params"
import type { DataCenterScopeOptions } from "@/lib/data-center/types"
import { findInactiveScopeStore, isScopeLocked, scopeStores, visibleScopeStores } from "@/lib/data-center/scope-options"

/**
 * 数据中心范围选择（授权汇总 + 市场/门店级联），板块页 ScopeTimeFilter 与经营明细报表 ReportFilter 共用。
 * 状态写 URL 的 `scope` / `scopeId`（与全站 useUrlFilters 一致）。
 *
 * @param filters        父级筛选器的 useUrlFilters 实例。⚠️ 必须由父级传入、整张筛选卡片只用一个实例：
 *                       每个实例各有一份 paramsRef，两个实例在一次服务端往返内先后写 URL，后写的会用
 *                       旧参数把前一次改动覆盖掉（先点「本周」再立刻选市场，「本周」被悄悄撤销）。
 * @param showStoreCount 在下拉旁显示「共 N 家门店」（报表页用；原型的数据权限横幅本期只保留这一项）
 * @param trailing       同一行右侧的附加控件（如报表页「重置」）
 */
export function ScopeSelect({
  scopeOptions,
  filters,
  showStoreCount = false,
  trailing,
}: {
  scopeOptions: DataCenterScopeOptions
  filters: Pick<ReturnType<typeof useUrlFilters>, "get" | "setMany">
  showStoreCount?: boolean
  trailing?: ReactNode
}) {
  const { get, setMany } = filters
  const { topLevel, markets } = scopeOptions

  const scope = get("scope")
  const scopeId = get("scopeId")
  const visibleStoreCount = useMemo(() => visibleScopeStores(scopeOptions).length, [scopeOptions])
  const canAggregateAuthorized = topLevel !== "all" && visibleStoreCount > 1
  // 只有一个可选范围才锁（单店账号 / 只授权一个无门店市场的账号）；单店 + 无门店市场的账号要能切到那个市场（#399）
  const scopeLocked = useMemo(() => isScopeLocked(scopeOptions), [scopeOptions])

  // URL 选中的已停用门店（#293）：页面主体渲染空态，下拉同步回显「XX（已停用）」，别显示成「全部门店」自相矛盾
  const inactiveStore = useMemo(
    () => findInactiveScopeStore(scopeOptions, parseScope({ scope, scopeId })),
    [scopeOptions, scope, scopeId],
  )

  // 从 URL 推导当前选中的市场/门店
  const selectedMarketId = useMemo(() => {
    if (scope === "market") return scopeId
    if (scope === "store") {
      const marketId = markets.find((m) => m.stores.some((s) => s.storeId === scopeId))?.id ?? inactiveStore?.marketId
      return marketId && markets.some((m) => m.id === marketId) ? marketId : ""
    }
    return ""
  }, [scope, scopeId, markets, inactiveStore])
  const selectedStoreId = scope === "store" ? scopeId : ""

  const storesOfMarket = useMemo(
    () => markets.find((m) => m.id === selectedMarketId)?.stores ?? [],
    [markets, selectedMarketId],
  )
  // 停用门店只作为当前值回显（disabled，不可再选中）；市场不在数据源时两个下拉都回显不出，由页面空态说明
  const showInactiveOption = inactiveStore !== null && selectedMarketId !== "" && inactiveStore.marketId === selectedMarketId
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
        {showInactiveOption && (
          <SelectOption value={inactiveStore.storeId} disabled>
            {inactiveStore.storeName}（已停用）
          </SelectOption>
        )}
      </Select>
      {showStoreCount && !inactiveStore && (
        <span className="text-sm text-[var(--muted-foreground)]" data-testid="scope-store-count">
          共 {scopedStoreCount} 家门店
        </span>
      )}
      {trailing}
    </div>
  )
}
