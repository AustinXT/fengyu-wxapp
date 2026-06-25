import { calcCartTotal, calcHalfPriceTotal, allocateCouponPerLine } from '../../utils/cart-calc'

describe('calcCartTotal — 原价合计（行 price × qty 之和）', () => {
  test('多商品合计', () => {
    const cart = [
      { price: 100, quantity: 2 },
      { price: 50, quantity: 3 },
    ]
    const r = calcCartTotal(cart)
    expect(r.count).toBe(5)
    expect(r.total).toBe('350.00')
  })

  test('空购物车', () => {
    expect(calcCartTotal([])).toEqual({ count: 0, total: '0.00' })
  })

  test('单个商品', () => {
    expect(calcCartTotal([{ price: 99.9, quantity: 1 }])).toEqual({
      count: 1,
      total: '99.90',
    })
  })

  test('浮点数精度', () => {
    // 0.1 * 3 = 0.30000000000000004 → toFixed(2) = '0.30'
    expect(calcCartTotal([{ price: 0.1, quantity: 3 }]).total).toBe('0.30')
  })
})

describe('calcHalfPriceTotal — 内部单半价合计', () => {
  test('多商品半价合计', () => {
    expect(
      calcHalfPriceTotal([
        { price: 100, quantity: 2 },
        { price: 50, quantity: 3 },
      ])
    ).toBe('175.00')
  })

  test('99.99 半价四舍五入到分', () => {
    // 99.99 × 50 = 4999.5 → Math.round = 5000 → /100 = 50.00
    expect(calcHalfPriceTotal([{ price: 99.99, quantity: 1 }])).toBe('50.00')
  })

  test('空购物车', () => {
    expect(calcHalfPriceTotal([])).toBe('0.00')
  })

  test('会员价场景按标价 listPrice 取半（不取会员 price）', () => {
    // 标价 200、会员价 180：内部单半价应为 200×0.5=100，而非 180×0.5=90
    expect(
      calcHalfPriceTotal([{ price: 180, listPrice: 200, quantity: 1 }])
    ).toBe('100.00')
  })
})

describe('allocateCouponPerLine — 订单级优惠券按行应付比例摊算', () => {
  test('无券 → 全 0', () => {
    expect(allocateCouponPerLine([100, 200, 300], 0)).toEqual([0, 0, 0])
  })

  test('券 < 总额：守恒 + 末行吸收尾差', () => {
    const r = allocateCouponPerLine([100, 200, 300], 60)
    expect(r.length).toBe(3)
    const sum = Math.round(r.reduce((s, x) => s + x, 0) * 100) / 100
    expect(sum).toBe(60)
    expect(r[0]).toBe(10)
    expect(r[1]).toBe(20)
  })

  test('券 > 总额 → 截断到总额', () => {
    const r = allocateCouponPerLine([100], 200)
    expect(r[0]).toBe(100)
  })

  test('负数券 → 全 0', () => {
    expect(allocateCouponPerLine([100, 100], -10)).toEqual([0, 0])
  })

  test('单行', () => {
    expect(allocateCouponPerLine([300], 30)).toEqual([30])
  })

  test('精度尾差由末行吸收（守恒）', () => {
    // 3 行同价 100，券 10 → raw share = 3.333... 前两行 round 后 3.33，末行吸收尾差
    const r = allocateCouponPerLine([100, 100, 100], 10)
    const sum = Math.round(r.reduce((s, x) => s + x, 0) * 100) / 100
    expect(sum).toBe(10)
  })
})
