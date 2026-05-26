import { describe, it, expect } from 'vitest'
import { resolveTimeRange, shanghaiToday, addDays, addYears } from './time-range'

// 锚点：Shanghai = 2024-01-03（周三）。2024-01-01 是周一，便于断言周/月/年边界。
const NOW = new Date('2024-01-03T04:00:00Z') // UTC+8 → 2024-01-03 12:00 上海

describe('shanghaiToday', () => {
  it('取 Asia/Shanghai 当日（UTC 凌晨也算上海当天）', () => {
    expect(shanghaiToday(NOW)).toBe('2024-01-03')
    // UTC 2024-01-02 23:00 → 上海 2024-01-03 07:00
    expect(shanghaiToday(new Date('2024-01-02T23:00:00Z'))).toBe('2024-01-03')
  })
})

describe('日期运算 helper', () => {
  it('addDays 跨月跨年', () => {
    expect(addDays('2024-01-01', -1)).toBe('2023-12-31')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29') // 闰年
  })
  it('addYears', () => {
    expect(addYears('2024-05-26', -1)).toBe('2023-05-26')
  })
})

describe('resolveTimeRange', () => {
  it('today：当日 / 昨日 / 去年今日', () => {
    const r = resolveTimeRange({ preset: 'today' }, NOW)
    expect(r.current).toEqual({ start: '2024-01-03', end: '2024-01-03' })
    expect(r.previous).toEqual({ start: '2024-01-02', end: '2024-01-02' })
    expect(r.lastYear).toEqual({ start: '2023-01-03', end: '2023-01-03' })
    expect(r.presetLabel).toBe('今日')
  })

  it('week：本周一至今 / 上周一至上周日 / 去年同区间', () => {
    const r = resolveTimeRange({ preset: 'week' }, NOW)
    expect(r.current).toEqual({ start: '2024-01-01', end: '2024-01-03' }) // 周一=01-01
    expect(r.previous).toEqual({ start: '2023-12-25', end: '2023-12-31' })
    expect(r.lastYear).toEqual({ start: '2023-01-01', end: '2023-01-03' })
    expect(r.presetLabel).toBe('本周')
  })

  it('month：月初至今 / 整个上月 / 去年同区间', () => {
    const r = resolveTimeRange({ preset: 'month' }, NOW)
    expect(r.current).toEqual({ start: '2024-01-01', end: '2024-01-03' })
    expect(r.previous).toEqual({ start: '2023-12-01', end: '2023-12-31' })
    expect(r.lastYear).toEqual({ start: '2023-01-01', end: '2023-01-03' })
    expect(r.presetLabel).toBe('本月')
  })

  it('year：年初至今 / 去年同区间（previous=lastYear）', () => {
    const r = resolveTimeRange({ preset: 'year' }, NOW)
    expect(r.current).toEqual({ start: '2024-01-01', end: '2024-01-03' })
    expect(r.previous).toEqual({ start: '2023-01-01', end: '2023-01-03' })
    expect(r.lastYear).toEqual(r.previous)
    expect(r.presetLabel).toBe('今年')
  })

  it('custom：紧邻前一等长区间 / 各减一年', () => {
    const r = resolveTimeRange({ preset: 'custom', start: '2026-03-01', end: '2026-03-31' }, NOW)
    expect(r.current).toEqual({ start: '2026-03-01', end: '2026-03-31' })
    // 31 天窗口的紧邻前一段：[2026-01-29, 2026-02-28]
    expect(r.previous).toEqual({ start: '2026-01-29', end: '2026-02-28' })
    expect(r.lastYear).toEqual({ start: '2025-03-01', end: '2025-03-31' })
    expect(r.presetLabel).toBe('2026-03-01 ~ 2026-03-31')
  })
})
