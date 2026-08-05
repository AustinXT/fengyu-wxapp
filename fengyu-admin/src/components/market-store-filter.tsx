"use client"

import { useMemo } from "react"
import { Select } from "@/components/ui/select"
import type { MarketStoreFilterOptions } from "@/lib/market-store-filter-types"

interface Props {
  options: MarketStoreFilterOptions
  marketValue: string
  storeValue: string
  onMarketChange: (value: string) => void
  onStoreChange: (value: string) => void
  marketClassName?: string
  storeClassName?: string
  withLabels?: boolean
}

export default function MarketStoreFilter({
  options,
  marketValue,
  storeValue,
  onMarketChange,
  onStoreChange,
  marketClassName = "w-32",
  storeClassName = "w-40",
  withLabels = false,
}: Props) {
  const stores = useMemo(() => {
    if (!marketValue) return options.stores
    return options.stores.filter((s) => s.marketId === marketValue)
  }, [marketValue, options.stores])

  const marketSelect = (
    <Select
      value={marketValue}
      onChange={(e) => onMarketChange(e.target.value)}
      className={marketClassName}
    >
      <option value="">全部市场</option>
      {options.markets.map((m) => (
        <option key={m.marketId} value={m.marketId}>
          {m.marketName}
        </option>
      ))}
    </Select>
  )

  const storeSelect = (
    <Select
      value={storeValue}
      onChange={(e) => onStoreChange(e.target.value)}
      className={storeClassName}
    >
      <option value="">全部门店</option>
      {stores.map((s) => (
        <option key={s.storeId} value={s.storeId}>
          {s.storeName}
        </option>
      ))}
    </Select>
  )

  if (!withLabels) {
    return (
      <>
        {marketSelect}
        {storeSelect}
      </>
    )
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[#666666]">市场</span>
        {marketSelect}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[#666666]">门店</span>
        {storeSelect}
      </div>
    </>
  )
}
