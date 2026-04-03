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

  test('PG timestamp 格式（Safari 兼容路径：不含 T，使用 replace(/-/g, "/")）', () => {
    // PG 返回格式 '2025-03-14 10:30:45'，不含 T
    // Safari 不支持 new Date('2025-03-14 10:30:45')，需 replace 为 '2025/03/14 10:30:45'
    const result = formatDateTime('2025-03-14 10:30:45')
    expect(result).toBe('2025-03-14 10:30:45')
  })

  test('数字时间戳', () => {
    const ts = new Date(2025, 2, 14, 10, 30, 45).getTime()
    const result = formatDateTime(ts)
    expect(result).toBe('2025-03-14 10:30:45')
  })

  test('仅日期字符串（无时间部分，Safari 兼容）', () => {
    const result = formatDateTime('2025-03-14')
    expect(result).toMatch(/^2025-03-14/)
  })

  test('falsy 数字 0 返回空字符串（非 epoch）', () => {
    expect(formatDateTime(0)).toBe('')
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
  test('销售单 → 销售单', () => {
    expect(ORDER_TYPE_LABEL['销售单']).toBe('销售单')
  })

  test('回款单 → 回款单', () => {
    expect(ORDER_TYPE_LABEL['回款单']).toBe('回款单')
  })

  test('转换单 → 转换单', () => {
    expect(ORDER_TYPE_LABEL['转换单']).toBe('转换单')
  })

  test('退款单 → 退款单', () => {
    expect(ORDER_TYPE_LABEL['退款单']).toBe('退款单')
  })

  test('内部单 → 内部单', () => {
    expect(ORDER_TYPE_LABEL['内部单']).toBe('内部单')
  })
})
