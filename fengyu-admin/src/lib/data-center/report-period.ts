/**
 * 经营明细报表的期间解析（#367，纯函数）。
 *
 * 与板块页的 `parseTimeRange` / `TimeRangePreset` 刻意分开：URL 键也不共用
 * （板块页是 `preset/start/end`，报表页是 `period/start/end` 与 `month`），
 * 旧 4 板块不会出现新预设，导出参数（`parseBoardParams`）也不受影响。
 *
 * 三种形态：
 *   range  区间型（日常数据一览表）：上月（默认）/ 本月 / 近 30 天 / 自定义
 *   month  单月型（顾客频率表、经营数据主表、员工提成日报）：`month=YYYY-MM`，默认上月
 *   none   仅范围型（顾客剩余卡项清单）：不读期间参数
 *
 * 「当月」一律按自然月；经营周期（26 日~次月 25 日）不在本期范围。
 */
import { addDays, resolveTimeRange, shanghaiToday } from './time-range'
import type { ResolvedRange } from './types'

export const REPORT_RANGE_PRESETS = ['lastMonth', 'thisMonth', 'last30', 'custom'] as const
export type ReportRangePreset = (typeof REPORT_RANGE_PRESETS)[number]

export const REPORT_RANGE_PRESET_LABELS: Record<ReportRangePreset, string> = {
  lastMonth: '上月',
  thisMonth: '本月',
  last30: '近 30 天',
  custom: '自定义',
}

export const DEFAULT_REPORT_RANGE_PRESET: ReportRangePreset = 'lastMonth'

/**
 * 自定义区间最长天数（含首尾，一整年含闰年）。更长的区间回落默认并在筛选器旁提示——
 * 报表按期间聚合且同时算较上期，放任百年区间会让全国范围首屏远超 3s。
 */
export const MAX_CUSTOM_RANGE_DAYS = 366

/**
 * 单月选择器能选到的最早月份。款项最早 2026-07-03（寄存单录入日）、销售 / 服务单最早 2026-07-08，
 * 更早的月份没有业务数据。URL 手工传入更早月份时照常解析（页面显示空态 + 数据起点提示），不报错。
 */
export const REPORT_MIN_MONTH = '2026-07'

export interface ReportRangePeriod {
  kind: 'range'
  preset: ReportRangePreset
  current: ResolvedRange
  /** 较上期的基期；由页面决定是否展示对比。 */
  previous: ResolvedRange
  label: string
}

export interface ReportMonthPeriod {
  kind: 'month'
  /** YYYY-MM */
  month: string
  /** 整个自然月 [1 日, 月末]。本月未走完的部分由页面按需截到今天。 */
  current: ResolvedRange
  label: string
}

export type ReportPeriod = ReportRangePeriod | ReportMonthPeriod

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^(\d{4})-(\d{2})$/
/** 年份限定 4 位且在合理区间：`time-range.ts` 的字典序比较与 fmt() 都以 4 位年份为前提（见其 minDate 注释）。 */
const MIN_YEAR = 2000
const MAX_YEAR = 2099

/**
 * 日历合法性校验：`2026-02-30`、`2026-13-01` 这类只过位数、不过日历的值一律拒绝。
 * 板块页的 `parseTimeRange` 只校验位数（#308），报表页不复用它，这里自带校验绕开该缺陷。
 */
export function isValidCalendarDate(value: string | undefined): value is string {
  const match = value?.match(DATE_RE)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (year < MIN_YEAR || year > MAX_YEAR) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function isValidMonth(value: string | undefined): value is string {
  const match = value?.match(MONTH_RE)
  if (!match) return false
  const [year, month] = [Number(match[1]), Number(match[2])]
  return year >= MIN_YEAR && year <= MAX_YEAR && month >= 1 && month <= 12
}

function daysInclusive(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1
}

export function monthRange(month: string): ResolvedRange {
  const [year, mon] = month.split('-').map(Number)
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate()
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` }
}

/** 相对某月偏移 n 个月（负数向前）。 */
export function shiftMonth(month: string, n: number): string {
  const [year, mon] = month.split('-').map(Number)
  const d = new Date(Date.UTC(year, mon - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthLabel(month: string): string {
  const [year, mon] = month.split('-')
  return `${year}年${Number(mon)}月`
}

/** 单月型默认月份：上月（原型「重置」后的默认值），但不早于 REPORT_MIN_MONTH。 */
export function defaultReportMonth(today: string = shanghaiToday()): string {
  const lastMonth = shiftMonth(today.slice(0, 7), -1)
  return lastMonth < REPORT_MIN_MONTH ? REPORT_MIN_MONTH : lastMonth
}

/**
 * 单月选择器的可选月份（新 → 旧）：本月 … REPORT_MIN_MONTH。
 * URL 里的月份不在此列（手工构造的更早 / 未来月份）时额外带上，让控件如实回显当前取数月份。
 */
export function reportMonthOptions(today: string = shanghaiToday(), selected?: string): string[] {
  const options: string[] = []
  for (let month = today.slice(0, 7); month >= REPORT_MIN_MONTH; month = shiftMonth(month, -1)) {
    options.push(month)
  }
  if (selected && isValidMonth(selected) && !options.includes(selected)) {
    options.push(selected)
    options.sort((a, b) => (a < b ? 1 : -1))
  }
  return options
}

export function parseReportMonth(raw: { month?: string }, today: string = shanghaiToday()): ReportMonthPeriod {
  const month = isValidMonth(raw.month) ? raw.month : defaultReportMonth(today)
  return { kind: 'month', month, current: monthRange(month), label: monthLabel(month) }
}

export function parseReportRange(
  raw: { period?: string; start?: string; end?: string },
  today: string = shanghaiToday(),
): ReportRangePeriod {
  const preset = (REPORT_RANGE_PRESETS as readonly string[]).includes(raw.period ?? '')
    ? (raw.period as ReportRangePreset)
    : DEFAULT_REPORT_RANGE_PRESET

  if (preset === 'custom') {
    if (
      isValidCalendarDate(raw.start) &&
      isValidCalendarDate(raw.end) &&
      raw.start <= raw.end &&
      daysInclusive(raw.start, raw.end) <= MAX_CUSTOM_RANGE_DAYS
    ) {
      const len = daysInclusive(raw.start, raw.end)
      const prevEnd = addDays(raw.start, -1)
      return {
        kind: 'range',
        preset,
        current: { start: raw.start, end: raw.end },
        // 紧邻前一等长区间（与板块页 custom 同口径）
        previous: { start: addDays(prevEnd, -(len - 1)), end: prevEnd },
        label: `${raw.start} ~ ${raw.end}`,
      }
    }
    // 自定义区间不完整或非法：回落默认预设，而不是拿半截参数去取数
    return parseReportRange({ period: DEFAULT_REPORT_RANGE_PRESET }, today)
  }

  if (preset === 'thisMonth') {
    // 与板块页「本月」同口径：基期 = 上月同期（上月天数不足时截到上月末，只会更短，见 time-range.ts）
    const resolved = resolveTimeRange({ preset: 'month' }, new Date(`${today}T12:00:00+08:00`))
    return {
      kind: 'range',
      preset,
      current: resolved.current,
      previous: resolved.previous ?? resolved.current,
      label: REPORT_RANGE_PRESET_LABELS.thisMonth,
    }
  }

  if (preset === 'last30') {
    // 相对预设：每次请求按「今天」重算，URL 只存 period=last30，不落成写死日期的 custom
    const start = addDays(today, -29)
    const prevEnd = addDays(start, -1)
    return {
      kind: 'range',
      preset,
      current: { start, end: today },
      previous: { start: addDays(prevEnd, -29), end: prevEnd },
      label: REPORT_RANGE_PRESET_LABELS.last30,
    }
  }

  // lastMonth：上期取前一个自然月（两段都是完整自然月）
  const month = shiftMonth(today.slice(0, 7), -1)
  return {
    kind: 'range',
    preset,
    current: monthRange(month),
    previous: monthRange(shiftMonth(month, -1)),
    label: `${REPORT_RANGE_PRESET_LABELS.lastMonth}（${monthLabel(month)}）`,
  }
}
