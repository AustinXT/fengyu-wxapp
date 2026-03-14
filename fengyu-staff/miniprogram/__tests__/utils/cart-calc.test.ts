import { calcCartTotal } from '../../utils/cart-calc'

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
