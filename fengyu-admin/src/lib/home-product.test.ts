import { describe, expect, it } from 'vitest'
import { deriveHomeProductStatus } from './home-product'

describe('deriveHomeProductStatus', () => {
  it.each([
    [true, 0, 0, 2, '退款处理中'],
    [false, 0, 0, 2, '待提货'],
    [false, 1, 0, 1, '部分提货'],
    [false, 2, 0, 0, '已提货'],
    [false, 1, 1, 0, '已完成'],
  ] as const)('按已付待提进度派生状态', (refundPending, picked, refunded, pendingPickup, expected) => {
    expect(deriveHomeProductStatus(refundPending, picked, refunded, pendingPickup)).toBe(expected)
  })

  // #125：转换折抵与退款同源于 picked_up_quantity，整行折抵后 pending 归零、refunded 为 0，
  // 若不看 convertedQuantity 会把「已转走」误判成「已提货」。
  it.each([
    // refundPending, picked, refunded, pendingPickup, converted, expected
    [false, 0, 0, 0, 7, '已完成'],   // 从未提货、整行折抵
    [false, 3, 0, 0, 7, '已完成'],   // 提 3 + 转 7
    [false, 2, 0, 0, 0, '已提货'],   // 无转换无退款 → 仍是已提货
    [false, 1, 0, 1, 5, '部分提货'], // 还有待提时，待提优先
    [true, 0, 0, 0, 5, '退款处理中'], // 在途退款最高优先级
  ] as const)('已转换数量参与状态派生', (refundPending, picked, refunded, pendingPickup, converted, expected) => {
    expect(deriveHomeProductStatus(refundPending, picked, refunded, pendingPickup, converted)).toBe(expected)
  })

  it('第 5 参缺省时保持旧行为（既有调用点不受影响）', () => {
    expect(deriveHomeProductStatus(false, 2, 0, 0)).toBe('已提货')
  })
})
