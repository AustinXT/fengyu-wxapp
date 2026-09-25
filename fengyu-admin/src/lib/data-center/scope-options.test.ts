import { describe, expect, it } from 'vitest'
import { canonicalizeScope, scopeFromSelection, findInactiveScopeStore, inactiveStoresInScope, isScopeLocked, multiStoreName, resolveDefaultDataCenterScope, scopeLabel, scopeStores, selectableScopeCount, visibleScopeStores } from './scope-options'
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

/** 3 市场：M1 两店 / M2 一店 / M3 两店；另有一家停用门店 X1（在 M3） */
const three: DataCenterScopeOptions = {
  topLevel: 'market',
  inactiveStores: [{ storeId: 'X1', storeName: '停用店', marketId: 'M3' }],
  markets: [
    { id: 'M1', name: '南昌', stores: [{ storeId: 'S1', storeName: '一' }, { storeId: 'S2', storeName: '二' }], granted: true },
    { id: 'M2', name: '九江', stores: [{ storeId: 'S3', storeName: '三' }], granted: true },
    { id: 'M3', name: '自贡', stores: [{ storeId: 'S4', storeName: '四' }, { storeId: 'S5', storeName: '五' }], granted: true },
  ],
}
const stores = (...ids: string[]) => ({ type: 'stores' as const, ids })

describe('canonicalizeScope（#376 折叠规则）', () => {
  it('全选（= 全部可见在营门店）：非总部 → authorized', () => {
    expect(canonicalizeScope(three, stores('S1', 'S2', 'S3', 'S4', 'S5'))).toEqual({ type: 'authorized' })
  })

  it('全选：总部 → all', () => {
    expect(canonicalizeScope({ ...three, topLevel: 'all' }, stores('S1', 'S2', 'S3', 'S4', 'S5'))).toEqual({ type: 'all' })
  })

  it('恰好勾满一个市场、未勾别的 → market', () => {
    expect(canonicalizeScope(three, stores('S1', 'S2'))).toEqual({ type: 'market', id: 'M1' })
    expect(canonicalizeScope(three, stores('S4', 'S5'))).toEqual({ type: 'market', id: 'M3' })
  })

  it('勾满一个市场 + 别的市场一家 → 不折叠', () => {
    expect(canonicalizeScope(three, stores('S1', 'S2', 'S3'))).toEqual(stores('S1', 'S2', 'S3'))
  })

  it('勾满两个市场（非全部）→ 不折叠（没有「多市场」形态）', () => {
    expect(canonicalizeScope(three, stores('S1', 'S2', 'S4', 'S5'))).toEqual(stores('S1', 'S2', 'S4', 'S5'))
  })

  it('市场内部分门店 → 不折叠', () => {
    expect(canonicalizeScope(three, stores('S1', 'S4'))).toEqual(stores('S1', 'S4'))
  })

  it('含停用门店 → 原样（保留「N 家已停用」提示），即使在营部分恰好勾满市场', () => {
    expect(canonicalizeScope(three, stores('S4', 'S5', 'X1'))).toEqual(stores('S4', 'S5', 'X1'))
  })

  it('含数据源外门店 → 原样（交给入口跳默认 / validateScope 拒）', () => {
    expect(canonicalizeScope(three, stores('S1', 'S2', 'Z9'))).toEqual(stores('S1', 'S2', 'Z9'))
  })

  it('非多店范围原样返回', () => {
    for (const scope of [{ type: 'all' as const }, { type: 'authorized' as const }, { type: 'market' as const, id: 'M1' }, { type: 'store' as const, id: 'S1' }]) {
      expect(canonicalizeScope(three, scope)).toEqual(scope)
    }
  })

  it('「1 市场 + 1 门店」混合账号：勾市场 A 全部 + 祖先市场 B 的那家店 = 全选 → authorized；只勾那家店 → store', () => {
    const mixed: DataCenterScopeOptions = {
      topLevel: 'market', inactiveStores: [],
      markets: [
        { id: 'MA', name: '市场A', stores: [{ storeId: 'A1', storeName: 'A1' }, { storeId: 'A2', storeName: 'A2' }], granted: true },
        { id: 'MB', name: '市场B', stores: [{ storeId: 'B1', storeName: 'B1' }], granted: false },
      ],
    }
    expect(canonicalizeScope(mixed, stores('A1', 'A2', 'B1'))).toEqual({ type: 'authorized' })
    expect(canonicalizeScope(mixed, stores('A1', 'A2'))).toEqual({ type: 'market', id: 'MA' })
    expect(canonicalizeScope(mixed, stores('A1', 'B1'))).toEqual(stores('A1', 'B1'))
  })
})

describe('多店：停用识别 / 覆盖门店 / 展示名（#376）', () => {
  it('全部停用 → 空态（合成的停用项带全部店名）', () => {
    const opts = { ...three, inactiveStores: [...three.inactiveStores, { storeId: 'X2', storeName: '停用二', marketId: 'M1' }] }
    expect(findInactiveScopeStore(opts, stores('X1', 'X2'))).toEqual({ storeId: 'X1,X2', storeName: '停用店、停用二', marketId: null })
  })

  it('部分停用 → 不走空态；inactiveStoresInScope 列出停用那部分', () => {
    expect(findInactiveScopeStore(three, stores('S1', 'X1'))).toBeNull()
    expect(inactiveStoresInScope(three, stores('S1', 'X1')).map((s) => s.storeId)).toEqual(['X1'])
  })

  it('没有停用 / 非多店 → inactiveStoresInScope 为空', () => {
    expect(inactiveStoresInScope(three, stores('S1', 'S3'))).toEqual([])
    expect(inactiveStoresInScope(three, { type: 'store', id: 'X1' })).toEqual([])
  })

  it('含数据源外门店（非停用）→ 不判空态', () => {
    expect(findInactiveScopeStore(three, stores('X1', 'Z9'))).toBeNull()
  })

  it('scopeStores 只展开所选在营门店', () => {
    expect(scopeStores(three, stores('S1', 'S4', 'X1')).map((s) => s.storeId)).toEqual(['S1', 'S4'])
  })

  it('展示名：≤3 家列全名，更多加「等 N 家门店」', () => {
    expect(scopeLabel(three, stores('S1', 'S3'))).toBe('一、三')
    expect(multiStoreName(['a', 'b', 'c', 'd'])).toBe('a、b、c 等 4 家门店')
    expect(scopeLabel(three, stores('S1', 'X1'))).toBe('一、停用店')
  })
})

describe('scopeFromSelection（面板勾选 → 范围）', () => {
  it('勾满只有 1 家店的市场 → market；非整市场的 1 家 → store', () => {
    expect(scopeFromSelection(three, ['S3'])).toEqual({ type: 'market', id: 'M2' })
    expect(scopeFromSelection(three, ['S1'])).toEqual({ type: 'store', id: 'S1' })
  })
  it('空集 null；多家同 canonicalizeScope；去重排序', () => {
    expect(scopeFromSelection(three, [])).toBeNull()
    expect(scopeFromSelection(three, ['S4', 'S1', 'S4'])).toEqual(stores('S1', 'S4'))
    expect(scopeFromSelection(three, ['S2', 'S1'])).toEqual({ type: 'market', id: 'M1' })
    expect(scopeFromSelection(three, ['S1', 'S2', 'S3', 'S4', 'S5'])).toEqual({ type: 'authorized' })
  })
})
