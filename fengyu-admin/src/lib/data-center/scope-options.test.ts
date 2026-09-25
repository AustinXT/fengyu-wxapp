import { describe, expect, it } from 'vitest'
import { findInactiveScopeStore, isScopeLocked, resolveDefaultDataCenterScope, selectableScopeCount, visibleScopeStores } from './scope-options'
import type { DataCenterScopeOptions } from './types'

const multiStoreOptions: DataCenterScopeOptions = {
  topLevel: 'store', inactiveStores: [],
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
      topLevel: 'store', inactiveStores: [],
      markets: [{ id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '门店一' }] }],
    })).toEqual({ type: 'store', id: 'S1' })
  })

  it('非总部无可见在营门店时返回 null', () => {
    expect(resolveDefaultDataCenterScope({
      topLevel: 'market', inactiveStores: [],
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

describe('findInactiveScopeStore（#293）', () => {
  const withInactive: DataCenterScopeOptions = {
    ...multiStoreOptions,
    inactiveStores: [{ storeId: 'X1', storeName: '九江中辉店', marketId: 'M2' }],
  }

  it('URL 选中权限内的已停用门店 → 命中', () => {
    expect(findInactiveScopeStore(withInactive, { type: 'store', id: 'X1' })).toEqual({
      storeId: 'X1', storeName: '九江中辉店', marketId: 'M2',
    })
  })

  it('在营门店（即使本期无业绩）不命中——空态只给停用门店，在营门店照常显示 0', () => {
    expect(findInactiveScopeStore(withInactive, { type: 'store', id: 'S3' })).toBeNull()
  })

  it('同一家同时出现在两份列表时以在营为准，不误判空态', () => {
    const both = { ...withInactive, inactiveStores: [{ storeId: 'S1', storeName: '门店一', marketId: 'M1' }] }
    expect(findInactiveScopeStore(both, { type: 'store', id: 'S1' })).toBeNull()
  })

  it('权限外 / 不存在的门店不命中（不泄露停用状态，交给原有越权处理）', () => {
    expect(findInactiveScopeStore(withInactive, { type: 'store', id: 'OTHER' })).toBeNull()
  })

  it.each([
    { type: 'all' as const },
    { type: 'authorized' as const },
    { type: 'market' as const, id: 'M2' },
  ])('非门店范围（%o）不判：市场下没有在营门店也可能有锚定市场员工的数据', (scope) => {
    expect(findInactiveScopeStore(withInactive, scope)).toBeNull()
  })

})

describe('#399 无门店市场账号', () => {
  const px = { id: 'PX', name: '品项公司', stores: [], granted: true }
  const px2 = { id: 'PX2', name: '另一无门店市场', stores: [], granted: true }
  const ancestor = { id: 'M1', name: '南昌市场', stores: [], granted: false } // 店长唯一门店被停用时的祖先市场
  const oneStore = { id: 'M1', name: '南昌市场', stores: [{ storeId: 'S1', storeName: '门店一' }], granted: false }
  const opts = (markets: DataCenterScopeOptions['markets']): DataCenterScopeOptions => ({ topLevel: 'market', inactiveStores: [], markets })

  it('只授权一个无门店市场：默认落到该市场、锁定', () => {
    expect(resolveDefaultDataCenterScope(opts([px]))).toEqual({ type: 'market', id: 'PX' })
    expect(selectableScopeCount(opts([px]))).toBe(1)
    expect(isScopeLocked(opts([px]))).toBe(true)
  })

  it('多个无门店市场：默认第一个、不锁（可互切）', () => {
    expect(resolveDefaultDataCenterScope(opts([px, px2]))).toEqual({ type: 'market', id: 'PX' })
    expect(isScopeLocked(opts([px, px2]))).toBe(false)
  })

  it('单店 + 无门店市场：默认仍是门店，但不锁（能切到品项公司看锚定员工）', () => {
    expect(resolveDefaultDataCenterScope(opts([oneStore, px]))).toEqual({ type: 'store', id: 'S1' })
    expect(selectableScopeCount(opts([oneStore, px]))).toBe(2)
    expect(isScopeLocked(opts([oneStore, px]))).toBe(false)
  })

  it('祖先市场（granted=false / 缺省）不算：唯一门店被停用的店长仍无默认范围、锁定', () => {
    expect(resolveDefaultDataCenterScope(opts([ancestor]))).toBeNull()
    expect(resolveDefaultDataCenterScope(opts([{ id: 'M1', name: '南昌市场', stores: [] }]))).toBeNull()
    expect(isScopeLocked(opts([ancestor]))).toBe(true)
  })

  it('单店店长（祖先市场有店）：锁定行为不变', () => {
    expect(isScopeLocked(opts([oneStore]))).toBe(true)
  })

  it('多店账号：不锁、默认授权汇总（行为不变）', () => {
    expect(isScopeLocked(multiStoreOptions)).toBe(false)
    expect(resolveDefaultDataCenterScope({ ...multiStoreOptions, markets: [...multiStoreOptions.markets, px] })).toEqual({ type: 'authorized' })
  })

  it('总部永不锁', () => {
    expect(isScopeLocked({ topLevel: 'all', inactiveStores: [], markets: [] })).toBe(false)
  })
})
