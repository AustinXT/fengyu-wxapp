const keys = ['sales', 'consumption', 'visits', 'newCustomers', 'projects']
export function buildRows(
  objects: any,
  events: any,
  targetRows: any,
  period: any,
  week: any,
  cutoff: any,
  expand: any,
) {
  const targets = new Map<string, any>(
    targetRows.map((t: any) => [`${t.scope}:${t.scope_id}`, t]),
  )
  return objects.map((object: any) => {
    const target = targets.get(`${object.scope}:${object.scopeId}`)
    const configured = target?.month_confirmed ? expand(target, period) : null
    const daily = events.filter(
      (e: any) => e.scope === object.scope && e.id === object.scopeId,
    )
    const values: any = {}
    for (const key of keys) {
      const sum = (a: any, b: any) =>
        daily
          .filter((e: any) => e.date >= a && e.date <= b)
          .reduce((n: any, e: any) => n + Number(e[key] || 0), 0)
      values[key] = {
        monthTarget: configured?.[key] ?? null,
        monthDone: sum(period.start, cutoff),
        weekTarget: configured?.weeks[week?.id]?.[key] ?? null,
        weekDone: week
          ? sum(week.start, week.end < cutoff ? week.end : cutoff)
          : 0,
        days: week
          ? daily
              .filter((e: any) => e.date >= week.start && e.date <= week.end)
              .map((e: any) => ({ date: e.date, done: Number(e[key] || 0) }))
          : [],
        weeks: period.weeks.map((w: any) => ({
          id: w.id,
          done: sum(w.start, w.end < cutoff ? w.end : cutoff),
        })),
      }
      if (
        ![values[key].monthDone, values[key].weekDone].every(
          Number.isSafeInteger,
        )
      )
        throw Error('INVALID_STATE: 统计值超出范围')
    }
    return { ...object, values }
  })
}
