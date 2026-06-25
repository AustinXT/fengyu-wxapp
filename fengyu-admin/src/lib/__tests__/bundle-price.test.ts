import { describe, it, expect } from 'vitest'
import { computeBundleTotals, round2 } from '../bundle-price'

describe('computeBundleTotals', () => {
  it('全选组：price = listPrice × skuCount；无会员价 → special=null', () => {
    const r = computeBundleTotals([
      { pickCount: null, listPrice: '200.00', memberPrice: null, skuCount: 3 },
    ])
    expect(r.price).toBe('600.00')
    expect(r.specialPrice).toBeNull()
  })

  it('N选M 组：price = listPrice × pickCount（与组内 SKU 数无关）', () => {
    const r = computeBundleTotals([
      { pickCount: 2, listPrice: '200.00', memberPrice: null, skuCount: 10 },
    ])
    expect(r.price).toBe('400.00')
    expect(r.specialPrice).toBeNull()
  })

  it('会员价：special = coalesce(memberPrice, listPrice) × 计入数量', () => {
    const r = computeBundleTotals([
      { pickCount: 2, listPrice: '200.00', memberPrice: '180.00', skuCount: 10 },
    ])
    expect(r.price).toBe('400.00')
    expect(r.specialPrice).toBe('360.00')
  })

  it('多组混合（全选必含 + N选M）求和；部分组有会员价', () => {
    const r = computeBundleTotals([
      { pickCount: null, listPrice: '100.00', memberPrice: '90.00', skuCount: 1 }, // 必含 1 项，打折
      { pickCount: 2, listPrice: '200.00', memberPrice: '200.00', skuCount: 5 },   // 5选2，不打折
    ])
    // price = 100×1 + 200×2 = 500；member = 90×1 + 200×2 = 490 < 500 → 有折扣
    expect(r.price).toBe('500.00')
    expect(r.specialPrice).toBe('490.00')
  })

  it('全部组无会员价 → special=null', () => {
    const r = computeBundleTotals([
      { pickCount: null, listPrice: '100.00', memberPrice: null, skuCount: 2 },
      { pickCount: 1, listPrice: '50.00', memberPrice: null, skuCount: 3 },
    ])
    expect(r.price).toBe('250.00')
    expect(r.specialPrice).toBeNull()
  })

  it('会员价等于标价（无实际折扣）→ special=null', () => {
    const r = computeBundleTotals([
      { pickCount: 2, listPrice: '200.00', memberPrice: '200.00', skuCount: 5 },
    ])
    expect(r.price).toBe('400.00')
    expect(r.specialPrice).toBeNull()
  })

  it('空套餐（0 组）→ price=0.00, special=null', () => {
    const r = computeBundleTotals([])
    expect(r.price).toBe('0.00')
    expect(r.specialPrice).toBeNull()
  })

  it('全选组 0 SKU → 贡献 0', () => {
    const r = computeBundleTotals([
      { pickCount: null, listPrice: '200.00', memberPrice: null, skuCount: 0 },
    ])
    expect(r.price).toBe('0.00')
    expect(r.specialPrice).toBeNull()
  })

  it('listPrice 为 null 视为 0', () => {
    const r = computeBundleTotals([
      { pickCount: 2, listPrice: null, memberPrice: null, skuCount: 5 },
    ])
    expect(r.price).toBe('0.00')
    expect(r.specialPrice).toBeNull()
  })

  it('浮点小数正确累加（round2）', () => {
    const r = computeBundleTotals([
      { pickCount: 3, listPrice: '99.99', memberPrice: '89.90', skuCount: 5 },
    ])
    expect(r.price).toBe('299.97')
    expect(r.specialPrice).toBe('269.70')
  })
})

describe('round2', () => {
  it('修正浮点误差到 2 位', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(89.9 * 3)).toBe(269.7)
    expect(round2(100 / 3)).toBe(33.33)
  })
})
