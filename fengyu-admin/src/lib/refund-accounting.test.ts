import { describe, expect, it } from 'vitest'
import { allocateRefundAccounting } from './refund-accounting'

describe('退款手续费按实付分摊', () => {
  it('按实付而非退款毛额；扣除金额独立且净额勾稽', () => {
    const result = allocateRefundAccounting([
      { refSaleItemId: 'A', refundAmount: 100 }, { refSaleItemId: 'B', refundAmount: 100 },
    ], new Map([['A', 300], ['B', 100]]), 20, 10)
    expect(result.map(r => r.handlingFee)).toEqual([15, 5])
    expect(result.reduce((s, r) => s + r.netRefundAmount, 0)).toBe(170)
    expect(result.reduce((s, r) => s + r.overdraftDeduction, 0)).toBe(10)
  })
  it('低退款项封顶；零元项不承担；尾差不依赖输入顺序', () => {
    const items = [{ refSaleItemId: 'A', refundAmount: 0.01 },
      { refSaleItemId: 'B', refundAmount: 10 }, { refSaleItemId: 'C', refundAmount: 0 }]
    const paid = new Map([['A', 1000], ['B', 10], ['C', 100]])
    const result = allocateRefundAccounting(items, paid, 1)
    expect(result.map(r => r.handlingFee)).toEqual([0.01, 0.99, 0])
    expect(allocateRefundAccounting([...items].reverse(), paid, 1).reverse()).toEqual(result)
  })
  it('截图余数场景：毛退214，手续费100，净退114，数量仍为0', () => {
    expect(allocateRefundAccounting([{ refSaleItemId: 'A', refundAmount: 214, quantity: 0 }],
      new Map([['A', 3000]]), 100)[0]).toMatchObject({ handlingFee: 100, netRefundAmount: 114, quantity: 0 })
  })
  it('拒绝无实付归属、超额及非有限手续费', () => {
    const items = [{ refSaleItemId: 'A', refundAmount: 10 }]
    expect(() => allocateRefundAccounting([...items, ...items], new Map([['A', 20]]), 1)).toThrow('不能重复')
    expect(() => allocateRefundAccounting(items, new Map(), 1)).toThrow('缺少')
    expect(() => allocateRefundAccounting(items, new Map([['A', 10]]), 11)).toThrow('超过')
    expect(() => allocateRefundAccounting(items, new Map([['A', 10]]), Infinity)).toThrow('不合法')
  })
})
