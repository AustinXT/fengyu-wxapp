/**
 * 数据中心明细表 / 排名榜导出值转换。
 *
 * 与页面展示（format.ts 的 formatByUnit 输出带千分位/% 的字符串）不同，
 * 导出走「原始数值」：金额 2 位小数、计数整数、占比转百分数（0-1 → 12.34），
 * 便于在 Excel 中直接求和 / 排序 / 透视。占比列表头追加 (%) 以标注量纲。
 */

import type { MetricUnit } from './types'

/** 指标值 → 导出单元格（原始数值，占比 0-1 转百分数 2 位）。null/NaN/Inf → '' */
export function metricCell(value: number | null | undefined, unit: MetricUnit): number | '' {
  if (value == null || !Number.isFinite(value)) return ''
  if (unit === 'amount') return Math.round(value * 100) / 100
  if (unit === 'percent') return Math.round(value * 10000) / 100 // 0-1 → 百分数
  return Math.round(value) // count
}

/** 占比列表头追加 (%)，其余原样 */
export function headerWithUnit(label: string, unit: MetricUnit): string {
  return unit === 'percent' ? `${label}(%)` : label
}
