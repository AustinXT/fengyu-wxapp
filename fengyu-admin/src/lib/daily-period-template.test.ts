import { describe, expect, it } from 'vitest'
import { buildDailyPeriod, defaultDailyCyclePattern, patternFromPeriod } from './daily-period-template'
import { distributeByDays } from './operating/operating-target'

describe('经营周期模板', () => {
  it('按经营月生成连续四周，并在短月截断自然日', () => {
    const period = buildDailyPeriod('2028-02', defaultDailyCyclePattern, 'p1')
    expect(period.start).toBe('2028-01-26')
    expect(period.end).toBe('2028-02-25')
    expect(period.weeks.map((week) => [week.start, week.end])).toEqual([
      ['2028-01-26', '2028-02-02'], ['2028-02-03', '2028-02-09'],
      ['2028-02-10', '2028-02-16'], ['2028-02-17', '2028-02-25'],
    ])
  })

  it('把已调整月份的日期转换为按月相对规则', () => {
    const period = buildDailyPeriod('2026-10', defaultDailyCyclePattern, 'p1')
    const pattern = patternFromPeriod({ ...period, start: '2026-09-25' }, '2026-10')
    expect(pattern.start).toEqual({ monthOffset: -1, day: 25 })
  })
})

describe('按周天数分摊目标', () => {
  it('按天数比例向下取整，尾差全部落在最后一周且合计不变', () => {
    const result = distributeByDays(10001, [8, 7, 7, 9])
    expect(result).toEqual([2580, 2258, 2258, 2905])
    expect(result.reduce((sum, amount) => sum + amount, 0)).toBe(10001)
  })

  it('支持零目标并拒绝无效周天数', () => {
    expect(distributeByDays(0, [7, 7, 7, 7])).toEqual([0, 0, 0, 0])
    expect(() => distributeByDays(10, [7, 0, 7, 7])).toThrow('无效的目标分摊参数')
  })
})
