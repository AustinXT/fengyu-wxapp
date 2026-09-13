import { describe, expect, it } from 'vitest'
import { deriveHomeProductStatus } from './home-product'

describe('deriveHomeProductStatus', () => {
  it.each([
    [true, 0, 0, 2, 2, null, '退款处理中'],
    [false, 0, 0, 2, 2, null, '待提货'],
    [false, 1, 0, 1, 1, null, '部分提货'],
    [false, 2, 0, 0, 0, null, '已提货'],
    [false, 1, 1, 0, 0, null, '已完成'],
  ] as const)(
    '按已付待提进度派生状态',
    (refundPending, picked, refunded, pendingPickup, remaining, unpaid, expected) => {
      expect(
        deriveHomeProductStatus(refundPending, picked, refunded, pendingPickup, remaining, unpaid),
      ).toBe(expected)
    },
  )

  // issue #120：部分支付导致 paid_quantity=0 的行以前被 SQL 整行过滤掉，放行后必须
  // 落到「待付清」而不是被误判成「已提货」。「待付清」与欠款金额绑定——算不出欠款就不能这么标。
  it.each([
    // 买 1 件未付清：没提过货、没退过款、份额还在，且确实欠钱
    [false, 0, 0, 0, 1, 380, '待付清'],
    // 买 3 件付款不足一件
    [false, 0, 0, 0, 3, 900, '待付清'],
    // 已提 2 件但第 3 件没付清：状态要跟着欠款走，不能标「已提货」后再挂一个矛盾的欠款提示
    [false, 2, 0, 0, 1, 100, '待付清'],
    // 退款处理中优先级最高
    [true, 0, 0, 0, 1, 380, '退款处理中'],
  ] as const)(
    '有欠款的未交付份额落到待付清',
    (refundPending, picked, refunded, pendingPickup, remaining, unpaid, expected) => {
      expect(
        deriveHomeProductStatus(refundPending, picked, refunded, pendingPickup, remaining, unpaid),
      ).toBe(expected)
    },
  )

  // 寄存单的 sale_amount 只是原价快照、received 是历史值，相减不是欠款（SQL 已把 unpaid 置 NULL）。
  // 这类行有未交付份额但不欠钱，必须是「待提货」——既不能标「待付清」伪造债务，也不能标「已完成」。
  it.each([
    // 寄存单：1 件未提，不欠钱
    [false, 0, 0, 0, 1, null, '待提货'],
    // 寄存单：27 件未提
    [false, 0, 0, 0, 27, null, '待提货'],
    // 退过款且仍有剩余份额：unpaid 被短路成 null，不能落「已完成」
    [false, 0, 1, 0, 2, null, '待提货'],
    // 欠款为 0（已付清）但还有份额未提
    [false, 0, 0, 0, 1, 0, '待提货'],
  ] as const)(
    '算不出欠款的未交付份额落到待提货而非待付清或已完成',
    (refundPending, picked, refunded, pendingPickup, remaining, unpaid, expected) => {
      expect(
        deriveHomeProductStatus(refundPending, picked, refunded, pendingPickup, remaining, unpaid),
      ).toBe(expected)
    },
  )

  it('份额已结清且未提未退时兜底为已提货', () => {
    expect(deriveHomeProductStatus(false, 0, 0, 0, 0, null)).toBe('已提货')
  })
})
