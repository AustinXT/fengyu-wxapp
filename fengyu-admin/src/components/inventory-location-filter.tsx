'use client'

import { useMemo } from 'react'
import type { InventoryLocationFilterOptions } from '@/lib/inventory/types'
import { Select } from '@/components/ui/select'

export default function InventoryLocationFilter({
  options,
  value,
  onChange,
  headquartersClassName = 'w-40',
  storeClassName = 'w-40',
}: {
  options: InventoryLocationFilterOptions
  value: string | null
  onChange: (locationId: string) => void
  headquartersClassName?: string
  storeClassName?: string
}) {
  const selectedHeadquarters = options.headquarters.find((location) => location.locationId === value)
  const selectedMarket = useMemo(() => options.markets.find((market) => (
    market.locationId === value || market.stores.some((store) => store.locationId === value)
  )), [options.markets, value])
  const primaryValue = selectedHeadquarters?.locationId ?? selectedMarket?.locationId ?? ''
  const hasOptions = options.headquarters.length > 0 || options.markets.length > 0

  function selectPrimary(locationId: string) {
    const headquarters = options.headquarters.find((location) => location.locationId === locationId)
    if (headquarters) {
      onChange(headquarters.locationId)
      return
    }
    const market = options.markets.find((item) => item.locationId === locationId)
    const nextLocationId = market?.canSelectInventory
      ? market.locationId
      : market?.stores[0]?.locationId
    if (nextLocationId) onChange(nextLocationId)
  }

  return (
    <>
      <Select
        value={primaryValue}
        onChange={(event) => selectPrimary(event.target.value)}
        className={headquartersClassName}
        disabled={!hasOptions}
        aria-label="库存市场层级"
      >
        {!hasOptions && <option value="">暂无可用库存主体</option>}
        {options.headquarters.map((location) => (
          <option key={location.locationId} value={location.locationId}>总部（供应链）</option>
        ))}
        {options.markets.map((market) => (
          <option key={market.locationId} value={market.locationId}>{market.name}</option>
        ))}
      </Select>

      <Select
        value={selectedHeadquarters ? selectedHeadquarters.locationId : (value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        className={storeClassName}
        disabled={Boolean(selectedHeadquarters) || !selectedMarket}
        aria-label="库存门店层级"
      >
        {selectedHeadquarters ? (
          <option value={selectedHeadquarters.locationId}>供应链库存</option>
        ) : selectedMarket ? (
          <>
            {selectedMarket.canSelectInventory && (
              <option value={selectedMarket.locationId}>该市场库存</option>
            )}
            {selectedMarket.stores.map((store) => (
              <option key={store.locationId} value={store.locationId}>{store.name}</option>
            ))}
          </>
        ) : (
          <option value="">请先选择市场</option>
        )}
      </Select>
    </>
  )
}
