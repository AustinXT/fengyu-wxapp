import { describe, it, expect } from 'vitest'
import { formatCurrency, formatPhone, formatDate, formatDateTime, cn, calcCouponDiscount } from './utils'

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

describe('calcCouponDiscount', () => {
  it('现金券：直接抵扣，不超过订单金额', () => {
    expect(calcCouponDiscount('现金券', '50', null, 200)).toBe(50)
    expect(calcCouponDiscount('现金券', '50', null, 30)).toBe(30) // 订单金额不足
  })

  it('品项券：同现金券逻辑', () => {
    expect(calcCouponDiscount('品项券', '100', null, 500)).toBe(100)
    expect(calcCouponDiscount('品项券', '100', null, 80)).toBe(80)
  })

  it('折扣券：按折扣率计算', () => {
    // 0.85折 = 85折，订单200，优惠 200 * 0.15 = 30
    expect(calcCouponDiscount('折扣券', '0.85', null, 200)).toBeCloseTo(30)
  })

  it('折扣券：封顶 maxDiscount', () => {
    // 0.8折，订单 1000，理论优惠 200，但封顶 100
    expect(calcCouponDiscount('折扣券', '0.8', '100', 1000)).toBe(100)
    // 不超过上限时正常计算
    expect(calcCouponDiscount('折扣券', '0.9', '100', 200)).toBeCloseTo(20)
  })

  it('折扣券：无 maxDiscount 限制', () => {
    // 0.7折，订单 500，优惠 150
    expect(calcCouponDiscount('折扣券', '0.7', null, 500)).toBeCloseTo(150)
  })
})
