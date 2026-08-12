import { describe, expect, it } from 'vitest'
import { calculateSaleCashAmount, requiresOfflineCardOnlyConfirmation } from './payment-calculation'

describe('calculateSaleCashAmount', () => {
  it('从本次实付中扣除预选充值卡抵扣', () => {
    expect(calculateSaleCashAmount(50, 30, 70)).toBe(20)
  })

  it('不会超过整单剩余应收现金', () => {
    expect(calculateSaleCashAmount(100, 0, 70)).toBe(70)
  })

  it('本次实付全由充值卡覆盖时现金为零', () => {
    expect(calculateSaleCashAmount(50, 50, 50)).toBe(0)
  })
})

describe('requiresOfflineCardOnlyConfirmation', () => {
  it('卡-only 部分付款要求线下确认，避免线上二维码收取整笔应收', () => {
    expect(requiresOfflineCardOnlyConfirmation(50, 0, 50)).toBe(true)
  })

  it('全额储值卡抵扣和仍有现金首付时不触发', () => {
    expect(requiresOfflineCardOnlyConfirmation(100, 0, 0)).toBe(false)
    expect(requiresOfflineCardOnlyConfirmation(30, 20, 70)).toBe(false)
  })
})
