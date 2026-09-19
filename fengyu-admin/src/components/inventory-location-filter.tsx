'use client'

import { useMemo } from 'react'
import type { InventoryLocationFilterOptions } from '@/lib/inventory/types'
import { Select } from '@/components/ui/select'

/**
 * 候选唯一时不渲染下拉，只展示当前主体（#189）。
 *
 * 供应链角色只看得到总部一个主体，门店角色只看得到自家店 —— 给一个永远只有一项
 * 的下拉，用户点开只会看到自己已经选中的那一项。这里按**候选数**判定而不是按
 * 层级判定：`org_nodes` 没有「总部唯一」的约束，写死层级会在建第二个总部那天选错。
 *
 * 与办理台的 `SubjectSelect` 不同，这里不需要补 onChange：库存查询页的
 * `selectedLocationId` 由服务端 `resolveInventoryFilterLocationId()` 解析后下发，
 * 唯一候选时它本来就已经是那个值。
 */
function FixedLocation({ label, locationId }: { label: string; locationId: string }) {
  return (
    <div className="flex h-10 items-center text-sm" data-fixed-location={locationId}>
      {label}
    </div>
  )
}

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
  const solePrimary = options.headquarters.length + options.markets.length === 1
    ? (options.headquarters[0]
      ? { locationId: options.headquarters[0].locationId, name: '总部（供应链）' }
      : { locationId: options.markets[0].locationId, name: options.markets[0].name })
    : null
  // 二级候选：总部只有「供应链库存」自己；市场下是（可选的市场本级）+ 门店。
  const secondaryOptions = selectedHeadquarters
    ? [{ locationId: selectedHeadquarters.locationId, name: '供应链库存' }]
    : selectedMarket
      ? [
        ...(selectedMarket.canSelectInventory
          ? [{ locationId: selectedMarket.locationId, name: '该市场库存' }]
          : []),
        ...selectedMarket.stores,
      ]
      : []
  const soleSecondary = secondaryOptions.length === 1 ? secondaryOptions[0] : null

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
      {solePrimary && primaryValue === solePrimary.locationId ? (
        <FixedLocation label={solePrimary.name} locationId={solePrimary.locationId} />
      ) : (
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
      )}

      {soleSecondary && (value ?? '') === soleSecondary.locationId ? (
        <FixedLocation label={soleSecondary.name} locationId={soleSecondary.locationId} />
      ) : (
        <Select
          value={selectedHeadquarters ? selectedHeadquarters.locationId : (value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          className={storeClassName}
          disabled={Boolean(selectedHeadquarters) || !selectedMarket}
          aria-label="库存门店层级"
        >
          {secondaryOptions.length > 0 ? (
            secondaryOptions.map((location) => (
              <option key={location.locationId} value={location.locationId}>{location.name}</option>
            ))
          ) : (
            <option value="">请先选择市场</option>
          )}
        </Select>
      )}
    </>
  )
}
