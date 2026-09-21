/**
 * utils/spu-list 测试（issue #248）
 *
 * 这段装配原先在 home.ts × 3 处、shop.ts × 2 处重复，且完全没有测试覆盖：
 * `member-pricing-cross-end.test.ts` 只守护两份**云函数**副本字节一致，
 * 不覆盖页面层的 min_price / strike_min_price。
 */

import { decorateSpuRows, appendUniqueSpuRows } from '../../utils/spu-list'
import { INITIAL_COVER_VISIBLE_COUNT } from '../../utils/cover-window'

const row = (over: Record<string, any> = {}) => ({
  product_id: 'p1',
  name: '商品',
  priceFrom: '80',
  listPriceFrom: '100',
  ...over,
})

describe('decorateSpuRows · 会员价分流', () => {
  test('会员看会员起价，标价更高时给划线价', () => {
    const [r] = decorateSpuRows([row()], true)
    expect(r.min_price).toBe('80')
    expect(r.strike_min_price).toBe('100')
  })

  test('非会员只看标价起价，不给划线价', () => {
    const [r] = decorateSpuRows([row()], false)
    expect(r.min_price).toBe('100')
    expect(r.strike_min_price).toBe('')
  })

  test('会员价等于标价时不划线（脏数据兜底）', () => {
    const [r] = decorateSpuRows([row({ listPriceFrom: '80' })], true)
    expect(r.min_price).toBe('80')
    expect(r.strike_min_price).toBe('')
  })

  test('缺 listPriceFrom 时非会员回落到 priceFrom', () => {
    const [r] = decorateSpuRows([row({ listPriceFrom: null })], false)
    expect(r.min_price).toBe('80')
    expect(r.strike_min_price).toBe('')
  })

  test('两个价格都缺时落 "0"，不产出 undefined 让 wxml 渲染空白', () => {
    const [r] = decorateSpuRows([row({ priceFrom: null, listPriceFrom: null })], true)
    expect(r.min_price).toBe('0')
  })

  test('透传原字段（spread 而非显式枚举，新增字段不会静默漏掉）', () => {
    const [r] = decorateSpuRows([row({ is_bundle: true, skuList: [{ sku_id: 's1' }] })], false)
    expect(r.is_bundle).toBe(true)
    expect(r.skuList).toEqual([{ sku_id: 's1' }])
    expect(r.name).toBe('商品')
  })

  test('startIndex=0 时前若干条预置可见；追加页一律不可见', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ product_id: `p${i}` }))
    const first = decorateSpuRows(rows, false, 0)
    expect(first.filter(r => r.coverVisible)).toHaveLength(INITIAL_COVER_VISIBLE_COUNT)

    const appended = decorateSpuRows(rows, false, 20)
    expect(appended.every(r => r.coverVisible === false)).toBe(true)
  })

  test('空输入返回空数组', () => {
    expect(decorateSpuRows([], true)).toEqual([])
  })
})

describe('appendUniqueSpuRows', () => {
  test('首页直接返回新行（不做无谓的 Set 构造）', () => {
    const next = [row({ product_id: 'a' })]
    expect(appendUniqueSpuRows([], next)).toBe(next)
  })

  test('正常追加全部保留', () => {
    const prev = [row({ product_id: 'a' })]
    const next = [row({ product_id: 'b' }), row({ product_id: 'c' })]
    expect(appendUniqueSpuRows(prev, next).map(r => r.product_id)).toEqual(['a', 'b', 'c'])
  })

  test('sort_order 被改动导致重复下发时按主键去重', () => {
    // 翻页期间 admin 改了排序 → keyset 把 'b' 又发了一次；
    // wx:key="product_id" 遇重复 key 会告警并可能串位渲染
    const prev = [row({ product_id: 'a' }), row({ product_id: 'b' })]
    const next = [row({ product_id: 'b' }), row({ product_id: 'c' })]
    expect(appendUniqueSpuRows(prev, next).map(r => r.product_id)).toEqual(['a', 'b', 'c'])
  })

  test('整页重复时列表不增长', () => {
    const prev = [row({ product_id: 'a' }), row({ product_id: 'b' })]
    expect(appendUniqueSpuRows(prev, prev)).toHaveLength(2)
  })
})
