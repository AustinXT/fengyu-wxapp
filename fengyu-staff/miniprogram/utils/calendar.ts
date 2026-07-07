

export interface CalendarDay {
  day: number
  date: string
  hasData: boolean
  amountLabel: string
  isToday: boolean
  isEmpty: boolean
}


export function buildCalendarDays(
  yearMonth: string,
  dailyData: Array<{ date: string; amount: number }>,
  today?: string
): CalendarDay[] {
  const [y, m] = yearMonth.split('-').map(Number)
  const todayStr = today ?? (() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })()
  const firstDow = new Date(y, m - 1, 1).getDay()
  const daysInMonth = new Date(y, m, 0).getDate()
  const dataMap: Record<string, number> = {}
  dailyData.forEach(d => { dataMap[d.date] = d.amount })

  const days: CalendarDay[] = []
  for (let i = 0; i < firstDow; i++) {
    days.push({ isEmpty: true, day: 0, date: '', hasData: false, amountLabel: '', isToday: false })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const amount = dataMap[dateStr] || 0
    let amountLabel = ''
    if (amount > 0) {
      amountLabel = amount >= 1000 ? `${(amount / 1000).toFixed(1)}k` : String(amount)
    }
    days.push({
      isEmpty: false,
      day: d,
      date: dateStr,
      hasData: amount > 0,
      amountLabel,
      isToday: dateStr === todayStr,
    })
  }
  return days
}


export function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  return `${y}年${parseInt(m)}月`
}
