
import type { ResolvedRange, ResolvedTimeRange, TimeRangeInput } from './types'


function parse(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`)
}

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
  
  d.setUTCMonth(d.getUTCMonth() + 1, 1)
  d.setUTCDate(0)
  return fmt(d)
}
function startOfYear(dateStr: string): string {
  return dateStr.slice(0, 4) + '-01-01'
}

function startOfWeekMonday(dateStr: string): string {
  const d = parse(dateStr)
  const dow = d.getUTCDay() 
  const diff = dow === 0 ? 6 : dow - 1
  return addDays(dateStr, -diff)
}
function daysInclusive(start: string, end: string): number {
  return Math.round((parse(end).getTime() - parse(start).getTime()) / 86400000) + 1
}


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
    const lastMonthAnyDay = addDays(first, -1) 
    current = { start: first, end: today }
    previous = { start: startOfMonth(lastMonthAnyDay), end: endOfMonth(lastMonthAnyDay) }
    lastYear = { start: addYears(first, -1), end: addYears(today, -1) }
  } else {
    
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
