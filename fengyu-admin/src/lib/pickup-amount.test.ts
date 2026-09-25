import { describe, expect, it } from 'vitest'
import { pickupAmountSnapshot } from './pickup-amount'

// #341：与 staffApi `__tests__/routes/order.test.js` 的 pickupAmountSnapshot 用例逐条相同
describe('#341 pickupAmountSnapshot（与 staffApi 副本同一组用例）', () => {
  it('88.50 × 2 = 177.00', () => {
    expect(pickupAmountSnapshot('88.50', 2)).toEqual({ unitPrice: '88.50', amount: '177.00' })
    expect(pickupAmountSnapshot(88.5, 2)).toEqual({ unitPrice: '88.50', amount: '177.00' })
  })

  it('按分计算，不带浮点尾差', () => {
    expect(pickupAmountSnapshot(19.99, 3)).toEqual({ unitPrice: '19.99', amount: '59.97' })
    expect(pickupAmountSnapshot(0.1, 3)).toEqual({ unitPrice: '0.10', amount: '0.30' })
    // 0.07 * 100 = 7.000000000000001：舍入方向错成 ceil 会冻结 0.08 / 0.16（#341 评审 round-8）
    expect(pickupAmountSnapshot(0.07, 2)).toEqual({ unitPrice: '0.07', amount: '0.14' })
    expect(pickupAmountSnapshot('0.07', 2)).toEqual({ unitPrice: '0.07', amount: '0.14' })
  })

  it('0 元行冻结为 0，不是 NULL', () => {
    expect(pickupAmountSnapshot(0, 4)).toEqual({ unitPrice: '0.00', amount: '0.00' })
    expect(pickupAmountSnapshot('0.00', 1)).toEqual({ unitPrice: '0.00', amount: '0.00' })
  })

  it('单价缺失或数量非法直接拒绝', () => {
    for (const price of [null, undefined, '', '  ', 'abc']) {
      expect(() => pickupAmountSnapshot(price, 1)).toThrow(/INVALID_STATE/)
    }
    for (const qty of [0, -1, 1.5, '2' as unknown as number]) {
      expect(() => pickupAmountSnapshot('10.00', qty)).toThrow(/INVALID_STATE/)
    }
  })
})
