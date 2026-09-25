/**
 * YYYY-MM-DD 日历合法性校验（纯函数，与业务无关）——全仓唯一实现（#308）。
 *
 * 数据中心板块页（`params.ts` 的 `parseTimeRange` 与服务端复检）、经营明细报表页（`report-period.ts`）、
 * 员工提成日报（`commission-daily.ts`）都从这里 import，不许再写第三份。
 */

/**
 * 年份范围与 `components/ui/date-picker.tsx` 的默认可选年份一致：选择器能选到的日期，校验必须放行，
 * 否则用户选 1999 年会被静默回落到本月。
 * 同时保证年份恰为 4 位——`time-range.ts` 的字典序比较与 `fmt()` 都以 4 位年份为前提（见其 minDate 注释）。
 */
export const CALENDAR_MIN_YEAR = 1900
export const CALENDAR_MAX_YEAR = 2100

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * `2026-02-30`、`2026-13-01`、`2026-00-01`、`0001-01-01` 这类只过位数、不过日历（或年份越界）的值一律拒绝。
 * 入参是 unknown：服务端边界直接拿客户端传来的对象字段来校验。
 */
export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = value.match(DATE_RE)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (year < CALENDAR_MIN_YEAR || year > CALENDAR_MAX_YEAR) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
