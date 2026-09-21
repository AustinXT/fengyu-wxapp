import { describe, it, expect } from 'vitest'
import {
  DATA_CENTER_BOARD_LABELS,
  DATA_CENTER_TABS,
  firstQueryValue,
  hasRepeatedQueryKey,
  parseBoard,
  singleValueQuery,
  parseScope,
  parseTimeRange,
  parseBoardParams,
} from './params'

describe('parseBoard', () => {
  it('合法板块原样返回，非法返回 null（不回退，交给 notFound 收口）', () => {
    expect(parseBoard('sales')).toBe('sales')
    expect(parseBoard('efficiency')).toBe('efficiency')
    expect(parseBoard('xxx')).toBeNull()
    expect(parseBoard('')).toBeNull()
    expect(parseBoard(undefined)).toBeNull()
  })

  it('大小写敏感：不做 toLowerCase 容错', () => {
    expect(parseBoard('Sales')).toBeNull()
  })
})

describe('firstQueryValue', () => {
  it('重复 query key 取首值，避免被 String(array) 压成逗号串', () => {
    expect(firstQueryValue(['store', 'market'])).toBe('store')
    expect(firstQueryValue('store')).toBe('store')
    expect(firstQueryValue(undefined)).toBeUndefined()
    expect(firstQueryValue([])).toBeUndefined()
  })
})

describe('hasRepeatedQueryKey', () => {
  it('只在存在数组值（重复 key）时为真', () => {
    expect(hasRepeatedQueryKey({ scope: ['store', 'all'] })).toBe(true)
    expect(hasRepeatedQueryKey({ scope: 'store', preset: 'year' })).toBe(false)
    expect(hasRepeatedQueryKey({})).toBe(false)
  })
})

describe('singleValueQuery', () => {
  it('取首值、丢空串、剔除 tab', () => {
    const qs = singleValueQuery({
      tab: 'customer',
      scope: ['store', 'all'],
      scopeId: 'S1',
      preset: '',
      cmp: '0',
    })
    expect(qs.toString()).toBe('scope=store&scopeId=S1&cmp=0')
  })

  it('drop 里的 key 额外排除', () => {
    const qs = singleValueQuery({ scope: 'store', scopeId: 'S1', preset: 'year' }, ['scope', 'scopeId'])
    expect(qs.toString()).toBe('preset=year')
  })

  it('全空时产出空串（调用方据此省掉问号）', () => {
    expect(singleValueQuery({ tab: 'sales', preset: undefined }).toString()).toBe('')
  })
})

describe('DATA_CENTER_BOARD_LABELS', () => {
  it('每个板块都有中文名（菜单项、面包屑、h1 共用）', () => {
    for (const board of DATA_CENTER_TABS) {
      expect(DATA_CENTER_BOARD_LABELS[board], `板块 ${board} 缺中文名`).toBeTruthy()
    }
    expect(Object.keys(DATA_CENTER_BOARD_LABELS)).toHaveLength(DATA_CENTER_TABS.length)
  })
})

describe('parseScope', () => {
  it('authorized 不需 scopeId，market/store 需带 scopeId', () => {
    expect(parseScope({ scope: 'authorized' })).toEqual({ type: 'authorized' })
    expect(parseScope({ scope: 'market', scopeId: 'M1' })).toEqual({ type: 'market', id: 'M1' })
    expect(parseScope({ scope: 'store', scopeId: 'S1' })).toEqual({ type: 'store', id: 'S1' })
    expect(parseScope({ scope: 'market' })).toEqual({ type: 'all' }) // 缺 id
    expect(parseScope({})).toEqual({ type: 'all' })
  })
})

describe('parseTimeRange', () => {
  it('预设 today/week/year 原样，缺省 month', () => {
    expect(parseTimeRange({ preset: 'today' })).toEqual({ preset: 'today' })
    expect(parseTimeRange({ preset: 'week' })).toEqual({ preset: 'week' })
    expect(parseTimeRange({ preset: 'year' })).toEqual({ preset: 'year' })
    expect(parseTimeRange({})).toEqual({ preset: 'month' })
    expect(parseTimeRange({ preset: '乱写' })).toEqual({ preset: 'month' })
  })

  it('custom 需合法日期且 start<=end，否则回退 month', () => {
    expect(parseTimeRange({ preset: 'custom', start: '2026-01-01', end: '2026-01-31' })).toEqual({
      preset: 'custom',
      start: '2026-01-01',
      end: '2026-01-31',
    })
    expect(parseTimeRange({ preset: 'custom', start: '2026-02-01', end: '2026-01-01' })).toEqual({
      preset: 'month',
    }) // start>end
    expect(parseTimeRange({ preset: 'custom', start: 'bad', end: '2026-01-01' })).toEqual({
      preset: 'month',
    })
    expect(parseTimeRange({ preset: 'custom', start: '2026-01-01' })).toEqual({ preset: 'month' }) // 缺 end
  })
})

describe('parseBoardParams', () => {
  it('组合解析，cmp=0 关闭对比，其余默认开启', () => {
    expect(parseBoardParams({ scope: 'store', scopeId: 'S1', preset: 'week', cmp: '0' })).toEqual({
      scope: { type: 'store', id: 'S1' },
      timeRange: { preset: 'week' },
      withComparison: false,
    })
    expect(parseBoardParams({})).toEqual({
      scope: { type: 'all' },
      timeRange: { preset: 'month' },
      withComparison: true,
    })
  })

  it('授权汇总范围传递给看板 action', () => {
    expect(parseBoardParams({ scope: 'authorized', preset: 'month' }).scope).toEqual({
      type: 'authorized',
    })
  })
})
