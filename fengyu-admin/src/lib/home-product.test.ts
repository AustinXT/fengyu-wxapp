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
})
