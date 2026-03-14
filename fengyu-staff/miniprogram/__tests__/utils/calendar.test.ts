import { buildCalendarDays, formatMonthLabel } from '../../utils/calendar'

describe('buildCalendarDays', () => {
  test('平年二月有28天', () => {
    const days = buildCalendarDays('2025-02', [], '2025-02-15')
    const realDays = days.filter(d => !d.isEmpty)
    expect(realDays).toHaveLength(28)
    expect(realDays[27].day).toBe(28)
  })

  test('闰年二月有29天', () => {
    const days = buildCalendarDays('2024-02', [], '2024-02-15')
    const realDays = days.filter(d => !d.isEmpty)
    expect(realDays).toHaveLength(29)
    expect(realDays[28].day).toBe(29)
  })

  test('首周 padding — 1号非周日时填充空格', () => {
    // 2025-01-01 是周三 (getDay()=3)
    const days = buildCalendarDays('2025-01', [], '2025-01-01')
    const emptyDays = days.filter(d => d.isEmpty)
    expect(emptyDays).toHaveLength(3)
    // 第一个实际日期应该在索引 3
    expect(days[3].day).toBe(1)
    expect(days[3].isEmpty).toBe(false)
  })

  test('首周 padding — 1号为周日时无填充', () => {
    // 2023-01-01 是周日 (getDay()=0)
    const days = buildCalendarDays('2023-01', [], '2023-01-01')
    const emptyDays = days.filter(d => d.isEmpty)
    expect(emptyDays).toHaveLength(0)
    expect(days[0].day).toBe(1)
  })

  test('today 高亮标记', () => {
    const days = buildCalendarDays('2025-03', [], '2025-03-14')
    const todayCell = days.find(d => d.isToday)
    expect(todayCell).toBeTruthy()
    expect(todayCell!.day).toBe(14)
    expect(todayCell!.date).toBe('2025-03-14')
  })

  test('非当月时无 today 高亮', () => {
    const days = buildCalendarDays('2025-02', [], '2025-03-14')
    const todayCell = days.find(d => d.isToday)
    expect(todayCell).toBeUndefined()
  })

  test('金额 >= 1000 显示为 k 格式', () => {
    const days = buildCalendarDays('2025-03', [
      { date: '2025-03-01', amount: 1000 },
      { date: '2025-03-02', amount: 1500 },
      { date: '2025-03-03', amount: 500 },
    ], '2025-03-14')

    const day1 = days.find(d => d.day === 1)
    expect(day1!.amountLabel).toBe('1.0k')
    expect(day1!.hasData).toBe(true)

    const day2 = days.find(d => d.day === 2)
    expect(day2!.amountLabel).toBe('1.5k')

    const day3 = days.find(d => d.day === 3)
    expect(day3!.amountLabel).toBe('500')
  })

  test('无数据的日期 amountLabel 为空字符串', () => {
    const days = buildCalendarDays('2025-03', [], '2025-03-14')
    const day5 = days.find(d => d.day === 5)
    expect(day5!.amountLabel).toBe('')
    expect(day5!.hasData).toBe(false)
  })

  test('空 dailyData 仍生成完整月历', () => {
    const days = buildCalendarDays('2025-12', [], '2025-12-01')
    const realDays = days.filter(d => !d.isEmpty)
    expect(realDays).toHaveLength(31)
  })
})

describe('formatMonthLabel', () => {
  test('格式化月份标签', () => {
    expect(formatMonthLabel('2025-03')).toBe('2025年3月')
    expect(formatMonthLabel('2025-12')).toBe('2025年12月')
    expect(formatMonthLabel('2024-01')).toBe('2024年1月')
  })

  test('月份不补零', () => {
    expect(formatMonthLabel('2025-01')).toBe('2025年1月')
    expect(formatMonthLabel('2025-09')).toBe('2025年9月')
  })
})
