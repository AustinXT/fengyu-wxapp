import { describe, expect, it } from 'vitest'
import { evaluateDataStart, isRangeBeforeDataStart, type StoreDataStarts } from './data-start'
import { scopeStores } from './scope-options'
import type { DataCenterScopeOptions } from './types'

/** 按 prod 2026-09-25 的真实形态缩写：南昌凤御 07-08 起、九江业绩 07-30 / 服务 07-28、易大师 08-23、昭通只有业绩。 */
const options: DataCenterScopeOptions = {
  topLevel: 'all',
  markets: [
    {
      id: 'NC',
      name: '南昌凤御',
      stores: [
        { storeId: 'NC1', storeName: '蓝莱店' },
        { storeId: 'NC2', storeName: '绿湖店' },
        { storeId: 'NC3', storeName: '空壳店' },
      ],
    },
    { id: 'JJ', name: '九江凤御', stores: [{ storeId: 'JJ1', storeName: '九江一店' }] },
    { id: 'YDS', name: '南昌易大师', stores: [{ storeId: 'YDS1', storeName: '易大师一店' }] },
    { id: 'ZT', name: '昭通凤御', stores: [{ storeId: 'ZT1', storeName: '昭通一店' }] },
  ],
}

const starts: StoreDataStarts = {
  NC1: { performance: '2026-07-08', service: '2026-07-08' },
  NC2: { performance: '2026-08-08', service: '2026-08-01' },
  // NC3 一条数据都没有：不参与判定
  JJ1: { performance: '2026-07-30', service: '2026-07-28' },
  YDS1: { performance: '2026-08-23', service: '2026-08-23' },
  ZT1: { performance: '2026-09-14' },
}

const all = scopeStores(options, { type: 'all' })

describe('scopeStores', () => {
  it('按 scope 展开门店并带出所属市场', () => {
    expect(all.map((s) => s.storeId)).toEqual(['NC1', 'NC2', 'NC3', 'JJ1', 'YDS1', 'ZT1'])
    expect(scopeStores(options, { type: 'market', id: 'NC' }).map((s) => s.storeId)).toEqual(['NC1', 'NC2', 'NC3'])
    expect(scopeStores(options, { type: 'store', id: 'JJ1' })).toEqual([
      { storeId: 'JJ1', storeName: '九江一店', marketId: 'JJ', marketName: '九江凤御' },
    ])
  })
})

describe('evaluateDataStart', () => {
  it('2026-08 全国：业绩轴列出月中才上线的门店，按市场分组、起点早的在前', () => {
    const [result] = evaluateDataStart({
      ranges: [{ label: '所选期间', range: { start: '2026-08-01', end: '2026-08-31' } }],
      axes: ['performance'],
      stores: all,
      starts,
    })
    expect(result.groups.map((g) => [g.marketName, g.stores.map((s) => s.start)])).toEqual([
      ['南昌凤御', ['2026-08-08']],
      ['南昌易大师', ['2026-08-23']],
      ['昭通凤御', ['2026-09-14']],
    ])
  })

  it('期间起点恰好等于门店起点不算不完整', () => {
    const result = evaluateDataStart({
      ranges: [{ label: '所选期间', range: { start: '2026-09-14', end: '2026-09-30' } }],
      axes: ['performance'],
      stores: scopeStores(options, { type: 'market', id: 'ZT' }),
      starts,
    })
    expect(result).toEqual([])
  })

  it('没有该轴数据的门店不参与判定（昭通无服务单、空壳店无任何数据都不误报）', () => {
    const result = evaluateDataStart({
      ranges: [{ label: '所选期间', range: { start: '2026-10-01', end: '2026-10-31' } }],
      axes: ['performance', 'service'],
      stores: all,
      starts,
    })
    expect(result).toEqual([])
  })

  it('当期完整、基期跨过起点时只报基期', () => {
    const result = evaluateDataStart({
      ranges: [
        { label: '所选期间', range: { start: '2026-10-01', end: '2026-10-31' } },
        { label: '较上期基期', range: { start: '2026-09-01', end: '2026-09-30' } },
      ],
      axes: ['performance'],
      stores: all,
      starts,
    })
    expect(result.map((r) => r.label)).toEqual(['较上期基期'])
    expect(result[0].groups.map((g) => g.marketName)).toEqual(['昭通凤御'])
  })

  it('两条轴分别判定：九江服务 07-28、业绩 07-30', () => {
    const [result] = evaluateDataStart({
      ranges: [{ label: '所选期间', range: { start: '2026-07-29', end: '2026-07-31' } }],
      axes: ['performance', 'service'],
      stores: scopeStores(options, { type: 'market', id: 'JJ' }),
      starts,
    })
    expect(result.groups.map((g) => [g.axis, g.stores[0].start])).toEqual([['performance', '2026-07-30']])
  })

  it('整段早于所有起点（URL 手传 2026-05）时全部有数据的门店都列出', () => {
    const [result] = evaluateDataStart({
      ranges: [{ label: '所选期间', range: { start: '2026-05-01', end: '2026-05-31' } }],
      axes: ['service'],
      stores: all,
      starts,
    })
    expect(result.groups.flatMap((g) => g.stores.map((s) => s.storeId)).sort()).toEqual(['JJ1', 'NC1', 'NC2', 'YDS1'])
  })
})

describe('isRangeBeforeDataStart（页面据此把基期置 null）', () => {
  it('基期覆盖了任一门店上线前的日子即为 true', () => {
    expect(isRangeBeforeDataStart({ start: '2026-07-01', end: '2026-07-31' }, 'performance', all, starts)).toBe(true)
    expect(isRangeBeforeDataStart({ start: '2026-09-15', end: '2026-09-30' }, 'performance', all, starts)).toBe(false)
    // 单店 scope 只看本店起点
    expect(isRangeBeforeDataStart(
      { start: '2026-08-01', end: '2026-08-31' },
      'performance',
      scopeStores(options, { type: 'store', id: 'NC1' }),
      starts,
    )).toBe(false)
  })
})
