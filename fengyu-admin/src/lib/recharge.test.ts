import { describe, it, expect } from 'vitest'
import {
  matchTier,
  parseRechargeFaceValue,
  RECHARGE_TIERS,
  RECHARGE_MIN_AMOUNT,
  RECHARGE_MAX_AMOUNT,
  RECHARGE_VIRTUAL_SKU_ID,
} from './recharge'

describe('matchTier — 档位匹配（与 client card.js 同源）', () => {
  it('500 元 → 9.9 折，实付 495', () => {
    expect(matchTier(500)).toEqual({ discount: 0.99, payAmount: 495 })
  })

  it('999 元 → 仍命中 9.9 折档位', () => {
    expect(matchTier(999)).toEqual({ discount: 0.99, payAmount: 989.01 })
  })

  it('1000 元 → 9.8 折，实付 980', () => {
    expect(matchTier(1000)).toEqual({ discount: 0.98, payAmount: 980 })
  })

  it('4999 元 → 仍命中 9.8 折档位', () => {
    expect(matchTier(4999)).toEqual({ discount: 0.98, payAmount: 4899.02 })
  })

  it('5000 元 → 9.5 折，实付 4750', () => {
    expect(matchTier(5000)).toEqual({ discount: 0.95, payAmount: 4750 })
  })

  it('100000 元（上限）→ 9.5 折，实付 95000', () => {
    expect(matchTier(100000)).toEqual({ discount: 0.95, payAmount: 95000 })
  })

  it('499 元（低于最低） → 抛 INVALID_PARAMS', () => {
    expect(() => matchTier(499)).toThrow(/INVALID_PARAMS: 最低充值金额 ¥500/)
  })

  it('100001 元（超上限） → 抛 INVALID_PARAMS', () => {
    expect(() => matchTier(100001)).toThrow(/INVALID_PARAMS: 单次充值上限 ¥100000/)
  })

  it('超过 2 位小数 → 抛 INVALID_PARAMS', () => {
    expect(() => matchTier(500.123)).toThrow(/保留 2 位小数/)
  })

  it('非数字 → 抛 INVALID_PARAMS', () => {
    expect(() => matchTier(NaN)).toThrow(/INVALID_PARAMS/)
    expect(() => matchTier(Infinity)).toThrow(/INVALID_PARAMS/)
  })

  it('自定义金额 888 元（9.9 折档） → 实付 879.12', () => {
    expect(matchTier(888)).toEqual({ discount: 0.99, payAmount: 879.12 })
  })
})

describe('parseRechargeFaceValue — 从 product_name 提取面值', () => {
  it('标准格式 "预付充值卡 ¥500" → 500', () => {
    expect(parseRechargeFaceValue('预付充值卡 ¥500')).toBe(500)
  })

  it('面值带小数 → 原样返回', () => {
    expect(parseRechargeFaceValue('预付充值卡 ¥888.88')).toBe(888.88)
  })

  it('¥ 符号后含空格 → 支持', () => {
    expect(parseRechargeFaceValue('预付充值卡 ¥ 1000')).toBe(1000)
  })

  it('null / undefined / 空串 → null', () => {
    expect(parseRechargeFaceValue(null)).toBeNull()
    expect(parseRechargeFaceValue(undefined)).toBeNull()
    expect(parseRechargeFaceValue('')).toBeNull()
  })

  it('无面值标识 → null', () => {
    expect(parseRechargeFaceValue('普通商品')).toBeNull()
  })

  it('面值为 0 或负数 → null', () => {
    expect(parseRechargeFaceValue('预付充值卡 ¥0')).toBeNull()
  })
})

describe('常量 — 与 client card.js/_constants.js 保持同步', () => {
  it('RECHARGE_VIRTUAL_SKU_ID 固定为 sku-recharge-virtual', () => {
    expect(RECHARGE_VIRTUAL_SKU_ID).toBe('sku-recharge-virtual')
  })

  it('RECHARGE_TIERS 覆盖 500/1000/5000 三档', () => {
    expect(RECHARGE_TIERS.map((t) => t.faceValue)).toEqual([500, 1000, 5000])
    expect(RECHARGE_TIERS.map((t) => t.discount)).toEqual([0.99, 0.98, 0.95])
  })

  it('金额区间 500-100000', () => {
    expect(RECHARGE_MIN_AMOUNT).toBe(500)
    expect(RECHARGE_MAX_AMOUNT).toBe(100000)
  })
})
