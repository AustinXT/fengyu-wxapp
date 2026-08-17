import { describe, expect, it } from 'vitest'
import {
  calculateTreatmentTierLineAmounts,
  type TreatmentTierCandidate,
  type TreatmentTierLine,
} from './treatment-tier-pricing'

function line(sessionCount: number, overrides: Partial<TreatmentTierLine> = {}): TreatmentTierLine {
  return {
    categoryId: 'cat-tier',
    specName: '年轻态慕慕霜-ZX',
    productType: '疗程卡',
    sessionCount,
    quantity: 1,
    ...overrides,
  }
}

function candidate(
  sessionCount: number,
  price: number,
  overrides: Partial<TreatmentTierCandidate> = {},
): TreatmentTierCandidate {
  return {
    categoryId: 'cat-tier',
    specName: '年轻态慕慕霜-ZX',
    productType: '疗程卡',
    sessionCount,
    price,
    specialPrice: null,
    ...overrides,
  }
}

describe('calculateTreatmentTierLineAmounts', () => {
  it('1 次卡 + 2 次卡累计命中 2 次档', () => {
    expect(calculateTreatmentTierLineAmounts(
      [line(1), line(2)],
      [candidate(1, 580), candidate(2, 596)],
      false,
      '销售单',
    )).toEqual([298, 596])
  })

  it('30 次档购买两份按 60 次线性累计', () => {
    expect(calculateTreatmentTierLineAmounts(
      [line(30, { quantity: 2 })],
      [candidate(30, 8800)],
      false,
      '销售单',
    )).toEqual([17600])
  })

  it('会员使用档位会员价，同次数档优先单次价最低者', () => {
    expect(calculateTreatmentTierLineAmounts(
      [line(1), line(2)],
      [candidate(2, 700, { specialPrice: 600 }), candidate(2, 650, { specialPrice: 500 })],
      true,
      '转换单',
    )).toEqual([250, 500])
  })

  it('会员命中零元档位时保留零元成交价', () => {
    expect(calculateTreatmentTierLineAmounts(
      [line(1), line(2)],
      [candidate(2, 596, { specialPrice: 0 })],
      true,
      '销售单',
    )).toEqual([0, 0])
  })

  it('非有限或负数档位价不覆盖原计价', () => {
    expect(calculateTreatmentTierLineAmounts(
      [line(2)],
      [candidate(2, Number.POSITIVE_INFINITY)],
      false,
      '销售单',
    )).toEqual([null])
    expect(calculateTreatmentTierLineAmounts(
      [line(2)],
      [candidate(2, -1)],
      false,
      '销售单',
    )).toEqual([null])
  })

  it('体验卡、店长特价、套餐与内部单不参与梯度', () => {
    const candidates = [candidate(2, 596)]
    expect(calculateTreatmentTierLineAmounts(
      [
        line(1, { isExperience: true }),
        line(1, { isManagerSpecial: true }),
        line(1, { isBundle: true }),
      ],
      candidates,
      false,
      '销售单',
    )).toEqual([null, null, null])
    expect(calculateTreatmentTierLineAmounts([line(2)], candidates, false, '内部单')).toEqual([null])
  })

  it('无可用档位时返回 null 让调用方回退原价', () => {
    expect(calculateTreatmentTierLineAmounts(
      [line(1)],
      [candidate(5, 1000)],
      false,
      '销售单',
    )).toEqual([null])
  })
})
