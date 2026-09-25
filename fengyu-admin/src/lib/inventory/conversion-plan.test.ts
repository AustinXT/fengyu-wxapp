import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allocateConversionLinks,
  conversionLineAmount,
  formatConversionAmount,
  summarizeConversion,
  splitTargetForExactConservation,
  suggestConversionUnitPrice,
  uncoveredConversionTargets,
} from './conversion-plan'

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

  it('严格 1 分：100 拆 7 件，统一预填 14.29 差 0.03 被拒；拆分补差成 3 件 14.28 + 4 件 14.29 = 100.00', () => {
    const sources = [{ quantity: 1, unitCost: 100 }]
    expect(suggestConversionUnitPrice(100, 7)).toBe(14.29)
    const prefilled = summarizeConversion(sources, [{ quantity: 7, unitPrice: 14.29 }])
    expect(prefilled).toMatchObject({ difference: 0.03, tolerance: 0.01, balanced: false })
    const split = splitTargetForExactConservation(sources, [{ quantity: 7, unitPrice: 14.29 }], 0)
    expect(split).toEqual({ low: { quantity: 3, unitPrice: 14.28 }, high: { quantity: 4, unitPrice: 14.29 } })
    expect(summarizeConversion(sources, [split!.low, split!.high!])).toMatchObject({ difference: 0, balanced: true })
  })

  it('拍板原例：成本 0.03 × 1 万件拆 2 万件，精确单价 0.015 → 1 万件 0.01 + 1 万件 0.02 = 300.00', () => {
    const sources = [{ quantity: 10000, unitCost: 0.03 }]
    expect(summarizeConversion(sources, [{ quantity: 20000, unitPrice: 0.02 }]).balanced).toBe(false) // 预填 0.02 差 100 元
    const split = splitTargetForExactConservation(sources, [{ quantity: 20000, unitPrice: 0.02 }], 0)
    expect(split).toEqual({ low: { quantity: 10000, unitPrice: 0.01 }, high: { quantity: 10000, unitPrice: 0.02 } })
  })

  it('拆分补差：能用单一单价守恒时不拆行；其它目标已超过来源合计时返回 null；小数数量按 0.01 拆', () => {
    expect(splitTargetForExactConservation([{ quantity: 13, unitCost: 30 }], [{ quantity: 13, unitPrice: 0 }], 0))
      .toEqual({ low: { quantity: 13, unitPrice: 30 }, high: null })
    expect(splitTargetForExactConservation([{ quantity: 1, unitCost: 10 }], [{ quantity: 1, unitPrice: 20 }, { quantity: 1, unitPrice: 0 }], 1)).toBeNull()
    const split = splitTargetForExactConservation([{ quantity: 1, unitCost: 1 }], [{ quantity: 0.3, unitPrice: 0 }], 0)!
    expect(summarizeConversion([{ quantity: 1, unitCost: 1 }], [split.low, ...(split.high ? [split.high] : [])]).difference).toBe(0)
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

  it('行金额（单据展示口径）逐行 ROUND 远离 0，与 0043 触发器一致；守恒用精确值', () => {
    expect(conversionLineAmount(0.5, 0.01)).toBe(0.01) // 0.005 → 0.01
    expect(conversionLineAmount(0.01, -0.5)).toBe(-0.01) // -0.005 → -0.01（PG ROUND 远离 0）
    expect(conversionLineAmount(0.3, 10)).toBe(3) // 浮点残差不影响
    expect(summarizeConversion([{ quantity: 0.5, unitCost: 0.01 }], []).sourceAmount).toBe(0.005)
  })

  it('拆行不能借舍入放大来源成本：同一批次 1 件 × 0.50 拆成 100 行 0.01，精确合计仍是 0.50', () => {
    const split = Array.from({ length: 100 }, () => ({ quantity: 0.01, unitCost: 0.5 }))
    const balance = summarizeConversion(split, [{ quantity: 1, unitPrice: 1 }])
    expect(balance.sourceAmount).toBe(0.5)
    expect(balance.balanced).toBe(false)
    expect(summarizeConversion(split, [{ quantity: 1, unitPrice: 0.5 }]).balanced).toBe(true)
  })

  it('拆行不能借舍入缩小目标成本：目标 100 行 0.01 × 0.50（逐行各进位成 0.01）精确合计只有 0.50', () => {
    const targets = Array.from({ length: 100 }, () => ({ quantity: 0.01, unitPrice: 0.5 }))
    const balance = summarizeConversion([{ quantity: 1, unitCost: 1 }], targets)
    expect(balance.targetAmount).toBe(0.5)
    expect(balance.balanced).toBe(false)
  })

  it('formatConversionAmount：整分两位、不足一分四位', () => {
    expect(formatConversionAmount(390)).toBe('390.00')
    expect(formatConversionAmount(0.005)).toBe('0.0050')
    expect(formatConversionAmount(-0.03)).toBe('-0.03')
  })

  it('赠送来源（成本 0）→ 目标单价 0 守恒', () => {
    expect(suggestConversionUnitPrice(0, 3)).toBe(0)
    expect(summarizeConversion([{ quantity: 3, unitCost: 0 }], [{ quantity: 3, unitPrice: 0 }]).balanced).toBe(true)
  })

  it('目标数量为 0 时不预填', () => {
    expect(suggestConversionUnitPrice(100, 0)).toBeNull()
  })

  it('性质（随机 3000 例）：对任一目标行拆分补差后，目标合计与来源精确合计之差 ≤ 0.01', () => {
    let seed = 20260925
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const amount = (max: number) => Math.max(1, Math.floor(random() ** 2 * max)) / 100
    for (let round = 0; round < 3000; round += 1) {
      const sources = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ quantity: amount(100000), unitCost: amount(50000) }))
      const sourceTotal = summarizeConversion(sources, []).sourceAmount
      const integer = random() < 0.5
      const targets = Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
        quantity: integer ? Math.max(1, Math.floor(random() * 500)) : amount(50000),
        unitPrice: 0,
      }))
      // 除被拆行外的目标按预填价，被拆行随机选
      const suggested = suggestConversionUnitPrice(sourceTotal, targets.reduce((sum, target) => sum + target.quantity, 0)) ?? 0
      const priced = targets.map((target) => ({ ...target, unitPrice: Math.max(0, suggested - 0.01) }))
      const index = Math.floor(random() * priced.length)
      const split = splitTargetForExactConservation(sources, priced, index)
      if (!split) continue
      const rows = priced.flatMap((target, targetIndex) => (targetIndex === index ? [split.low, ...(split.high ? [split.high] : [])] : [target]))
      const balance = summarizeConversion(sources, rows)
      expect(balance.balanced, `${JSON.stringify(sources)} → ${JSON.stringify(rows)} diff ${balance.difference}`).toBe(true)
      expect(rows.every((row) => row.quantity > 0 && row.unitPrice >= 0)).toBe(true)
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

  it('跨来源协调：来源 [0.01, 0.01] → 目标 [1, 1] 各分到一条（不会都挤到靠前目标）', () => {
    const shares = allocateConversionLinks([0.01, 0.01], [1, 1])
    expect(shares).toEqual([
      { sourceIndex: 0, targetIndex: 0, quantity: 0.01 },
      { sourceIndex: 1, targetIndex: 1, quantity: 0.01 },
    ])
  })

  it('补位：来源 [0.03] → 目标 [100, 1, 1]，大目标让出 0.01，三个目标都有关联', () => {
    const shares = allocateConversionLinks([0.03], [100, 1, 1])
    expect(uncoveredConversionTargets(shares, 3)).toEqual([])
    expect(shares.map((share) => share.quantity)).toEqual([0.01, 0.01, 0.01])
  })

  it('性质（随机 2000 例）：Σ来源分数 ≥ 目标行数 ⇒ 全覆盖；每条来源合计恒等于来源数量且每条 > 0', () => {
    let seed = 344
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const quantity = () => Math.max(1, Math.floor(random() ** 3 * 5000)) / 100
    for (let round = 0; round < 2000; round += 1) {
      const sources = Array.from({ length: 1 + Math.floor(random() * 4) }, quantity)
      const targets = Array.from({ length: 1 + Math.floor(random() * 5) }, quantity)
      const shares = allocateConversionLinks(sources, targets)
      const context = `${sources.join('+')} → ${targets.join('+')}`
      expect(shares.every((share) => share.quantity > 0), context).toBe(true)
      sources.forEach((value, index) => {
        const total = shares.filter((share) => share.sourceIndex === index).reduce((sum, share) => sum + Math.round(share.quantity * 100), 0)
        expect(total, context).toBe(Math.round(value * 100))
      })
      const sourceCents = sources.reduce((sum, value) => sum + Math.round(value * 100), 0)
      if (sourceCents >= targets.length) expect(uncoveredConversionTargets(shares, targets.length), context).toEqual([])
    }
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

/**
 * 行数 / 关联条数 / 数值上界在服务端（business.ts）与办理台表单各有一份字面量（禁跨端共享目录，
 * 同端两文件也各自声明以免前端引入 server-only 模块）。单侧调整只会表现为「前端放行、服务端拒」，这里钉住两份相等。
 */
describe('库存转换上限前后端字面量一致（#344）', () => {
  const server = readFileSync(resolve(__dirname, 'business.ts'), 'utf8')
  const form = readFileSync(resolve(__dirname, '../../app/(main)/(inventory)/inventory/_components/inventory-operations-page.tsx'), 'utf8')
  const constant = (source: string, name: string) => source.match(new RegExp(`const ${name} = ([0-9.]+)`))?.[1]

  it.each(['CONVERSION_LINES_MAX', 'CONVERSION_LINKS_MAX'])('%s 两份相等', (name) => {
    expect(constant(server, name)).toBeDefined()
    expect(constant(form, name)).toBe(constant(server, name))
  })

  it('金额上限文案与服务端 CONVERSION_NUMBER_MAX 一致', () => {
    const max = constant(server, 'CONVERSION_NUMBER_MAX')
    expect(max).toBe('9999999999.99')
    expect(constant(form, 'CONVERSION_NUMBER_MAX')).toBe(max)
    expect(form).toContain(`库存转换金额合计超出上限 ${max}`)
  })
})
