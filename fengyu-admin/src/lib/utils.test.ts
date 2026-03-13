import { describe, it, expect } from 'vitest'
import { formatCurrency, formatPhone, formatDate, formatDateTime, cn } from './utils'

describe('cn', () => {
  it('合并类名', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1')
  })

  it('Tailwind 冲突类去重', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })

  it('条件类名', () => {
    expect(cn('base', false && 'hidden', 'extra')).toBe('base extra')
  })

  it('空输入返回空字符串', () => {
    expect(cn()).toBe('')
  })
})

describe('formatCurrency', () => {
  it('数字转人民币格式', () => {
    expect(formatCurrency(100)).toBe('¥100.00')
    expect(formatCurrency(0)).toBe('¥0.00')
    expect(formatCurrency(99.9)).toBe('¥99.90')
  })

  it('字符串输入', () => {
    expect(formatCurrency('1999.00')).toBe('¥1999.00')
    expect(formatCurrency('0.99')).toBe('¥0.99')
  })

  it('负数（退款场景）', () => {
    expect(formatCurrency(-100)).toBe('¥-100.00')
  })
})

describe('formatPhone', () => {
  it('标准手机号脱敏', () => {
    expect(formatPhone('13812345678')).toBe('138****5678')
  })

  it('空值返回原值', () => {
    expect(formatPhone('')).toBe('')
  })

  it('非 11 位号码返回原值', () => {
    expect(formatPhone('1234')).toBe('1234')
    expect(formatPhone('123456789012')).toBe('123456789012')
  })
})

describe('formatDate', () => {
  it('字符串日期格式化', () => {
    const result = formatDate('2026-03-13T00:00:00.000Z')
    expect(result).toMatch(/2026/)
    expect(result).toMatch(/03/)
    expect(result).toMatch(/13/)
  })

  it('Date 对象格式化', () => {
    const result = formatDate(new Date(2026, 2, 13)) // 月份从 0 开始
    expect(result).toMatch(/2026/)
    expect(result).toMatch(/03/)
    expect(result).toMatch(/13/)
  })
})

describe('formatDateTime', () => {
  it('包含时间部分', () => {
    const result = formatDateTime('2026-03-13T14:30:00.000Z')
    expect(result).toMatch(/2026/)
    // 包含时分
    expect(result).toMatch(/\d{2}:\d{2}/)
  })

  it('Date 对象格式化', () => {
    const d = new Date(2026, 2, 13, 14, 30)
    const result = formatDateTime(d)
    expect(result).toMatch(/2026/)
    expect(result).toMatch(/14:30/)
  })
})
