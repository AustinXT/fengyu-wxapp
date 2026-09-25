import { describe, expect, it } from 'vitest'
import { allocateConversionLinks, summarizeConversion, suggestConversionUnitPrice, uncoveredConversionTargets } from './conversion-plan'

describe('库存转换成本守恒（#344）', () => {
  it('13A(10) + 13B(20) → 13 套：预填单价 30，严格相等', () => {
    const sources = [{ quantity: 13, unitCost: 10 }, { quantity: 13, unitCost: 20 }]
    const price = suggestConversionUnitPrice(summarizeConversion(sources, []).sourceAmount, 13)
    expect(price).toBe(30)
    const balance = summarizeConversion(sources, [{ quantity: 13, unitPrice: price! }])
    expect(balance).toMatchObject({ sourceAmount: 390, targetAmount: 390, difference: 0, balanced: true })
  })

  it('一瓶(50) 拆 2 个半瓶：预填 25', () => {
    const sources = [{ quantity: 1, unitCost: 50 }]
    expect(suggestConversionUnitPrice(50, 2)).toBe(25)
    expect(summarizeConversion(sources, [{ quantity: 2, unitPrice: 25 }]).balanced).toBe(true)
  })

  it('除不尽：100 拆 7 件，预填 14.29 的差额落在允许误差内；再多 1 分/件就超出', () => {
    const sources = [{ quantity: 1, unitCost: 100 }]
    const price = suggestConversionUnitPrice(100, 7)!
    expect(price).toBe(14.29)
    const ok = summarizeConversion(sources, [{ quantity: 7, unitPrice: price }])
    expect(ok.difference).toBeCloseTo(0.03, 6)
    expect(ok.tolerance).toBe(0.03) // 允许误差 = 按预填价的不可避免差额
    expect(ok.balanced).toBe(true)
    // 人为改价 14.30 → 差额 0.10，超出 0.03；14.28 → 差 -0.04，比预填更偏离，也拒
    expect(summarizeConversion(sources, [{ quantity: 7, unitPrice: 14.28 }]).balanced).toBe(false)
    expect(summarizeConversion(sources, [{ quantity: 7, unitPrice: 14.3 }]).balanced).toBe(false)
  })

  it('一盒(90) 拆三种单件，各自单价自填，只看合计', () => {
    const sources = [{ quantity: 1, unitCost: 90 }]
    const targets = [
      { quantity: 1, unitPrice: 20 },
      { quantity: 1, unitPrice: 30 },
      { quantity: 1, unitPrice: 40 },
    ]
    expect(summarizeConversion(sources, targets).balanced).toBe(true)
    expect(summarizeConversion(sources, [...targets.slice(0, 2), { quantity: 1, unitPrice: 41 }]).balanced).toBe(false)
  })

  it('允许误差下限 1 分：差 1 分放行，差 2 分拒绝', () => {
    const sources = [{ quantity: 1, unitCost: 10 }]
    expect(summarizeConversion(sources, [{ quantity: 1, unitPrice: 10.01 }]).balanced).toBe(true)
    expect(summarizeConversion(sources, [{ quantity: 1, unitPrice: 10.02 }]).balanced).toBe(false)
    expect(summarizeConversion(sources, [{ quantity: 1, unitPrice: 9.98 }]).balanced).toBe(false)
  })

  it('手改单价可以比预填更接近守恒：100 拆成 6 件 14.29 + 1 件 14.26 = 100.00', () => {
    const balance = summarizeConversion([{ quantity: 1, unitCost: 100 }], [{ quantity: 6, unitPrice: 14.29 }, { quantity: 1, unitPrice: 14.26 }])
    expect(balance).toMatchObject({ difference: 0, balanced: true })
  })

  it('不能借舍入放大成本：来源 1 件 0.01 拆 3 件，预填 0.00（差 1 分）；按 0.01 填差 2 分被拒', () => {
    const sources = [{ quantity: 1, unitCost: 0.01 }]
    expect(suggestConversionUnitPrice(0.01, 3)).toBe(0)
    expect(summarizeConversion(sources, [{ quantity: 3, unitPrice: 0 }]).balanced).toBe(true)
    expect(summarizeConversion(sources, [{ quantity: 3, unitPrice: 0.01 }]).balanced).toBe(false)
    // 低成本大数量：1.00 拆 1000 件，拆成 500 件 0.01 + 500 件 0（合计 5.00）被拒
    expect(summarizeConversion([{ quantity: 1, unitCost: 1 }], [{ quantity: 500, unitPrice: 0.01 }, { quantity: 500, unitPrice: 0 }]).balanced).toBe(false)
  })

  it('大数不失真（BigInt）：9999999999.99 × 9999999999.99 仍逐分精确，并标出超出 numeric(12,2)', () => {
    const big = summarizeConversion([{ quantity: 9999999999.99, unitCost: 1 }], [{ quantity: 9999999999.99, unitPrice: 1 }])
    expect(big).toMatchObject({ difference: 0, balanced: true, exceedsAmountLimit: false })
    const huge = summarizeConversion([{ quantity: 100000, unitCost: 100000 }], [{ quantity: 100000, unitPrice: 100000 }])
    expect(huge.exceedsAmountLimit).toBe(true)
    expect(huge.balanced).toBe(true)
  })

  it('逐行 ROUND 到分后再合计（与 0043 触发器同口径）：0.5 × 0.01 行金额取 0.01', () => {
    // 0.5 × 0.01 = 0.005 → ROUND 远离 0 = 0.01
    expect(summarizeConversion([{ quantity: 0.5, unitCost: 0.01 }], []).sourceAmount).toBe(0.01)
    // 浮点残差不影响：0.1 + 0.2 数量
    expect(summarizeConversion([{ quantity: 0.3, unitCost: 10 }], []).sourceAmount).toBe(3)
  })

  it('赠送来源（成本 0）→ 目标单价 0 守恒', () => {
    expect(suggestConversionUnitPrice(0, 3)).toBe(0)
    expect(summarizeConversion([{ quantity: 3, unitCost: 0 }], [{ quantity: 3, unitPrice: 0 }]).balanced).toBe(true)
  })

  it('目标数量为 0 时不预填', () => {
    expect(suggestConversionUnitPrice(100, 0)).toBeNull()
  })

  it('性质：任意来源合计 / 目标数量组合，统一预填单价都落在允许误差内', () => {
    for (const sourceCents of [1, 99, 100, 3333, 10001, 123457, 999999]) {
      for (const quantities of [[1], [3], [7], [0.5, 0.5], [12, 13], [1, 1, 1], [0.33, 0.67], [2.5, 3.25, 4]]) {
        const sourceAmount = sourceCents / 100
        const total = quantities.reduce((sum, value) => sum + value, 0)
        const price = suggestConversionUnitPrice(sourceAmount, total)!
        const balance = summarizeConversion(
          [{ quantity: 1, unitCost: sourceAmount }],
          quantities.map((quantity) => ({ quantity, unitPrice: price })),
        )
        expect(balance.balanced, `${sourceAmount} → ${quantities.join('+')} @ ${price}`).toBe(true)
      }
    }
  })
})

describe('库存转换血缘分摊（#344）', () => {
  function sumBySource(shares: ReturnType<typeof allocateConversionLinks>) {
    const totals = new Map<number, number>()
    for (const share of shares) totals.set(share.sourceIndex, Math.round(((totals.get(share.sourceIndex) ?? 0) + share.quantity) * 100) / 100)
    return totals
  }

  it('13A + 13B → 13 套：两条来源各关联目标 13', () => {
    expect(allocateConversionLinks([13, 13], [13])).toEqual([
      { sourceIndex: 0, targetIndex: 0, quantity: 13 },
      { sourceIndex: 1, targetIndex: 0, quantity: 13 },
    ])
  })

  it('25 → 12 X + 13 Y：按目标数量拆成 12 / 13', () => {
    expect(allocateConversionLinks([25], [12, 13])).toEqual([
      { sourceIndex: 0, targetIndex: 0, quantity: 12 },
      { sourceIndex: 0, targetIndex: 1, quantity: 13 },
    ])
  })

  it('一瓶拆 2 个半瓶：关联数量记来源的 1，不是目标的 2（不触发 0043 数量上限）', () => {
    expect(allocateConversionLinks([1], [2])).toEqual([{ sourceIndex: 0, targetIndex: 0, quantity: 1 }])
  })

  it('一盒拆三种单件：0.34 / 0.33 / 0.33，合计恰好等于来源数量', () => {
    const shares = allocateConversionLinks([1], [1, 1, 1])
    expect(shares.map((share) => share.quantity)).toEqual([0.34, 0.33, 0.33])
    expect(sumBySource(shares).get(0)).toBe(1)
  })

  it('分摊为 0 的配对不建关联（doc_links 要求 quantity > 0），并能列出分不到来源的目标', () => {
    const shares = allocateConversionLinks([0.01], [1, 1, 1])
    expect(shares).toEqual([{ sourceIndex: 0, targetIndex: 0, quantity: 0.01 }])
    expect(uncoveredConversionTargets(shares, 3)).toEqual([1, 2])
    expect(uncoveredConversionTargets(allocateConversionLinks([1], [1, 1, 1]), 3)).toEqual([])
  })

  it('大数量分摊不失真：9999999999.99 分给 3 个目标，合计恰好等于来源', () => {
    const shares = allocateConversionLinks([9999999999.99], [3333333333.33, 3333333333.33, 3333333333.33])
    expect(Math.round(shares.reduce((sum, share) => sum + share.quantity * 100, 0))).toBe(999999999999)
  })

  it('性质：每条来源的关联合计恒等于来源数量，且每条都 > 0', () => {
    const cases: Array<[number[], number[]]> = [
      [[13, 13], [13]], [[25], [12, 13]], [[1], [1, 1, 1]], [[0.07, 3.33, 10], [0.5, 0.25, 7, 1]], [[99.99], [33.33, 33.33, 33.33]],
    ]
    for (const [sources, targets] of cases) {
      const shares = allocateConversionLinks(sources, targets)
      expect(shares.every((share) => share.quantity > 0)).toBe(true)
      const totals = sumBySource(shares)
      sources.forEach((quantity, index) => expect(totals.get(index)).toBe(quantity))
    }
  })
})
