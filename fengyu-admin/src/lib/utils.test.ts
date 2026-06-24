import { describe, it, expect } from 'vitest'
import { formatCurrency, formatPhone, formatDate, formatDateTime, cn, calcCouponDiscount, buildOrgPath } from './utils'
import type { OrgNode } from './types'

describe('buildOrgPath（导出/列表「所属组织」列共用）', () => {
  const node = (
    id: string, name: string, type: OrgNode['type'], parentId: string | null,
  ): OrgNode => ({ id, name, type, parentId, sortOrder: 0, isActive: true, createdAt: '', updatedAt: '' })

  // 真实结构：总部 → 南昌凤御(市场) → { 南昌江信店(门店), 养生部(部门) }
  const tree: OrgNode[] = [
    node('hq', '总部', '总部', null),
    node('mk', '南昌凤御', '市场', 'hq'),
    node('store', '南昌江信店', '门店', 'mk'),
    node('dept', '养生部', '部门', 'mk'),
  ]

  it('部门节点构建完整路径并跳过总部根（无门店员工：养生师）', () => {
    expect(buildOrgPath('dept', tree)).toBe('南昌凤御/养生部')
  })

  it('门店节点构建完整路径（门店员工）', () => {
    expect(buildOrgPath('store', tree)).toBe('南昌凤御/南昌江信店')
  })

  it('市场节点返回市场名', () => {
    expect(buildOrgPath('mk', tree)).toBe('南昌凤御')
  })

  it('叶子即总部节点时仍显示自身（i===0 例外）', () => {
    expect(buildOrgPath('hq', tree)).toBe('总部')
  })

  it('nodeId 为 null 返回空串', () => {
    expect(buildOrgPath(null, tree)).toBe('')
  })

  it('orgNodes 为空返回空串', () => {
    expect(buildOrgPath('dept', [])).toBe('')
  })

  it('nodeId 不在树中返回空串', () => {
    expect(buildOrgPath('ghost', tree)).toBe('')
  })
})

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

  it('空值/非数值兜底为 ¥0.00（历史数据金额 NULL 不致整页崩溃）', () => {
    expect(formatCurrency(null)).toBe('¥0.00')
    expect(formatCurrency(undefined)).toBe('¥0.00')
    expect(formatCurrency('')).toBe('¥0.00')
    expect(formatCurrency('abc')).toBe('¥0.00')
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
    // 固定时区收口后按 Asia/Shanghai 取日期，用带 +08:00 的确定性实例避免依赖进程 TZ
    const result = formatDate(new Date('2026-03-13T12:00:00+08:00'))
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
    // 固定时区收口后按 Asia/Shanghai 渲染，用带 +08:00 的确定性实例避免依赖进程 TZ
    const d = new Date('2026-03-13T14:30:00+08:00')
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
