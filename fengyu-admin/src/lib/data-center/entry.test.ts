import { describe, expect, it } from 'vitest'
import { defaultScopeParams, resolveDataCenterEntry } from './entry'
import { collapseQuery } from './params'
import { resolveReportPage } from './report-page'
import type { DataCenterScopeOptions } from './types'

const hq: DataCenterScopeOptions = {
  topLevel: 'all',
  markets: [{ id: 'M1', name: '南昌', stores: [{ storeId: 'S1', storeName: '蓝莱店' }] }],
}
const multi: DataCenterScopeOptions = {
  topLevel: 'market',
  markets: [{ id: 'M1', name: '南昌', stores: [{ storeId: 'S1', storeName: '蓝莱店' }, { storeId: 'S2', storeName: '绿湖店' }] }],
}
const none: DataCenterScopeOptions = { topLevel: 'store', markets: [{ id: 'M1', name: '南昌', stores: [] }] }

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
    expect(resolveDataCenterEntry('/p', {}, none)).toEqual({ kind: 'render', noViewableScope: true })
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
