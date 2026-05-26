/**
 * 数据中心时间维度抽象
 *
 * resolveTimeRange(input) → { current, previous(环比), lastYear(同比), presetLabel }
 * 锚点：Asia/Shanghai 的"今天"。所有区间为闭区间 YYYY-MM-DD，
 * SQL 侧统一 `col::date BETWEEN $start AND $end`（对齐 staff salesData）。
 *
 * preset 映射（复用 metrics.md §时间窗口补充的 month/year 口径，新增 today/week/custom）：
 *   today  current=[今天,今天]      previous=[昨天,昨天]            lastYear=[去年今天,去年今天]
 *   week   current=[本周一,今天]     previous=[上周一,上周日]        lastYear=[去年同区间]
 *   month  current=[月初,今天]       previous=[上月初,上月末]        lastYear=[去年同区间]
 *   year   current=[年初,今天]       previous=[去年初,去年同日]       lastYear=同 previous
 *   custom current=[start,end]       previous=[紧邻前一等长区间]      lastYear=[start/end 各减一年]
 */
import type { ResolvedRange, ResolvedTimeRange, TimeRangeInput } from './types'

/** 纯日期运算：所有 YYYY-MM-DD 当作 UTC 零点，避免本地时区/DST 干扰 */
function parse(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`)
}
/**
 * 由 UTC 字段拼 YYYY-MM-DD（不用 toISOString().slice()）。
 * 这里全程 UTC 锚定纯运算，不涉时区切换；唯一时区敏感的"今天"取自 shanghaiToday()（Intl）。
 */
function fmt(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
export function addDays(dateStr: string, n: number): string {
  const d = parse(dateStr)
  d.setUTCDate(d.getUTCDate() + n)
  return fmt(d)
}
export function addYears(dateStr: string, n: number): string {
  const d = parse(dateStr)
  d.setUTCFullYear(d.getUTCFullYear() + n)
  return fmt(d)
}
function startOfMonth(dateStr: string): string {
  return dateStr.slice(0, 8) + '01'
}
function endOfMonth(dateStr: string): string {
  const d = parse(dateStr)
  // 下月 1 号减 1 天
  d.setUTCMonth(d.getUTCMonth() + 1, 1)
  d.setUTCDate(0)
  return fmt(d)
}
function startOfYear(dateStr: string): string {
  return dateStr.slice(0, 4) + '-01-01'
}
/** ISO 周一为一周起点 */
function startOfWeekMonday(dateStr: string): string {
  const d = parse(dateStr)
  const dow = d.getUTCDay() // 0=周日..6=周六
  const diff = dow === 0 ? 6 : dow - 1
  return addDays(dateStr, -diff)
}
function daysInclusive(start: string, end: string): number {
  return Math.round((parse(end).getTime() - parse(start).getTime()) / 86400000) + 1
}

/** 取 Asia/Shanghai 当前日期 YYYY-MM-DD（en-CA 输出即 ISO 格式） */
export function shanghaiToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

const PRESET_LABELS: Record<string, string> = {
  today: '今日',
  week: '本周',
  month: '本月',
  year: '今年',
}

export function resolveTimeRange(input: TimeRangeInput, now: Date = new Date()): ResolvedTimeRange {
  const today = shanghaiToday(now)

  if (input.preset === 'custom') {
    const { start, end } = input
    const len = daysInclusive(start, end)
    const prevEnd = addDays(start, -1)
    const prevStart = addDays(prevEnd, -(len - 1))
    return {
      current: { start, end },
      previous: { start: prevStart, end: prevEnd },
      lastYear: { start: addYears(start, -1), end: addYears(end, -1) },
      presetLabel: `${start} ~ ${end}`,
    }
  }

  let current: ResolvedRange
  let previous: ResolvedRange
  let lastYear: ResolvedRange

  if (input.preset === 'today') {
    current = { start: today, end: today }
    previous = { start: addDays(today, -1), end: addDays(today, -1) }
    lastYear = { start: addYears(today, -1), end: addYears(today, -1) }
  } else if (input.preset === 'week') {
    const monday = startOfWeekMonday(today)
    current = { start: monday, end: today }
    previous = { start: addDays(monday, -7), end: addDays(monday, -1) }
    lastYear = { start: addYears(monday, -1), end: addYears(today, -1) }
  } else if (input.preset === 'month') {
    const first = startOfMonth(today)
    const lastMonthAnyDay = addDays(first, -1) // 上月某日
    current = { start: first, end: today }
    previous = { start: startOfMonth(lastMonthAnyDay), end: endOfMonth(lastMonthAnyDay) }
    lastYear = { start: addYears(first, -1), end: addYears(today, -1) }
  } else {
    // year
    const first = startOfYear(today)
    current = { start: first, end: today }
    previous = { start: addYears(first, -1), end: addYears(today, -1) }
    lastYear = { start: addYears(first, -1), end: addYears(today, -1) }
  }

  return {
    current,
    previous,
    lastYear,
    presetLabel: PRESET_LABELS[input.preset],
  }
}
