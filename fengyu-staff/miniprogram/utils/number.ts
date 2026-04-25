// utils/number.ts — 数字展示格式化
//
// 统一长格式千分位规则（管理层数据中心 ticket 5）：
//   - 金额：保留 2 位小数 + 千分位（不再折叠为"万"）
//   - 计数：整数 + 千分位（不再折叠为"万"）
//   - 缺失（null/undefined/NaN/Infinity）：返回 '--'

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
