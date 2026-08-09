"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, X } from "lucide-react"
import type { AnalystScope, AnalystScopeOptions } from "@/lib/analyst-scope"
import { cn } from "@/lib/utils"

interface ScopeCascaderProps {
  options: AnalystScopeOptions
  value: AnalystScope
  className?: string
}

export function ScopeCascader({ options, value, className }: ScopeCascaderProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const scopeRef = useRef<HTMLInputElement>(null)
  const scopeIdRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)

  const selectedMarketId = useMemo(() => {
    if (value.type === "market") return value.id
    if (value.type === "store") {
      return options.markets.find((market) => market.stores.some((store) => store.storeId === value.id))?.id ?? ""
    }
    return ""
  }, [options.markets, value])

  const selectedStoreId = value.type === "store" ? value.id : ""
  const [activeMarketId, setActiveMarketId] = useState(selectedMarketId)

  useEffect(() => {
    setActiveMarketId(selectedMarketId)
  }, [selectedMarketId])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("pointerdown", handlePointerDown)
    return () => document.removeEventListener("pointerdown", handlePointerDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", handleKey)
    return () => document.removeEventListener("keydown", handleKey)
  }, [open])

  const activeMarket = options.markets.find((market) => market.id === activeMarketId)
  const selectedMarket = options.markets.find((market) => market.id === selectedMarketId)
  const selectedStore = selectedMarket?.stores.find((store) => store.storeId === selectedStoreId)
  const canSelectAll = options.topLevel === "all"

  const display =
    value.type === "all"
      ? "全部市场门店"
      : value.type === "market"
        ? selectedMarket?.name ?? "未知市场"
        : selectedStore
          ? `${selectedMarket?.name ?? "未知市场"} / ${selectedStore.storeName}`
          : "未知门店"

  function commit(next: AnalystScope) {
    const form = scopeRef.current?.form
    if (scopeRef.current) scopeRef.current.value = next.type
    if (scopeIdRef.current) scopeIdRef.current.value = next.type === "all" ? "" : next.id
    setOpen(false)
    form?.requestSubmit()
  }

  function toggle() {
    if (open) {
      setOpen(false)
    } else {
      setActiveMarketId(selectedMarketId)
      setOpen(true)
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <input type="hidden" name="scope" ref={scopeRef} defaultValue={value.type} />
      <input type="hidden" name="scopeId" ref={scopeIdRef} defaultValue={value.type === "all" ? "" : value.id} />

      <button
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-md border border-[var(--input)] bg-white px-3 text-sm outline-none transition-colors hover:border-[var(--ring)] focus:border-[var(--ring)]"
      >
        <span className="truncate text-left">{display}</span>
        <span className="flex shrink-0 items-center gap-1 text-neutral-400">
          {value.type !== "all" && canSelectAll ? (
            <X
              className="size-3.5 hover:text-neutral-700"
              onClick={(event) => {
                event.stopPropagation()
                commit({ type: "all" })
              }}
              role="button"
              aria-label="清除组织范围"
            />
          ) : null}
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </span>
      </button>

      {open ? (
        <div
          className="absolute left-0 z-50 mt-1 flex max-h-80 min-w-[22rem] gap-2 rounded-md border border-[var(--border)] bg-white p-2 shadow-lg"
          role="listbox"
        >
          <div className="flex-1 space-y-0.5 overflow-y-auto">
            {canSelectAll ? (
              <ScopeItem
                label="全部市场"
                selected={value.type === "all"}
                onClick={() => commit({ type: "all" })}
              />
            ) : null}
            {options.markets.map((market) => (
              <ScopeItem
                key={market.id}
                label={market.name}
                selected={activeMarketId === market.id}
                onClick={() => setActiveMarketId(market.id)}
                onDoubleClick={() => commit({ type: "market", id: market.id })}
              />
            ))}
          </div>

          <div className="flex-1 space-y-0.5 overflow-y-auto border-l border-[var(--border)] pl-2">
            <ScopeItem
              label={activeMarket ? "全部门店" : "请先选市场"}
              disabled={!activeMarket}
              selected={value.type === "market" && value.id === activeMarketId}
              onClick={() => activeMarket && commit({ type: "market", id: activeMarket.id })}
            />
            {activeMarket?.stores.map((store) => (
              <ScopeItem
                key={store.storeId}
                label={store.storeName}
                selected={value.type === "store" && value.id === store.storeId}
                onClick={() => commit({ type: "store", id: store.storeId })}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ScopeItem({
  label,
  selected,
  disabled,
  onClick,
  onDoubleClick,
}: {
  label: string
  selected?: boolean
  disabled?: boolean
  onClick?: () => void
  onDoubleClick?: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        "flex h-8 w-full items-center justify-between gap-2 rounded px-2 text-left text-sm",
        disabled
          ? "cursor-not-allowed text-neutral-300"
          : selected
            ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
            : "text-neutral-700 hover:bg-neutral-50",
      )}
    >
      <span className="truncate">{label}</span>
      {selected && !disabled ? <Check className="size-3.5 shrink-0" /> : null}
    </button>
  )
}
