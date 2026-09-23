import { describe, it, expect } from 'vitest'
import { formatAmount, formatCount, formatPercent, formatByUnit, formatDelta } from './format'

describe('data-center format（移植 staff number.ts 口径）', () => {
  it('formatAmount：2 位小数 + 千分位', () => {
    expect(formatAmount(1234567.891)).toBe('1,234,567.89')
    expect(formatAmount(8000)).toBe('8,000.00')
    expect(formatAmount(0)).toBe('0.00')
  })

  it('formatCount：整数 + 千分位', () => {
    expect(formatCount(12000)).toBe('12,000')
    expect(formatCount(599.6)).toBe('600')
  })

  it('formatPercent：输入 0-1 小数，输出 2 位 + %', () => {
    expect(formatPercent(0.3333)).toBe('33.33%')
    expect(formatPercent(1)).toBe('100.00%')
  })

  it('无效值（null/undefined/NaN/Infinity）一律 --', () => {
    // formatDelta 自 #310 起吃判别联合，不再吃裸数值，所以从这个循环里摘出去单测。
    for (const fn of [formatAmount, formatCount, formatPercent]) {
      expect(fn(null)).toBe('--')
      expect(fn(undefined)).toBe('--')
      expect(fn(NaN)).toBe('--')
      expect(fn(Infinity)).toBe('--')
    }
  })

  it('formatByUnit 按单位分发', () => {
    expect(formatByUnit(1000, 'amount')).toBe('1,000.00')
    expect(formatByUnit(1000, 'count')).toBe('1,000')
    expect(formatByUnit(0.5, 'percent')).toBe('50.00%')
  })

  describe('formatDelta（#310 决策 1 展示矩阵）', () => {
    it('pct：带正负号，2 位小数', () => {
      expect(formatDelta({ kind: 'pct', value: 0.12 })).toBe('+12.00%')
      expect(formatDelta({ kind: 'pct', value: -0.05 })).toBe('-5.00%')
    })

    it('决策 3 · 舍入后为 0 出「持平」，不再出带符号的 0.00%', () => {
      // 真 0
      expect(formatDelta({ kind: 'pct', value: 0 })).toBe('持平')
      // 伪持平：500,010 vs 500,000 = +0.002%，2 位小数下舍成 0.00
      // ⚠️ 阈值比 analyst 严一位：那边 toFixed(1)，+0.02% 就已是伪持平；这里 +0.02% 照常出数。
      expect(formatDelta({ kind: 'pct', value: 0.00002 })).toBe('持平')
      // 负向伪持平同样并入，不出 '-0.00%'
      expect(formatDelta({ kind: 'pct', value: -0.00002 })).toBe('持平')
    })

    it('决策 3 的边界：刚好够 0.01% 的仍出数，不被吞', () => {
      expect(formatDelta({ kind: 'pct', value: 0.0001 })).toBe('+0.01%')
      expect(formatDelta({ kind: 'pct', value: -0.0001 })).toBe('-0.01%')
    })

    it('负基期两态出专用文案而非 --（这是 #310 的核心诉求）', () => {
      expect(formatDelta({ kind: 'turnedPositive' })).toBe('由负转正')
      expect(formatDelta({ kind: 'notTurned' })).toBe('未转正')
    })

    it('算不出一律 --（含 undefined，即 withComparison:false 的明细表）', () => {
      expect(formatDelta({ kind: 'na' })).toBe('--')
      expect(formatDelta(undefined)).toBe('--')
    })
  })
})
