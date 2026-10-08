import { dailyPeriodInput, type DailyPeriodInput } from './daily-config'

const nextDay = (day: string) => new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10)

/** 保留生效前的月、周归属，交界月从旧首日延续到新末日。 */
export function effectivePeriod(before: DailyPeriodInput | null, proposed: DailyPeriodInput, effective: string): DailyPeriodInput {
  if (effective === '0001-01-01') return proposed
  if (before && before.end < effective) return before
  if (!before || before.start >= effective) {
    if (proposed.start >= effective) return proposed
    const weeks = proposed.weeks.filter(w => w.end >= effective).map((w, i) => ({...w, start: i === 0 ? effective : w.start}))
    return dailyPeriodInput.parse({...proposed, start: effective, weeks})
  }
  if (proposed.end < effective) throw Error('生效日期之后没有可用的新周期，请调整过渡月结束日期')
  if (before.weeks.length !== proposed.weeks.length) throw Error('过渡月份须保留原周数，请通过调整日期设置过渡周')
  const cutoff = new Date(Date.parse(effective + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10)
  let start = before.start
  const weeks = before.weeks.map((old, i) => {
    if (old.end < effective) { start = nextDay(old.end); return {...old} }
    const candidate = proposed.weeks[i]
    const end = i === before.weeks.length - 1 ? proposed.end : [candidate.end, old.start < effective ? cutoff : start].sort().at(-1)!
    const result = {...candidate, id: old.id, start, end}
    // 生效前的周名称也属于原安排。
    if (old.start < effective) result.name = old.name
    start = nextDay(end)
    return result
  })
  return dailyPeriodInput.parse({...proposed, start: before.start, weeks})
}
