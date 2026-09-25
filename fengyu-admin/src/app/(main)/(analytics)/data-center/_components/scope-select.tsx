"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { useUrlFilters } from "@/lib/hooks/use-url-filters"
import { parseScope, scopeFromStoreIds, scopeToParams } from "@/lib/data-center/params"
import type { DataCenterScope, DataCenterScopeOptions } from "@/lib/data-center/types"
import {
  canonicalizeScope,
  findInactiveScopeStore,
  inactiveStoresInScope,
  isScopeLocked,
  scopeLabel,
  scopeStores,
  visibleScopeStores,
} from "@/lib/data-center/scope-options"

/**
 * 数据中心范围选择（#376 起为门店多选），板块页 ScopeTimeFilter 与经营明细报表 ReportFilter 共用。
 * 状态写 URL 的 `scope` / `scopeId`（与全站 useUrlFilters 一致）。
 *
 * 下拉面板：门店搜索 +「全选（当前权限范围）」+ 按市场分组的门店勾选（市场标题可整组勾选）。
 * 「确定」时把勾选的门店集合经 `canonicalizeScope` 规范化再写 URL：全选 → all / authorized，
 * 恰好勾满一个市场 → market，1 家 → store，其余 → stores（`scopeId` 为升序逗号串）。
 * 直接授权的无门店市场（如品项公司，#399）没有门店可勾，作为单选项列在分组末尾，点即切到该市场。
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
  const scopeParam = get("scope")
  const scopeIdParam = get("scopeId")
  const scope = useMemo(() => parseScope({ scope: scopeParam, scopeId: scopeIdParam }), [scopeParam, scopeIdParam])

  // 只有一个可选范围才锁（单店账号 / 只授权一个无门店市场的账号，#399）
  const scopeLocked = useMemo(() => isScopeLocked(scopeOptions), [scopeOptions])
  // URL 选中的已停用门店（#293；多店则全部停用）：页面主体渲染空态，按钮同步回显「XX（已停用）」
  const inactiveStore = useMemo(() => findInactiveScopeStore(scopeOptions, scope), [scopeOptions, scope])
  // 多店里部分停用（#376 拍板）：照常取数、只算在营部分，这里提示
  const partiallyInactive = useMemo(() => inactiveStoresInScope(scopeOptions, scope), [scopeOptions, scope])
  const scopedStoreCount = useMemo(() => scopeStores(scopeOptions, scope).length, [scopeOptions, scope])

  const buttonLabel = inactiveStore ? `${inactiveStore.storeName}（已停用）` : scopeLabel(scopeOptions, scope)

  function apply(next: DataCenterScope) {
    const params = scopeToParams(canonicalizeScope(scopeOptions, next))
    setMany({ scope: params.scope ?? "", scopeId: params.scopeId ?? "" })
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-[var(--muted-foreground)]">范围</span>
      <ScopePicker
        scopeOptions={scopeOptions}
        scope={scope}
        label={buttonLabel}
        disabled={scopeLocked}
        onApply={apply}
      />
      {showStoreCount && !inactiveStore && (
        <span className="text-sm text-[var(--muted-foreground)]" data-testid="scope-store-count">
          共 {scopedStoreCount} 家门店
        </span>
      )}
      {partiallyInactive.length > 0 && (
        <span className="text-sm text-[var(--muted-foreground)]" data-testid="scope-inactive-notice">
          所选门店中 {partiallyInactive.length} 家已停用（{partiallyInactive.map((s) => s.storeName).join("、")}），不计入统计
        </span>
      )}
      {trailing}
    </div>
  )
}

/** 当前范围对应的勾选集合（面板打开时的初值）：只含可见在营门店，停用门店不再回填 */
function initialSelection(scopeOptions: DataCenterScopeOptions, scope: DataCenterScope): Set<string> {
  return new Set(scopeStores(scopeOptions, scope).map((store) => store.storeId))
}

function ScopePicker({
  scopeOptions,
  scope,
  label,
  disabled,
  onApply,
}: {
  scopeOptions: DataCenterScopeOptions
  scope: DataCenterScope
  label: string
  disabled: boolean
  onApply: (scope: DataCenterScope) => void
}) {
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState("")
  const [draft, setDraft] = useState<Set<string>>(() => new Set())
  const containerRef = useRef<HTMLDivElement>(null)

  const allStoreIds = useMemo(() => visibleScopeStores(scopeOptions).map((s) => s.storeId), [scopeOptions])
  const storeMarkets = useMemo(() => scopeOptions.markets.filter((m) => m.stores.length > 0), [scopeOptions])
  // 直接授权的无门店市场（#399）：没有门店可勾，只能整体切到该市场
  const emptyMarkets = useMemo(
    () => scopeOptions.markets.filter((m) => m.stores.length === 0 && m.granted === true),
    [scopeOptions],
  )

  // 点击外部 / Escape 关闭（放弃未确定的勾选）
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  function toggleOpen() {
    if (disabled) return
    if (!open) {
      setDraft(initialSelection(scopeOptions, scope))
      setKeyword("")
    }
    setOpen(!open)
  }

  const kw = keyword.trim()
  const filteredMarkets = useMemo(() => {
    if (!kw) return storeMarkets
    return storeMarkets
      .map((m) => (m.name.includes(kw) ? m : { ...m, stores: m.stores.filter((s) => s.storeName.includes(kw)) }))
      .filter((m) => m.stores.length > 0)
  }, [storeMarkets, kw])
  const filteredEmptyMarkets = useMemo(
    () => (kw ? emptyMarkets.filter((m) => m.name.includes(kw)) : emptyMarkets),
    [emptyMarkets, kw],
  )

  function setMany(ids: readonly string[], checked: boolean) {
    setDraft((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function confirm() {
    const next = scopeFromStoreIds(Array.from(draft))
    if (!next) return
    onApply(next)
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={toggleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="scope-picker-trigger"
        className={cn(
          "flex h-10 w-64 items-center justify-between rounded-[var(--radius)] border border-[var(--input)] bg-[var(--background)] px-3 text-sm",
          "focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        <span className="truncate" title={label}>{label}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" className="ml-2 shrink-0 text-[var(--muted-foreground)]">
          <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="选择范围"
          className="absolute z-50 mt-1 w-80 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-md"
        >
          <div className="border-b border-[var(--border)] p-2">
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索门店 / 市场"
              aria-label="搜索门店"
              className="h-8 w-full rounded-[var(--radius)] border border-[var(--input)] bg-[var(--background)] px-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          <div className="max-h-[320px] overflow-y-auto py-1">
            {allStoreIds.length > 0 && !kw && (
              <CheckRow
                label="全选（当前权限范围）"
                state={checkState(allStoreIds, draft)}
                onChange={(checked) => setMany(allStoreIds, checked)}
                strong
              />
            )}
            {filteredMarkets.map((market) => {
              const ids = market.stores.map((s) => s.storeId)
              return (
                <div key={market.id} role="group" aria-label={market.name}>
                  <CheckRow
                    label={market.name}
                    state={checkState(ids, draft)}
                    onChange={(checked) => setMany(ids, checked)}
                    strong
                  />
                  {market.stores.map((store) => (
                    <CheckRow
                      key={store.storeId}
                      label={store.storeName}
                      state={draft.has(store.storeId) ? "checked" : "unchecked"}
                      onChange={(checked) => setMany([store.storeId], checked)}
                      indent
                    />
                  ))}
                </div>
              )
            })}
            {filteredEmptyMarkets.map((market) => (
              <button
                key={market.id}
                type="button"
                onClick={() => {
                  onApply({ type: "market", id: market.id })
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-[var(--accent)]",
                  scope.type === "market" && scope.id === market.id && "text-[#C0322A]",
                )}
              >
                <span className="truncate font-medium">{market.name}</span>
                <span className="shrink-0 text-xs text-[var(--muted-foreground)]">无门店 · 看锚定员工</span>
              </button>
            ))}
            {filteredMarkets.length === 0 && filteredEmptyMarkets.length === 0 && (
              <div className="px-3 py-2 text-sm text-[var(--muted-foreground)]">无匹配门店</div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2">
            <span className="text-xs text-[var(--muted-foreground)]" data-testid="scope-picker-count">
              已选 {draft.size} 家
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-8 rounded-[var(--radius)] border border-[var(--input)] px-3 text-sm hover:bg-[var(--accent)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={draft.size === 0}
                className="h-8 rounded-[var(--radius)] bg-[#C0322A] px-3 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type CheckState = "checked" | "unchecked" | "indeterminate"

function checkState(ids: readonly string[], selected: ReadonlySet<string>): CheckState {
  const n = ids.filter((id) => selected.has(id)).length
  if (n === 0) return "unchecked"
  return n === ids.length ? "checked" : "indeterminate"
}

function CheckRow({
  label,
  state,
  onChange,
  strong = false,
  indent = false,
}: {
  label: string
  state: CheckState
  onChange: (checked: boolean) => void
  strong?: boolean
  indent?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "indeterminate"
  }, [state])
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-sm hover:bg-[var(--accent)]",
        indent ? "pl-8" : "pl-3",
        strong && "font-medium",
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={state === "checked"}
        // 半选时点击 = 全勾（与常见树形多选一致）
        onChange={() => onChange(state !== "checked")}
        className="h-4 w-4 accent-[#C0322A]"
      />
      <span className="truncate">{label}</span>
    </label>
  )
}
