import { describe, expect, it } from 'vitest'
import { defaultScopeParams, resolveDataCenterEntry } from './entry'
import { collapseQuery } from './params'
import { resolveReportPage } from './report-page'
import type { DataCenterScopeOptions } from './types'

const hq: DataCenterScopeOptions = {
  topLevel: 'all', inactiveStores: [],
  markets: [{ id: 'M1', name: '南昌', stores: [{ storeId: 'S1', storeName: '蓝莱店' }] }],
}
const multi: DataCenterScopeOptions = {
  topLevel: 'market', inactiveStores: [],
  markets: [{ id: 'M1', name: '南昌', stores: [{ storeId: 'S1', storeName: '蓝莱店' }, { storeId: 'S2', storeName: '绿湖店' }] }],
}
const none: DataCenterScopeOptions = { topLevel: 'store', inactiveStores: [], markets: [{ id: 'M1', name: '南昌', stores: [] }] }

describe('collapseQuery', () => {
  it('取首值、丢空串、只剔除显式列出的键（tab 不再特殊）', () => {
    expect(collapseQuery({ tab: ['a', 'b'], q: '', scope: 'store', page: '2' }, ['page']).toString()).toBe('tab=a&scope=store')
  })
})

describe('defaultScopeParams', () => {
  it('总部空对象、多店授权汇总、无可见门店 null', () => {
    expect(defaultScopeParams(hq)).toEqual({})
    expect(defaultScopeParams(multi)).toEqual({ scope: 'authorized' })
    expect(defaultScopeParams(none)).toBeNull()
  })
})

describe('resolveDataCenterEntry', () => {
  it('legacyKeys 只在显式传入时剔除', () => {
    expect(resolveDataCenterEntry('/p', { tab: 'x' }, multi)).toEqual({ kind: 'redirect', url: '/p?tab=x&scope=authorized' })
    expect(resolveDataCenterEntry('/p', { tab: 'x' }, multi, ['tab'])).toEqual({ kind: 'redirect', url: '/p?scope=authorized' })
  })

  it('无可见门店：不跳转、渲染空态', () => {
    expect(resolveDataCenterEntry('/p', {}, none)).toEqual({ kind: 'render', noViewableScope: true, inactiveStore: null, defaultScopeHref: null })
  })
})

describe('已停用门店（#293）', () => {
  const zhonghui = { storeId: 'X1', storeName: '九江中辉店', marketId: 'M1' }
  const hqWithInactive: DataCenterScopeOptions = { ...hq, inactiveStores: [zhonghui] }
  const multiWithInactive: DataCenterScopeOptions = { ...multi, inactiveStores: [zhonghui] }

  it.each([
    ['总部：出口回到全部', hqWithInactive, '/p?preset=year'],
    ['市场账号（停用门店仍在 scopeStoreIds 内）：出口回到授权汇总', multiWithInactive, '/p?preset=year&scope=authorized'],
  ] as const)('%s', (_label, options, href) => {
    expect(resolveDataCenterEntry('/p', { scope: 'store', scopeId: 'X1', preset: 'year', tab: 'x' }, options, ['tab']))
      .toEqual({ kind: 'render', noViewableScope: false, inactiveStore: zhonghui, defaultScopeHref: href })
  })

  it('在营门店照常渲染、inactiveStore 为 null（无业绩显示 0 的行为不变）', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'store', scopeId: 'S1' }, hqWithInactive))
      .toEqual({ kind: 'render', noViewableScope: false, inactiveStore: null, defaultScopeHref: null })
  })

  it('店长唯一门店被停用：仍说「已停用」而非泛化空态，且没有可回的默认范围', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'store', scopeId: 'X1' }, { ...none, inactiveStores: [zhonghui] }))
      .toEqual({ kind: 'render', noViewableScope: true, inactiveStore: zhonghui, defaultScopeHref: null })
  })

  it('报表页：停用门店不跳回默认范围，scope 置 null 且带出 inactiveStore', () => {
    for (const options of [hqWithInactive, multiWithInactive]) {
      const result = resolveReportPage({
        path: '/p', query: { scope: 'store', scopeId: 'X1', month: '2026-08' }, scopeOptions: options, periodKind: 'month', today: '2026-09-25',
      })
      expect(result).toMatchObject({ kind: 'render', context: { scope: null, noViewableScope: false, inactiveStore: zhonghui } })
    }
  })

  it('报表页：权限外 / 不存在的门店仍按原逻辑跳回默认范围', () => {
    expect(resolveReportPage({
      path: '/p', query: { scope: 'store', scopeId: 'OTHER' }, scopeOptions: multiWithInactive, periodKind: 'none', today: '2026-09-25',
    })).toEqual({ kind: 'redirect', url: '/p?scope=authorized' })
  })
})

describe('resolveReportPage · URL 范围不在授权数据源内', () => {
  it.each([
    ['非总部：门店调岗后的旧书签', multi, { scope: 'store', scopeId: 'OTHER', month: '2026-08' }, '/p?month=2026-08&scope=authorized'],
    ['非总部：不在数据源的市场', multi, { scope: 'market', scopeId: 'M9' }, '/p?scope=authorized'],
    ['总部：已撤市场回到全部', hq, { scope: 'market', scopeId: 'M9', tab: 'item' }, '/p?tab=item'],
  ] as const)('%s → 回到默认范围并保留其余参数', (_label, options, query, url) => {
    expect(resolveReportPage({ path: '/p', query, scopeOptions: options, periodKind: 'month', today: '2026-09-25' }))
      .toEqual({ kind: 'redirect', url })
  })

  it('跳转后的默认范围一定可渲染（终止性）', () => {
    const next = resolveReportPage({ path: '/p', query: { scope: 'authorized' }, scopeOptions: multi, periodKind: 'none', today: '2026-09-25' })
    expect(next.kind).toBe('render')
  })

  it('数据源内的市场 / 门店照常渲染', () => {
    for (const query of [{ scope: 'market', scopeId: 'M1' }, { scope: 'store', scopeId: 'S2' }]) {
      expect(resolveReportPage({ path: '/p', query, scopeOptions: multi, periodKind: 'none', today: '2026-09-25' }).kind).toBe('render')
    }
  })
})

describe('resolveReportPage · 无可查看范围', () => {
  it('scope 置 null（页面漏判 noViewableScope 时 tsc 报错，而不是拿 all 取数被拒成 403）', () => {
    const result = resolveReportPage({ path: '/p', query: {}, scopeOptions: none, periodKind: 'month', today: '2026-09-25' })
    expect(result).toMatchObject({ kind: 'render', context: { scope: null, noViewableScope: true } })
  })
})
