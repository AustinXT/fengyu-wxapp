/**
 * 数据中心时间维度抽象
 *
 * resolveTimeRange(input) → { current, previous(环比), lastYear(同比), presetLabel }
 * 锚点：Asia/Shanghai 的"今天"。所有区间为闭区间 YYYY-MM-DD，
 * SQL 侧统一 `col::date BETWEEN $start AND $end`（对齐 staff salesData）。
 *
 * preset 映射：
 *   today  current=[今天,今天]      previous=[昨天,昨天]            lastYear=[去年今天,去年今天]
 *   week   current=[本周一,今天]     previous=[上周一,上周同一天]     lastYear=[去年同区间]
 *   month  current=[月初,今天]       previous=[上月初,上月同一日]     lastYear=[去年同区间]
 *   year   current=[年初,今天]       previous=[去年初,去年同日]       lastYear=同 previous
 *   custom current=[start,end]       previous=[紧邻前一等长区间]      lastYear=[start/end 各减一年]
 *
 * ⚠️ previous 是**环比基期**（比值的分母），必须与 current 等长，五个 preset 无例外。
 * 别把它跟 staff 端 mgmt-dashboard 的 `VALID_PERIODS=['month','lastMonth','year']` 搞混：
 * metrics.md:885-893「时间窗口补充」那张表里的「上月=上月初~上月末」是**三选一的并列时间维度**
 * （用户主动选「上月」看整月），不是分母。本文件曾据该表把 week/month 的 previous 写成整段上周期，
 * 于是拿 N 天的当期比 7 天/整月的基期，月初/周初徽章恒显巨幅下滑、服务人次实测正负号翻转（#283）。
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
/** 取较早的一天。YYYY-MM-DD 是定长零填充格式，字典序即时间序，无需转 Date */
function minDate(a: string, b: string): string {
  return a < b ? a : b
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
    // 上周**同期**：上周一 → 上周的同一个星期几。整段上周（end=上周日）会拿 N 天比 7 天。
    // 上周恒 7 天 ≥ current 的 ≤7 天，故无需 clamp，天数恒等长。
    previous = { start: addDays(monday, -7), end: addDays(today, -7) }
    lastYear = { start: addYears(monday, -1), end: addYears(today, -1) }
  } else if (input.preset === 'month') {
    const first = startOfMonth(today)
    const lastMonthAnyDay = addDays(first, -1) // 上月某日
    const prevStart = startOfMonth(lastMonthAnyDay)
    // 上月**同期**：上月 1 号 → 上月的第 N 天（N = 今天是本月第几天）。整个上月会拿 N 天比整月。
    // 上月天数不足时 clamp 到上月末——3/31 看本月要的是"上月第 31 天"，2 月没有，落到 2/28。
    // 此时 previous 比 current 短，是日历固有的（月同期对比皆如此），不是 #283 那种口径错。
    const n = daysInclusive(first, today)
    current = { start: first, end: today }
    previous = { start: prevStart, end: minDate(addDays(prevStart, n - 1), endOfMonth(lastMonthAnyDay)) }
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
