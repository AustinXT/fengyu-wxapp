import { formatDateTime, formatTime, getElapsedTime, STATUS_CLASS, ORDER_TYPE_LABEL } from '../../utils/formatters'

describe('formatDateTime', () => {
  test('正常日期格式化', () => {
    const result = formatDateTime('2025-03-14T10:30:45.000Z')
    // 结果取决于本地时区，但格式正确
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  test('Date 对象', () => {
    const result = formatDateTime(new Date(2025, 2, 14, 10, 30, 45))
    expect(result).toBe('2025-03-14 10:30:45')
  })

  test('null 返回空字符串', () => {
    expect(formatDateTime(null)).toBe('')
  })

  test('undefined 返回空字符串', () => {
    expect(formatDateTime(undefined)).toBe('')
  })

  test('空字符串返回空字符串', () => {
    expect(formatDateTime('')).toBe('')
  })

  test('无效字符串原样返回', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })
})

describe('formatTime', () => {
  test('正常时间字符串截取 HH:mm', () => {
    expect(formatTime('2025-03-14 10:30:45')).toBe('10:30')
  })

  test('ISO 格式', () => {
    expect(formatTime('2025-03-14T10:30:45.000Z')).toBe('10:30')
  })

  test('null 返回空字符串', () => {
    expect(formatTime(null)).toBe('')
  })

  test('空字符串返回空字符串', () => {
    expect(formatTime('')).toBe('')
  })

  test('短字符串返回原值', () => {
    expect(formatTime('10:30')).toBe('10:30')
  })
})

describe('getElapsedTime', () => {
  test('不足 60 分钟', () => {
    const now = new Date('2025/03/14 10:30:00')
    const result = getElapsedTime('2025-03-14 10:00:00', now)
    expect(result).toBe('进行中 30分钟')
  })

  test('刚好 0 分钟', () => {
    const now = new Date('2025/03/14 10:00:00')
    const result = getElapsedTime('2025-03-14 10:00:00', now)
    expect(result).toBe('进行中 0分钟')
  })

  test('超过 60 分钟 — 整小时', () => {
    const now = new Date('2025/03/14 12:00:00')
    const result = getElapsedTime('2025-03-14 10:00:00', now)
    expect(result).toBe('进行中 2小时')
  })

  test('超过 60 分钟 — 带余数', () => {
    const now = new Date('2025/03/14 11:30:00')
    const result = getElapsedTime('2025-03-14 10:00:00', now)
    expect(result).toBe('进行中 1小时30分钟')
  })

  test('null 返回空字符串', () => {
    expect(getElapsedTime(null)).toBe('')
  })

  test('空字符串返回空字符串', () => {
    expect(getElapsedTime('')).toBe('')
  })
})

describe('STATUS_CLASS', () => {
  test('待支付 → pending', () => {
    expect(STATUS_CLASS['待支付']).toBe('pending')
  })

  test('已支付 → success', () => {
    expect(STATUS_CLASS['已支付']).toBe('success')
  })

  test('支付失败 → error', () => {
    expect(STATUS_CLASS['支付失败']).toBe('error')
  })

  test('已完成 → done', () => {
    expect(STATUS_CLASS['已完成']).toBe('done')
  })

  test('已关闭 → done', () => {
    expect(STATUS_CLASS['已关闭']).toBe('done')
  })

  test('不存在的状态返回 undefined', () => {
    expect(STATUS_CLASS['不存在']).toBeUndefined()
  })
})

describe('ORDER_TYPE_LABEL', () => {
  test('普通 → 普通单', () => {
    expect(ORDER_TYPE_LABEL['普通']).toBe('普通单')
  })

  test('体验 → 体验单', () => {
    expect(ORDER_TYPE_LABEL['体验']).toBe('体验单')
  })

  test('福利活动 → 福利活动', () => {
    expect(ORDER_TYPE_LABEL['福利活动']).toBe('福利活动')
  })
})
