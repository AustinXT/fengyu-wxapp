import { describe, it, expect } from 'vitest'
import {
  DATA_CENTER_BOARD_LABELS,
  DATA_CENTER_TABS,
  parseBoard,
  parseTab,
  parseScope,
  parseTimeRange,
  parseBoardParams,
} from './params'

describe('parseTab', () => {
  it('合法 tab 原样返回，非法回退 sales', () => {
    expect(parseTab('customer')).toBe('customer')
    expect(parseTab('product')).toBe('product')
    expect(parseTab('xxx')).toBe('sales')
    expect(parseTab(undefined)).toBe('sales')
  })
})

describe('parseBoard', () => {
  it('合法板块原样返回，非法返回 null（不回退，交给 notFound 收口）', () => {
    expect(parseBoard('sales')).toBe('sales')
    expect(parseBoard('efficiency')).toBe('efficiency')
    expect(parseBoard('xxx')).toBeNull()
    expect(parseBoard('')).toBeNull()
    expect(parseBoard(undefined)).toBeNull()
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
