import { calcCartTotal, calcHalfPriceTotal } from '../../utils/cart-calc'

describe('calcCartTotal', () => {
  test('多商品计算总价和数量', () => {
    const cart = [
      { price: 100, quantity: 2, discount: 0 },
      { price: 50, quantity: 3, discount: 0 },
    ]
    const result = calcCartTotal(cart)
    expect(result.count).toBe(5)
    expect(result.total).toBe('350.00')
  })

  test('带折扣计算', () => {
    const cart = [
      { price: 100, quantity: 2, discount: 30 },
      { price: 50, quantity: 1, discount: 10 },
    ]
    const result = calcCartTotal(cart)
    expect(result.count).toBe(3)
    // (100*2 - 30) + (50*1 - 10) = 170 + 40 = 210
    expect(result.total).toBe('210.00')
  })

  test('空购物车', () => {
    const result = calcCartTotal([])
    expect(result.count).toBe(0)
    expect(result.total).toBe('0.00')
  })

  test('单个商品', () => {
    const cart = [{ price: 99.9, quantity: 1, discount: 0 }]
    const result = calcCartTotal(cart)
    expect(result.count).toBe(1)
    expect(result.total).toBe('99.90')
  })

  test('折扣等于总价时为零', () => {
    const cart = [{ price: 100, quantity: 1, discount: 100 }]
    const result = calcCartTotal(cart)
    expect(result.count).toBe(1)
    expect(result.total).toBe('0.00')
  })

  test('浮点数精度', () => {
    const cart = [
      { price: 0.1, quantity: 3, discount: 0 },
    ]
    const result = calcCartTotal(cart)
    expect(result.count).toBe(3)
    // 0.1 * 3 = 0.30000000000000004 → toFixed(2) = '0.30'
    expect(result.total).toBe('0.30')
  })
})

describe('calcHalfPriceTotal（内部单 5 折；PR-C §C2）', () => {
  test('多商品 5 折合计', () => {
    const cart = [
      { price: 100, quantity: 2, discount: 0 },
      { price: 50, quantity: 3, discount: 0 },
    ]
    // (100*0.5*2) + (50*0.5*3) = 100 + 75 = 175
    expect(calcHalfPriceTotal(cart)).toBe('175.00')
  })

  test('空购物车', () => {
    expect(calcHalfPriceTotal([])).toBe('0.00')
  })

  test('discount 仍从半价再减（残值防御）', () => {
    // 即使前端 disabled，残留 discount 仍参与计算
    const cart = [{ price: 100, quantity: 2, discount: 10 }]
    // 100*0.5*2 - 10 = 90
    expect(calcHalfPriceTotal(cart)).toBe('90.00')
  })

  test('奇数价格 5 折防浮点（半舍入策略：Math.round 向上）', () => {
    // 99.99 × 50 = 4999.5 → Math.round = 5000 → /100 = 50.00
    const cart = [{ price: 99.99, quantity: 1, discount: 0 }]
    expect(calcHalfPriceTotal(cart)).toBe('50.00')
  })
})
