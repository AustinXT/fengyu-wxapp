import { describe, it, expect, vi } from 'vitest'
import { deltaPct, withComparison, toComparisonRanges } from './comparison'
import type { ResolvedRange, ResolvedTimeRange } from './types'

const R = (start: string, end: string): ResolvedRange => ({ start, end })

describe('deltaPct', () => {
  it('正常增减', () => {
    expect(deltaPct(12, 10)).toBeCloseTo(0.2)
    expect(deltaPct(8, 10)).toBeCloseTo(-0.2)
  })
  it('base 为 0 或 null / cur 为 null → null（前端 --）', () => {
    expect(deltaPct(10, 0)).toBeNull()
    expect(deltaPct(10, null)).toBeNull()
    expect(deltaPct(null, 10)).toBeNull()
  })
})

describe('withComparison', () => {
  const ranges = {
    current: R('2024-01-01', '2024-01-03'),
    previous: R('2023-12-29', '2023-12-31'),
    lastYear: R('2023-01-01', '2023-01-03'),
  }

  it('enabled=false 只返回 value，不跑对比查询', async () => {
    const runner = vi.fn(async () => 100)
    const cell = await withComparison(runner, ranges, 'amount', false)
    expect(cell).toEqual({ value: 100, unit: 'amount' })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('enabled=true 跑本期/上期/去年同期，算 mom/yoy', async () => {
    // current=120, previous=100, lastYear=80
    const runner = vi.fn(async (r: ResolvedRange) => {
      if (r === ranges.current) return 120
      if (r === ranges.previous) return 100
      return 80
    })
    const cell = await withComparison(runner, ranges, 'amount', true)
    expect(cell.value).toBe(120)
    expect(cell.mom).toBeCloseTo(0.2) // (120-100)/100
    expect(cell.yoy).toBeCloseTo(0.5) // (120-80)/80
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it('previous/lastYear 为 null（无历史）→ mom/yoy = null', async () => {
    const runner = vi.fn(async () => 50)
    const cell = await withComparison(
      runner,
      { current: ranges.current, previous: null, lastYear: null },
      'count',
      true,
    )
    expect(cell.value).toBe(50)
    expect(cell.mom).toBeNull()
    expect(cell.yoy).toBeNull()
    expect(runner).toHaveBeenCalledTimes(1) // 仅本期
  })

  it('toComparisonRanges 从 ResolvedTimeRange 抽三区间', () => {
    const tr: ResolvedTimeRange = { ...ranges, presetLabel: '本周' }
    expect(toComparisonRanges(tr)).toEqual(ranges)
  })
})
