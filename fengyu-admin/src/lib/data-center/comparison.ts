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

export interface ComparisonRanges {
  current: ResolvedRange
  previous: ResolvedRange | null
  lastYear: ResolvedRange | null
}

/**
 * delta% = (cur - base) / base；base 为 null 或 <= 0 → null（前端 '--'）
 *
 * base <= 0 一律不出徽章：=0 是除零；<0 时 (cur-base)/base 的**符号会翻转**。
 * 生产实例（2026-09-22 只读库实测，南昌梦祥店「本周」业绩）：
 * 基期 09-14~15 = -2,646.00（退款多于收入），当期 09-21~22 = +264.00（已回正）。
 * 旧式算出 (264-(-2646))/(-2646) = -109.98%，徽章渲染成红色下滑 —— 方向恰好反了。
 * 负基期的"增长率"没有可读语义（分母的方向性已丢失），按
 * metrics.md §数字格式化规则「防除零 / 数据缺失 一律 '--'」（:610）归入"算不出"。
 * 审计跨相邻区间统计到负基期 29 对 / 19 家门店，区间 -100.68% ~ -54,080,100.00%（#283）。
 * 同比(yoy)同样走这里——负基期翻符号与是环比还是同比无关。
 */
export function deltaPct(cur: number | null, base: number | null): number | null {
  if (cur == null || base == null) return null
  // NaN / ±Infinity 自己挡掉：`cur == null` 接不住 NaN（NaN == null 为 false）。
  // 现在四个板块的 scalar()/num() 都已 Number.isFinite 过滤、前端 DeltaBadge 也兜了一层，
  // 但「算不出」的判定权应该在本函数手里 —— 否则第 5 个调用方忘了过滤就会把 NaN 漏到下游。
  if (!Number.isFinite(cur) || !Number.isFinite(base)) return null
  if (base <= 0) return null
  return (cur - base) / base
}

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
    mom: deltaPct(value, prev),
    yoy: deltaPct(value, ly),
    unit,
  }
}
