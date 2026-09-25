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

describe('#399 零在营门店但市场 scope 合法（只授权品项公司这类无门店市场）', () => {
  const pxOnly: DataCenterScopeOptions = {
    topLevel: 'market', inactiveStores: [],
    markets: [{ id: 'PX', name: '品项公司', stores: [], granted: true }],
  }

  it('默认范围 = 该市场', () => {
    expect(defaultScopeParams(pxOnly)).toEqual({ scope: 'market', scopeId: 'PX' })
  })

  it('板块页：URL 无 scope → 跳到市场范围（不再整屏「暂无可查看范围」）', () => {
    expect(resolveDataCenterEntry('/data-center/efficiency', { preset: 'month' }, pxOnly))
      .toEqual({ kind: 'redirect', url: '/data-center/efficiency?preset=month&scope=market&scopeId=PX' })
  })

  it('板块页：市场 scope 照常渲染、noViewableScope=false', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'market', scopeId: 'PX' }, pxOnly))
      .toEqual({ kind: 'render', noViewableScope: false, inactiveStore: null, defaultScopeHref: null })
  })

  it.each(['range', 'month', 'none'] as const)('报表页（%s 型）：无 scope → 跳到市场；市场 scope → 渲染且 scope 非 null', (periodKind) => {
    expect(resolveReportPage({ path: '/r', query: {}, scopeOptions: pxOnly, periodKind, today: '2026-09-25' }))
      .toEqual({ kind: 'redirect', url: '/r?scope=market&scopeId=PX' })
    const result = resolveReportPage({ path: '/r', query: { scope: 'market', scopeId: 'PX' }, scopeOptions: pxOnly, periodKind, today: '2026-09-25' })
    expect(result).toMatchObject({
      kind: 'render',
      context: { scope: { type: 'market', id: 'PX' }, noViewableScope: false, inactiveStore: null, defaultQuery: { scope: 'market', scopeId: 'PX' } },
    })
  })

  it('报表页：URL 指向数据源外的市场 → 回到品项公司（终止）', () => {
    expect(resolveReportPage({ path: '/r', query: { scope: 'market', scopeId: 'M9' }, scopeOptions: pxOnly, periodKind: 'none', today: '2026-09-25' }))
      .toEqual({ kind: 'redirect', url: '/r?scope=market&scopeId=PX' })
  })

  it('祖先市场（门店店长唯一门店停用）仍是空态，不被带到整个市场', () => {
    expect(resolveDataCenterEntry('/p', {}, none))
      .toEqual({ kind: 'render', noViewableScope: true, inactiveStore: null, defaultScopeHref: null })
    expect(defaultScopeParams(none)).toBeNull()
  })
})

describe('#399 ?scope=authorized 链接 + 零可见门店账号', () => {
  const pxOnly: DataCenterScopeOptions = {
    topLevel: 'market', inactiveStores: [],
    markets: [{ id: 'PX', name: '品项公司', stores: [], granted: true }],
  }

  it('板块页：authorized 不可用 → 跳到默认市场（不再渲染后被 validateScope 拒成报错）', () => {
    expect(resolveDataCenterEntry('/data-center/sales', { scope: 'authorized', preset: 'month' }, pxOnly))
      .toEqual({ kind: 'redirect', url: '/data-center/sales?preset=month&scope=market&scopeId=PX' })
  })

  it('报表页：同样跳到默认市场', () => {
    expect(resolveReportPage({ path: '/r', query: { scope: 'authorized', month: '2026-08' }, scopeOptions: pxOnly, periodKind: 'month', today: '2026-09-25' }))
      .toEqual({ kind: 'redirect', url: '/r?month=2026-08&scope=market&scopeId=PX' })
  })

  it('连默认市场都没有（祖先市场）：仍是空态，不循环', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'authorized' }, none))
      .toEqual({ kind: 'render', noViewableScope: true, inactiveStore: null, defaultScopeHref: null })
  })

  it('有可见门店的账号：authorized 照常渲染（行为不变）', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'authorized' }, multi))
      .toEqual({ kind: 'render', noViewableScope: false, inactiveStore: null, defaultScopeHref: null })
  })
})

describe('多店入口（#376）', () => {
  const opts: DataCenterScopeOptions = {
    topLevel: 'market',
    inactiveStores: [{ storeId: 'X1', storeName: '自贡旭阳店', marketId: 'M2' }],
    markets: [
      { id: 'M1', name: '南昌', stores: [{ storeId: 'S1', storeName: '蓝莱店' }, { storeId: 'S2', storeName: '绿湖店' }], granted: true },
      { id: 'M2', name: '自贡', stores: [{ storeId: 'S3', storeName: '自贡一店' }, { storeId: 'S4', storeName: '自贡二店' }], granted: true },
    ],
  }
  const render = { kind: 'render', noViewableScope: false, inactiveStore: null, defaultScopeHref: null }

  it('规范的多店 URL：直接渲染', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S1,S3', preset: 'week' }, opts)).toEqual(render)
  })

  it('乱序 / 重复 id → 重定向到升序去重编码，保留其余参数', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S3,S1,S3', preset: 'week' }, opts))
      .toEqual({ kind: 'redirect', url: '/p?preset=week&scope=stores&scopeId=S1%2CS3' })
  })

  it('全选 → authorized；勾满单市场 → market；1 家 → store', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S1,S2,S3,S4' }, opts)).toEqual({ kind: 'redirect', url: '/p?scope=authorized' })
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S1,S2' }, opts)).toEqual({ kind: 'redirect', url: '/p?scope=market&scopeId=M1' })
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S1' }, opts)).toEqual({ kind: 'redirect', url: '/p?scope=store&scopeId=S1' })
  })

  it('1 家的多店串恰是单店市场的全部门店 → market（与面板同一套折叠）', () => {
    const withSingle = { ...opts, markets: [...opts.markets, { id: 'M3', name: '昭通', stores: [{ storeId: 'S5', storeName: '昭通店' }], granted: true }] }
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S5' }, withSingle)).toEqual({ kind: 'redirect', url: '/p?scope=market&scopeId=M3' })
  })

  it('总部全选 → 去掉 scope（all）', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S1,S2,S3,S4', preset: 'week' }, { ...opts, topLevel: 'all' }))
      .toEqual({ kind: 'redirect', url: '/p?preset=week' })
  })

  it('非法串：非总部落默认范围，总部剥掉 scope 参数（不会停在一个认不出的 URL 上）', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S1,,S2' }, opts)).toEqual({ kind: 'redirect', url: '/p?scope=authorized' })
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S1,,S2' }, { ...opts, topLevel: 'all' })).toEqual({ kind: 'redirect', url: '/p' })
  })

  it('重复 key（?scopeId=a&scopeId=b）先压成首值，不当作多店', () => {
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: ['S1,S3', 'S2'] }, opts))
      .toEqual({ kind: 'redirect', url: '/p?scope=stores&scopeId=S1%2CS3' })
  })

  it('规范化后再进入不再重定向（终止性）', () => {
    const first = resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S3,S1' }, opts)
    expect(first.kind).toBe('redirect')
    const qs = new URLSearchParams((first as { url: string }).url.split('?')[1])
    expect(resolveDataCenterEntry('/p', Object.fromEntries(qs), opts)).toEqual(render)
  })

  it('所选全部停用 → 停用空态（带回默认范围链接）；部分停用 → 照常渲染', () => {
    const entry = resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'X1,X2' }, { ...opts, inactiveStores: [...opts.inactiveStores, { storeId: 'X2', storeName: '停用二', marketId: 'M1' }] })
    expect(entry).toMatchObject({ kind: 'render', inactiveStore: { storeId: 'X1,X2', storeName: '自贡旭阳店、停用二' }, defaultScopeHref: '/p?scope=authorized' })
    expect(resolveDataCenterEntry('/p', { scope: 'stores', scopeId: 'S1,X1' }, opts)).toEqual(render)
  })

  it('报表页：数据源外门店 → 跳默认范围；部分停用 → 渲染、scope 保持多店', () => {
    expect(resolveReportPage({ path: '/r', query: { scope: 'stores', scopeId: 'S1,Z9' }, scopeOptions: opts, periodKind: 'none' }))
      .toEqual({ kind: 'redirect', url: '/r?scope=authorized' })
    const page = resolveReportPage({ path: '/r', query: { scope: 'stores', scopeId: 'S1,X1' }, scopeOptions: opts, periodKind: 'none' })
    expect(page).toMatchObject({ kind: 'render', context: { scope: { type: 'stores', ids: ['S1', 'X1'] }, inactiveStore: null } })
  })

  it('报表页：全部停用 → scope 置 null（不取数）', () => {
    const page = resolveReportPage({ path: '/r', query: { scope: 'stores', scopeId: 'X1,X2' }, scopeOptions: { ...opts, inactiveStores: [...opts.inactiveStores, { storeId: 'X2', storeName: '停用二', marketId: 'M1' }] }, periodKind: 'none' })
    expect(page).toMatchObject({ kind: 'render', context: { scope: null } })
  })
})
