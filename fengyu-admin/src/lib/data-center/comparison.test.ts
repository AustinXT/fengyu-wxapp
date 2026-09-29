import { describe, it, expect, vi } from 'vitest'
import { withComparison, toComparisonRanges } from './comparison'
import { resolveTimeRange } from './time-range'
import { resolveDeltaDisplay } from '@/lib/delta-display'
import { toCustomRange } from './params'
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


describe('withComparison 按区间值去重 (#311)', () => {
  const now = new Date('2026-09-29T04:00:00Z')
  it.each([100, 0, -100, null])('year 基期=%s：只跑两次且输出与原三路一致', async (base) => {
    const ranges = toComparisonRanges(resolveTimeRange({ preset: 'year' }, now))
    expect(ranges.previous).not.toBe(ranges.lastYear)
    expect(ranges.previous).toEqual(ranges.lastYear)
    const runner = vi.fn(async (range: ResolvedRange) => range === ranges.current ? 120 : base)
    const cell = await withComparison(runner, ranges, 'amount')
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner).toHaveBeenNthCalledWith(2, ranges.previous)
    expect(cell).toEqual({ value: 120, unit: 'amount',
      mom: resolveDeltaDisplay(120, base), yoy: resolveDeltaDisplay(120, base) })
  })
  it.each(['today', 'week', 'month', 'custom'] as const)('%s 不同区间仍跑三次', async (preset) => {
    const input = preset === 'custom' ? toCustomRange('2026-09-03', '2026-09-08')! : { preset }
    const runner = vi.fn(async () => 100)
    await withComparison(runner, toComparisonRanges(resolveTimeRange(input, now)), 'count')
    expect(runner).toHaveBeenCalledTimes(3)
  })
  it.each([
    [R('2025-01-01', '2025-09-29'), R('2025-01-02', '2025-09-29')],
    [R('2025-01-01', '2025-09-29'), R('2025-01-01', '2025-09-28')],
  ])('仅一个端点相同仍分别查询', async (previous, lastYear) => {
    const runner = vi.fn(async () => 100)
    await withComparison(runner, { current: R('2026-01-01', '2026-09-29'), previous, lastYear }, 'count')
    expect(runner).toHaveBeenCalledTimes(3)
  })
  it.each(['previous', 'lastYear'] as const)('仅 %s 存在时只跑本期和一个基期', async (key) => {
    const runner = vi.fn(async () => 100)
    const cell = await withComparison(runner, {
      current: R('2026-01-01', '2026-09-29'), previous: null, lastYear: null,
      [key]: R('2025-01-01', '2025-09-29'),
    }, 'count')
    expect(runner).toHaveBeenCalledTimes(2)
    expect(cell[key === 'previous' ? 'mom' : 'yoy']).toEqual({ kind: 'pct', value: 0 })
    expect(cell[key === 'previous' ? 'yoy' : 'mom']).toEqual({ kind: 'na' })
  })
  it('共享历史查询失败照常向上传播，不返回部分 KPI', async () => {
    const runner = vi.fn().mockResolvedValueOnce(120).mockRejectedValueOnce(new Error('查询失败'))
    await expect(withComparison(runner, toComparisonRanges(resolveTimeRange({ preset: 'year' }, now)), 'amount'))
      .rejects.toThrow('查询失败')
    expect(runner).toHaveBeenCalledTimes(2)
  })
})
