import { describe, expect, it } from 'vitest'
import type { InventoryLocationRow } from './types'
import {
  buildInventoryLocationFilterOptions,
  resolveInventoryFilterLocationId,
} from './location-filter'

const locations: InventoryLocationRow[] = [
  { locationId: 'HQ', locationType: '总部', name: '总部', orgNodeId: 'HQ', storeId: null, parentLocationId: null, isActive: true },
  { locationId: 'M1', locationType: '市场', name: '南昌市场', orgNodeId: 'M1', storeId: null, parentLocationId: 'HQ', isActive: true },
  { locationId: 'M2', locationType: '市场', name: '九江市场', orgNodeId: 'M2', storeId: null, parentLocationId: 'HQ', isActive: true },
  { locationId: 'S1', locationType: '门店', name: '红谷滩店', orgNodeId: 'N-S1', storeId: 'S1', parentLocationId: 'M1', isActive: true },
  { locationId: 'S2', locationType: '门店', name: '八一店', orgNodeId: 'N-S2', storeId: 'S2', parentLocationId: 'M1', isActive: true },
  { locationId: 'S3', locationType: '门店', name: '九江店', orgNodeId: 'N-S3', storeId: 'S3', parentLocationId: 'M2', isActive: true },
]

describe('库存主体筛选模型', () => {
  it('总部 scope 默认精确定位总部，同时保留市场和门店导航', () => {
    const options = buildInventoryLocationFilterOptions(locations, null)

    expect(options.defaultLocationId).toBe('HQ')
    expect(options.headquarters).toEqual([{ locationId: 'HQ', name: '总部' }])
    expect(options.markets).toHaveLength(2)
    expect(options.markets.every((market) => market.canSelectInventory)).toBe(true)
  })

  it('市场 scope 仅包含市场本级及其授权门店，不包含其他市场', () => {
    const options = buildInventoryLocationFilterOptions(locations, ['M1', 'S1', 'S2'])

    expect(options.defaultLocationId).toBe('M1')
    expect(options.headquarters).toEqual([])
    expect(options.markets).toEqual([{
      locationId: 'M1',
      name: '南昌市场',
      canSelectInventory: true,
      stores: [
        { locationId: 'S2', name: '八一店' },
        { locationId: 'S1', name: '红谷滩店' },
      ],
    }])
  })

  it('门店 scope 只允许精确选择门店，所属市场仅作为导航分组', () => {
    const options = buildInventoryLocationFilterOptions(locations, ['S1'])

    expect(options.defaultLocationId).toBe('S1')
    expect(options.markets).toEqual([{
      locationId: 'M1',
      name: '南昌市场',
      canSelectInventory: false,
      stores: [{ locationId: 'S1', name: '红谷滩店' }],
    }])
    expect(resolveInventoryFilterLocationId(options, 'M1')).toBe('S1')
    expect(resolveInventoryFilterLocationId(options, 'S3')).toBe('S1')
  })
})
