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
    for (const fn of [formatAmount, formatCount, formatPercent, formatDelta]) {
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

  it('formatDelta：带正负号', () => {
    expect(formatDelta(0.12)).toBe('+12.00%')
    expect(formatDelta(-0.05)).toBe('-5.00%')
    expect(formatDelta(0)).toBe('0.00%')
  })
})
