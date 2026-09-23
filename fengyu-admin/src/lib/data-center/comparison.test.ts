import { describe, it, expect, vi } from 'vitest'
import { withComparison, toComparisonRanges } from './comparison'
import type { ResolvedRange, ResolvedTimeRange } from './types'

const R = (start: string, end: string): ResolvedRange => ({ start, end })

// deltaPct 的用例已随函数一并移除（#310/#315）——等价覆盖在
// `src/lib/delta-display.test.ts` 的「resolveDeltaDisplay（决策 1 矩阵）」，
// 含同一批生产实例（南昌梦祥店 -2,646 → +264 等）。

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
    // #310 起 mom/yoy 是判别联合而非裸数值 —— 展示层要区分「算不出」的三种成因。
    expect(cell.mom).toEqual({ kind: 'pct', value: 0.2 }) // (120-100)/100
    expect(cell.yoy).toEqual({ kind: 'pct', value: 0.5 }) // (120-80)/80
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it('previous/lastYear 为 null（无历史）→ mom/yoy = na', async () => {
    const runner = vi.fn(async () => 50)
    const cell = await withComparison(
      runner,
      { current: ranges.current, previous: null, lastYear: null },
      'count',
      true,
    )
    expect(cell.value).toBe(50)
    expect(cell.mom).toEqual({ kind: 'na' })
    expect(cell.yoy).toEqual({ kind: 'na' })
    expect(runner).toHaveBeenCalledTimes(1) // 仅本期
  })

  it('toComparisonRanges 从 ResolvedTimeRange 抽三区间', () => {
    const tr: ResolvedTimeRange = { ...ranges, presetLabel: '本周' }
    expect(toComparisonRanges(tr)).toEqual(ranges)
  })
})
