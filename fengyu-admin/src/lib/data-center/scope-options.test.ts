import { describe, expect, it } from 'vitest'
import { resolveDefaultDataCenterScope, visibleScopeStores } from './scope-options'
import type { DataCenterScopeOptions } from './types'

const multiStoreOptions: DataCenterScopeOptions = {
  topLevel: 'store',
  markets: [
    {
      id: 'M1',
      name: '南昌市场',
      stores: [
        { storeId: 'S1', storeName: '门店一' },
        { storeId: 'S2', storeName: '门店二' },
      ],
    },
    {
      id: 'M2',
      name: '九江市场',
      stores: [{ storeId: 'S3', storeName: '门店三' }],
    },
  ],
}

describe('resolveDefaultDataCenterScope', () => {
  it('总部账号默认全部市场', () => {
    expect(resolveDefaultDataCenterScope({ ...multiStoreOptions, topLevel: 'all' })).toEqual({
      type: 'all',
    })
  })

  it('多店账号默认全部授权门店', () => {
    expect(resolveDefaultDataCenterScope(multiStoreOptions)).toEqual({ type: 'authorized' })
  })

  it('单店账号默认具体门店', () => {
    expect(resolveDefaultDataCenterScope({
      topLevel: 'store',
      markets: [{ id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '门店一' }] }],
    })).toEqual({ type: 'store', id: 'S1' })
  })

  it('非总部无可见在营门店时返回 null', () => {
    expect(resolveDefaultDataCenterScope({
      topLevel: 'market',
      markets: [{ id: 'M1', name: '南昌市场', stores: [] }],
    })).toBeNull()
  })

  it('可见门店按 storeId 去重', () => {
    const duplicated: DataCenterScopeOptions = {
      ...multiStoreOptions,
      markets: [
        ...multiStoreOptions.markets,
        { id: 'M3', name: '重复市场', stores: [{ storeId: 'S1', storeName: '门店一' }] },
      ],
    }
    expect(visibleScopeStores(duplicated).map((store) => store.storeId)).toEqual(['S1', 'S2', 'S3'])
  })
})
