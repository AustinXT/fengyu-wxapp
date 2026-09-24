/**
 * 同比/环比（YoY/MoM）封装
 *
 * 给定「按区间取单值」的 runner，跑本期；enabled 时并行跑上期/去年同期算 delta%。
 * 上线前清空 PG，短期无历史 → 上期/去年查出 0 或 runner 返回 null → delta 返回 null →
 * 前端统一显示 '--'，优雅降级无需特判。
 *
 * 性能：开启 comparison 时单 KPI 查询 ×3。仅作用于 KPI 卡片标量，
 * 明细表/排名榜不做逐行对比（见 plan 风险 §2）。
 */
import type { KpiCell, MetricUnit, ResolvedRange, ResolvedTimeRange } from './types'
import { resolveDeltaDisplay } from '@/lib/delta-display'

export interface ComparisonRanges {
  current: ResolvedRange
  previous: ResolvedRange | null
  lastYear: ResolvedRange | null
}

/**
 * ⚠️ 这里曾有一个 `deltaPct(cur, base)`，#310/#315 起**已删除**。
 *
 * 它把 `base <= 0` 的三种成因（负基期已转正 / 负基期未转正 / 零基期）一律压成 `null`，
 * 与决策 1 要求的两态展示语义分叉；生产已无调用方，留着只会成为
 * 「第三份增幅实现」的诱饵（两个评审谱系都点了这一条）。
 *
 * 要算增幅一律用 `@/lib/delta-display` 的 `resolveDeltaDisplay` —— 那是 admin 全站单一真相源，
 * 负基期的历史案例与口径依据也都记在那个文件头与 `notes/references/metrics.md` 的基期章节。
 */

/** 从 resolveTimeRange 输出抽出 comparison 三区间 */
export function toComparisonRanges(tr: ResolvedTimeRange): ComparisonRanges {
  return { current: tr.current, previous: tr.previous, lastYear: tr.lastYear }
}

/**
 * 跑 runner 得 KpiCell。
 * @param runner 输入区间 → 该区间标量值（null 表示无数据）
 * @param ranges 本期/上期/去年同期
 * @param unit   值的单位（金额/计数/占比）
 * @param enabled 是否计算同比环比（false 时只返回 value）
 */
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
    mom: resolveDeltaDisplay(value, prev),
    yoy: resolveDeltaDisplay(value, ly),
    unit,
  }
}
