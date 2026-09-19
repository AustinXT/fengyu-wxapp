'use client'

import { useMemo } from 'react'
import type { InventoryLocationFilterOptions } from '@/lib/inventory/types'
import { Select } from '@/components/ui/select'

interface FilterLevelOption {
  locationId: string
  name: string
}

/**
 * 候选唯一的层级不渲染下拉，只展示当前主体（#189）。
 *
 * 供应链角色只看得到总部一个主体，门店角色只看得到自家店 —— 给一个永远只有一项
 * 的下拉，用户点开只会看到自己已经选中的那一项。这里按**候选数**判定而不是按
 * 层级判定：`org_nodes` 没有「总部唯一」的约束，写死层级会在建第二个总部那天选错。
 *
 * 与办理台的 `InventorySubjectSelect` 不同，这里不需要补 onChange：库存查询页的
 * `selectedLocationId` 由服务端 `resolveInventoryFilterLocationId()` 解析后下发，
 * 唯一候选时它本来就已经是那个值。属性名沿用 `data-fixed-subject`，让 E2E 的
 * `selectByLabel` 与 UX 扫描一套选择器通吃两处。
 */
function FixedLevel({
  option,
  ariaLabel,
  className,
}: {
  option: FilterLevelOption
  ariaLabel: string
  className: string
}) {
  return (
    <output
      className={`block h-10 truncate px-3 text-sm leading-10 ${className}`}
      aria-label={ariaLabel}
      data-fixed-subject={option.locationId}
      title={option.name}
    >
      {option.name}
    </output>
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

  // 一级：总部（统一显示为「总部（供应链）」）+ 各市场。
  const primaryOptions: FilterLevelOption[] = [
    ...options.headquarters.map((location) => ({ locationId: location.locationId, name: '总部（供应链）' })),
    ...options.markets.map((market) => ({ locationId: market.locationId, name: market.name })),
  ]
  // 二级：总部层级只有「供应链库存」自己；市场层级是（可选的）市场本级 + 其门店。
  const secondaryOptions: FilterLevelOption[] = selectedHeadquarters
    ? [{ locationId: selectedHeadquarters.locationId, name: '供应链库存' }]
    : selectedMarket
      ? [
        ...(selectedMarket.canSelectInventory
          ? [{ locationId: selectedMarket.locationId, name: '该市场库存' }]
          : []),
        ...selectedMarket.stores,
      ]
      : []

  const solePrimary = primaryOptions.length === 1 ? primaryOptions[0] : null
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
      {/*
        兜底带上 `!value`：`primaryValue` 是从选中的总部/市场反查出来的，调用方若传
        value=null（生产路径上 `resolveInventoryFilterLocationId()` 会保证非空，但这里
        不赖它），它会退回 ''，唯一候选就又变回「1 个选项还要你点」。而值为空时实际
        查询走的就是服务端解析出的那个唯一候选，只读展示它不会说谎。
      */}
      {solePrimary && (primaryValue === solePrimary.locationId || !value) ? (
        <FixedLevel option={solePrimary} ariaLabel="库存市场层级" className={headquartersClassName} />
      ) : (
        <Select
          value={primaryValue}
          onChange={(event) => selectPrimary(event.target.value)}
          className={headquartersClassName}
          disabled={primaryOptions.length === 0}
          aria-label="库存市场层级"
        >
          {primaryOptions.length === 0 && <option value="">暂无可用库存主体</option>}
          {primaryOptions.map((option) => (
            <option key={option.locationId} value={option.locationId}>{option.name}</option>
          ))}
        </Select>
      )}

      {soleSecondary && (value ?? '') === soleSecondary.locationId ? (
        <FixedLevel option={soleSecondary} ariaLabel="库存门店层级" className={storeClassName} />
      ) : (
        <Select
          value={selectedHeadquarters ? selectedHeadquarters.locationId : (value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          className={storeClassName}
          disabled={Boolean(selectedHeadquarters) || !selectedMarket}
          aria-label="库存门店层级"
        >
          {secondaryOptions.length > 0 ? (
            secondaryOptions.map((option) => (
              <option key={option.locationId} value={option.locationId}>{option.name}</option>
            ))
          ) : (
            <option value="">请先选择市场</option>
          )}
        </Select>
      )}
    </>
  )
}
