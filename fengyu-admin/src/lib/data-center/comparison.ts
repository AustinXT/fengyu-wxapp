
import type { KpiCell, MetricUnit, ResolvedRange, ResolvedTimeRange } from './types'

export interface ComparisonRanges {
  current: ResolvedRange
  previous: ResolvedRange | null
  lastYear: ResolvedRange | null
}


export function deltaPct(cur: number | null, base: number | null): number | null {
  if (cur == null) return null
  if (base == null || base === 0) return null
  return (cur - base) / base
}


export function toComparisonRanges(tr: ResolvedTimeRange): ComparisonRanges {
  return { current: tr.current, previous: tr.previous, lastYear: tr.lastYear }
}


export async function withComparison(
  runner: (range: ResolvedRange) => Promise<number | null>,
  ranges: ComparisonRanges,
  unit: MetricUnit,
  enabled = true,
): Promise<KpiCell> {
  const value = await runner(ranges.current)
  if (!enabled) {
    return { value, unit }
  }
  const [prev, ly] = await Promise.all([
    ranges.previous ? runner(ranges.previous) : Promise.resolve(null),
    ranges.lastYear ? runner(ranges.lastYear) : Promise.resolve(null),
  ])
  return {
    value,
    mom: deltaPct(value, prev),
    yoy: deltaPct(value, ly),
    unit,
  }
}
