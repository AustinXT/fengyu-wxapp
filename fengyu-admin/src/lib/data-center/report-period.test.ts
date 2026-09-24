import { describe, expect, it } from 'vitest'
import {
  defaultReportMonth,
  isValidCalendarDate,
  isValidMonth,
  monthRange,
  parseReportMonth,
  parseReportRange,
  reportMonthOptions,
  REPORT_MIN_MONTH,
  shiftMonth,
} from './report-period'

const TODAY = '2026-09-25'

describe('parseReportRange（区间型）', () => {
  it('默认「上月」：当期为上一个完整自然月，上期为再前一个自然月', () => {
    const p = parseReportRange({}, TODAY)
    expect(p.preset).toBe('lastMonth')
    expect(p.current).toEqual({ start: '2026-08-01', end: '2026-08-31' })
    expect(p.previous).toEqual({ start: '2026-07-01', end: '2026-07-31' })
  })

  it('「上月」跨年：1 月看上月 = 去年 12 月，上期 = 去年 11 月', () => {
    const p = parseReportRange({ period: 'lastMonth' }, '2027-01-10')
    expect(p.current).toEqual({ start: '2026-12-01', end: '2026-12-31' })
    expect(p.previous).toEqual({ start: '2026-11-01', end: '2026-11-30' })
  })

  it('「上月」上期按自然月取整月，不与当期等长（3 月看 2 月 → 上期 1 月 31 天）', () => {
    const p = parseReportRange({ period: 'lastMonth' }, '2027-03-05')
    expect(p.current).toEqual({ start: '2027-02-01', end: '2027-02-28' })
    expect(p.previous).toEqual({ start: '2027-01-01', end: '2027-01-31' })
  })

  it('「本月」与板块页同口径：当期月初到今天，上期为上月同期', () => {
    const p = parseReportRange({ period: 'thisMonth' }, TODAY)
    expect(p.current).toEqual({ start: '2026-09-01', end: '2026-09-25' })
    expect(p.previous).toEqual({ start: '2026-08-01', end: '2026-08-25' })
  })

  it('「近 30 天」是相对预设：随今天滚动，上期为紧邻前 30 天', () => {
    const p = parseReportRange({ period: 'last30' }, TODAY)
    expect(p.current).toEqual({ start: '2026-08-27', end: '2026-09-25' })
    expect(p.previous).toEqual({ start: '2026-07-28', end: '2026-08-26' })
    expect(parseReportRange({ period: 'last30' }, '2026-10-01').current.end).toBe('2026-10-01')
  })

  it('自定义合法区间：上期为紧邻前一等长区间', () => {
    const p = parseReportRange({ period: 'custom', start: '2026-08-10', end: '2026-08-19' }, TODAY)
    expect(p.current).toEqual({ start: '2026-08-10', end: '2026-08-19' })
    expect(p.previous).toEqual({ start: '2026-07-31', end: '2026-08-09' })
    expect(p.label).toBe('2026-08-10 ~ 2026-08-19')
  })

  it.each([
    ['日历不存在的日期（#308）', { start: '2026-02-30', end: '2026-03-02' }],
    ['月份越界', { start: '2026-13-01', end: '2026-13-05' }],
    ['年份不足 4 位语义（0001 年）', { start: '0001-01-01', end: '0001-01-02' }],
    ['起止颠倒', { start: '2026-08-20', end: '2026-08-10' }],
    ['缺结束日', { start: '2026-08-10', end: undefined }],
  ])('自定义非法（%s）回落默认上月，不拿半截参数取数', (_label, range) => {
    const p = parseReportRange({ period: 'custom', ...range }, TODAY)
    expect(p.preset).toBe('lastMonth')
    expect(p.current).toEqual({ start: '2026-08-01', end: '2026-08-31' })
  })

  it('未知预设（含板块页的 month / year）回落默认上月，两套预设互不串用', () => {
    for (const period of ['month', 'year', 'today', 'zzz']) {
      expect(parseReportRange({ period }, TODAY).preset).toBe('lastMonth')
    }
  })
})

describe('parseReportMonth（单月型）', () => {
  it('默认上月', () => {
    const p = parseReportMonth({}, TODAY)
    expect(p.month).toBe('2026-08')
    expect(p.current).toEqual({ start: '2026-08-01', end: '2026-08-31' })
  })

  it('URL 手工传入早于 2026-07 的月份照常解析（页面显示空态与数据起点提示，不报错）', () => {
    expect(parseReportMonth({ month: '2026-05' }, TODAY).current).toEqual({ start: '2026-05-01', end: '2026-05-31' })
  })

  it('非法月份回落默认', () => {
    for (const month of ['2026-13', '2026-9', '26-09', '2026-00', 'x']) {
      expect(parseReportMonth({ month }, TODAY).month).toBe('2026-08')
    }
  })

  it('闰年 2 月取到 29 日', () => {
    expect(monthRange('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' })
  })

  it('默认月份不早于可选下限（2026-07 当月默认也是 2026-07）', () => {
    expect(defaultReportMonth('2026-07-15')).toBe(REPORT_MIN_MONTH)
    expect(defaultReportMonth('2026-08-01')).toBe('2026-07')
  })
})

describe('reportMonthOptions', () => {
  it('从本月倒序到 2026-07，选不到更早的月份', () => {
    expect(reportMonthOptions(TODAY)).toEqual(['2026-09', '2026-08', '2026-07'])
  })

  it('URL 月份不在可选范围时额外带上，控件如实回显', () => {
    expect(reportMonthOptions(TODAY, '2026-05')).toEqual(['2026-09', '2026-08', '2026-07', '2026-05'])
    expect(reportMonthOptions(TODAY, '2026-08')).toEqual(['2026-09', '2026-08', '2026-07'])
  })
})

describe('校验与月份运算', () => {
  it('isValidCalendarDate / isValidMonth', () => {
    expect(isValidCalendarDate('2028-02-29')).toBe(true)
    expect(isValidCalendarDate('2027-02-29')).toBe(false)
    expect(isValidMonth('2026-12')).toBe(true)
    expect(isValidMonth('1999-12')).toBe(false)
  })

  it('shiftMonth 跨年', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })
})
