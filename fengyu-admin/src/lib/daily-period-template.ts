import { dailyPeriodInput, type DailyPeriodInput } from './daily-config'

export type CyclePoint = { monthOffset: -1 | 0 | 1; day: number }
export type DailyCyclePattern = {
  start: CyclePoint
  end: CyclePoint
  weeks: { id: string; name: string; start: CyclePoint; end: CyclePoint }[]
}

export const defaultDailyCyclePattern: DailyCyclePattern = {
  start: { monthOffset: -1, day: 26 },
  end: { monthOffset: 0, day: 25 },
  weeks: [
    { id: 'w1', name: '第1周', start: { monthOffset: -1, day: 26 }, end: { monthOffset: 0, day: 2 } },
    { id: 'w2', name: '第2周', start: { monthOffset: 0, day: 3 }, end: { monthOffset: 0, day: 9 } },
    { id: 'w3', name: '第3周', start: { monthOffset: 0, day: 10 }, end: { monthOffset: 0, day: 16 } },
    { id: 'w4', name: '第4周', start: { monthOffset: 0, day: 17 }, end: { monthOffset: 0, day: 25 } },
  ],
}

function format(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}
function resolvePoint(monthKey: string, point: CyclePoint) {
  const [year, month] = monthKey.split('-').map(Number)
  const base = new Date(Date.UTC(year, month - 1 + point.monthOffset, 1))
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate()
  base.setUTCDate(Math.min(point.day, lastDay))
  return format(base)
}

export function buildDailyPeriod(monthKey: string, pattern: DailyCyclePattern, id: string, version = 0): DailyPeriodInput {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) throw Error('请选择有效经营月')
  const period = {
    id,
    name: monthKey.replace('-', ''),
    start: resolvePoint(monthKey, pattern.start),
    end: resolvePoint(monthKey, pattern.end),
    version,
    weeks: pattern.weeks.map((week) => ({
      id: week.id,
      name: week.name,
      start: resolvePoint(monthKey, week.start),
      end: resolvePoint(monthKey, week.end),
    })),
  }
  return dailyPeriodInput.parse(period)
}

export function patternFromPeriod(period: DailyPeriodInput, monthKey: string): DailyCyclePattern {
  const [year, month] = monthKey.split('-').map(Number)
  const point = (date: string): CyclePoint => {
    const d = new Date(`${date}T12:00:00Z`)
    const monthOffset = (d.getUTCFullYear() - year) * 12 + d.getUTCMonth() - (month - 1)
    if (monthOffset < -1 || monthOffset > 1) throw Error('周期日期需位于归属月前后一个月内')
    return { monthOffset: monthOffset as -1 | 0 | 1, day: d.getUTCDate() }
  }
  return {
    start: point(period.start),
    end: point(period.end),
    weeks: period.weeks.map((week) => ({ id: week.id, name: week.name, start: point(week.start), end: point(week.end) })),
  }
}

export function validateDailyCyclePattern(pattern: DailyCyclePattern) {
  // 覆盖普通年、闰年及跨年衔接，避免只验证当前月而保存短月失效的规则。
  let previous: DailyPeriodInput | null = null
  for (let index = 0; index < 25; index++) {
    const date = new Date(Date.UTC(2027, index, 1))
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    const period = buildDailyPeriod(month, pattern, 'preview')
    if (previous && Date.parse(period.start) - Date.parse(previous.end) !== 86400000) {
      throw Error('INVALID_PARAMS: 长期规则生成的相邻经营月须连续、无重叠，请调整经营月起止日')
    }
    previous = period
  }
}
