/**
 * 数据中心数字格式化（移植 fengyu-staff/miniprogram/utils/number.ts）
 *
 * metrics.md §数字格式化规则：
 *   - 金额：保留 2 位小数 + 千分位（不折叠"万"）
 *   - 计数：整数 + 千分位
 *   - 占比：保留 2 位 + %（输入为 0-1 小数）
 *   - 缺失（null/undefined/NaN/Infinity）：返回 '--'
 *
 * ⚠️ 跨端口径一致性：与 staff number.ts 保持字面一致，consistency 测试守护。
 */

function isInvalid(value: number | null | undefined): boolean {
  return value == null || !Number.isFinite(value)
}

/** 金额格式化：千分位 + 2 位小数 */
export function formatAmount(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  return (value as number).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** 计数格式化：整数 + 千分位 */
export function formatCount(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  return Math.round(value as number).toLocaleString('en-US')
}

/** 占比格式化：保留 2 位 + %（输入为 0-1 小数） */
export function formatPercent(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  return ((value as number) * 100).toFixed(2) + '%'
}

/** 按单位分发格式化（KpiCell.unit 驱动） */
export function formatByUnit(
  value: number | null | undefined,
  unit: 'amount' | 'count' | 'percent',
): string {
  if (unit === 'amount') return formatAmount(value)
  if (unit === 'percent') return formatPercent(value)
  return formatCount(value)
}

/**
 * 同比/环比 delta% 文案：输入小数（0.12 → "+12.00%"），null → '--'
 * 正负号显式，便于前端按符号上色。
 */
export function formatDelta(value: number | null | undefined): string {
  if (isInvalid(value)) return '--'
  const v = value as number
  const sign = v > 0 ? '+' : ''
  return sign + (v * 100).toFixed(2) + '%'
}
