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
 *    该守护覆盖的是金额/计数/占比三个格式化器；`formatDelta` 是数据中心独有的徽章文案，
 *    staff 端无对应副本（#310/#315 改造前后均如此）。
 */
import {
  FLAT_TEXT,
  NA_TEXT,
  NOT_TURNED_TEXT,
  TURNED_POSITIVE_TEXT,
  isFlatAfterRounding,
  type DeltaDisplay,
} from '@/lib/delta-display'

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

/** 数据中心徽章的展示精度：2 位小数。首页看板用整数，**两处阈值不同，别互抄**。 */
export const DELTA_DIGITS = 2

/**
 * 同比/环比徽章文案（#310/#315 起吃判别联合，不再吃裸数值）。
 *
 * 四种展示态的文案在 `@/lib/delta-display` 定义，这里只负责把 `pct` 渲染成百分比字符串。
 * 决策 3：舍入后为 0 的一律出「持平」，不再输出 `+0.00%` 那种自相矛盾的展示。
 */
export function formatDelta(display: DeltaDisplay | undefined): string {
  if (display == null) return NA_TEXT
  switch (display.kind) {
    case 'na':
      return NA_TEXT
    case 'turnedPositive':
      return TURNED_POSITIVE_TEXT
    case 'notTurned':
      return NOT_TURNED_TEXT
    case 'pct': {
      if (isFlatAfterRounding(display.value, DELTA_DIGITS)) return FLAT_TEXT
      const shown = (display.value * 100).toFixed(DELTA_DIGITS)
      // 用舍入后的值判符号，与「持平」的判定保持同一套精度。
      return (Number(shown) > 0 ? '+' : '') + shown + '%'
    }
  }
}
