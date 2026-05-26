import { describe, it, expect } from 'vitest'
import {
  maskPhone,
  maskName,
  maskIdCard,
  maskEmail,
  maskOpenid,
  sanitizeDetail,
  SENSITIVE_KEYS,
} from '../pii'

describe('maskPhone', () => {
  it('11 位手机号 → 前 3 后 4', () => {
    expect(maskPhone('13812345678')).toBe('138****5678')
  })
  it('5 位短串 → 首末保留', () => {
    expect(maskPhone('12345')).toBe('1***5')
  })
  it('4 位及以下 → 全 *', () => {
    expect(maskPhone('1234')).toBe('****')
    expect(maskPhone('12')).toBe('**')
  })
  it('空 / null / 非字符串 → 空串', () => {
    expect(maskPhone('')).toBe('')
    expect(maskPhone(null)).toBe('')
    expect(maskPhone(undefined)).toBe('')
  })
  it('长度 12+ 中间星数动态扩展（保持总长度）', () => {
    expect(maskPhone('123456789012')).toBe('123*****9012') // 12 chars: 3+5+4
  })
})

describe('maskName', () => {
  it('2 字 → 首字 + *', () => {
    expect(maskName('张三')).toBe('张*')
  })
  it('3 字 → 首末保留', () => {
    expect(maskName('王小明')).toBe('王*明')
  })
  it('4 字 → 首末保留 + 中间 **', () => {
    expect(maskName('李四五六')).toBe('李**六')
  })
  it('1 字 → *', () => {
    expect(maskName('王')).toBe('*')
  })
  it('空 → 空', () => {
    expect(maskName('')).toBe('')
    expect(maskName(null)).toBe('')
  })
})

describe('maskIdCard', () => {
  it('18 位身份证 → 前 4 后 4', () => {
    expect(maskIdCard('110101199001011234')).toBe('1101**********1234')
  })
  it('短于 8 位 → 全 *', () => {
    expect(maskIdCard('12345')).toBe('*****')
  })
  it('空 → 空', () => {
    expect(maskIdCard('')).toBe('')
  })
})

describe('maskEmail', () => {
  it('正常邮箱 → local 首末保留 + domain 原文', () => {
    expect(maskEmail('foo@bar.com')).toBe('f*o@bar.com')
  })
  it('local 1 字 → 不脱敏', () => {
    expect(maskEmail('a@b.c')).toBe('a@b.c')
  })
  it('local 2 字 → 首字 + *', () => {
    expect(maskEmail('ab@c.d')).toBe('a*@c.d')
  })
  it('无 @ → 退化为 name 脱敏', () => {
    expect(maskEmail('notemail')).toBe('n******l')
  })
  it('空 → 空', () => {
    expect(maskEmail('')).toBe('')
  })
})

describe('maskOpenid', () => {
  it('正常 openid → 前 4 后 4', () => {
    expect(maskOpenid('oABC1234XYZ5678')).toBe('oABC*******5678')
  })
  it('短于 8 位 → 全 *', () => {
    expect(maskOpenid('short')).toBe('*****')
  })
})

describe('SENSITIVE_KEYS', () => {
  it('包含 9 个白名单键', () => {
    expect(SENSITIVE_KEYS.size).toBe(9)
    for (const k of ['phone', 'mobile', 'tel', 'idCard', 'id_card', 'idNumber', 'email', 'openid', 'open_id']) {
      expect(SENSITIVE_KEYS.has(k)).toBe(true)
    }
  })
  it('不含 name 系列（ticket §2.7 — 审计需保留）', () => {
    expect(SENSITIVE_KEYS.has('name')).toBe(false)
    expect(SENSITIVE_KEYS.has('realName')).toBe(false)
  })
})

describe('sanitizeDetail', () => {
  it('顶层 phone 字段被脱敏', () => {
    expect(sanitizeDetail({ phone: '13812345678' })).toEqual({ phone: '138****5678' })
  })
  it('多种 PII 字段同时脱敏', () => {
    expect(sanitizeDetail({
      phone: '13812345678',
      idCard: '110101199001011234',
      email: 'foo@bar.com',
      openid: 'oABC1234XYZ5678',
    })).toEqual({
      phone: '138****5678',
      idCard: '1101**********1234',
      email: 'f*o@bar.com',
      openid: 'oABC*******5678',
    })
  })
  it('name 默认不脱敏（与 SENSITIVE_KEYS 一致）', () => {
    expect(sanitizeDetail({ name: '张三', phone: '13812345678' })).toEqual({
      name: '张三', phone: '138****5678',
    })
  })
  it('嵌套对象内 phone 被脱敏', () => {
    expect(sanitizeDetail({ snapshot: { phone: '13812345678', nickname: '小明' } })).toEqual({
      snapshot: { phone: '138****5678', nickname: '小明' },
    })
  })
  it('数组内对象内 phone 被脱敏', () => {
    expect(sanitizeDetail({ items: [{ phone: '13812345678' }, { phone: '13900000000' }] })).toEqual({
      items: [{ phone: '138****5678' }, { phone: '139****0000' }],
    })
  })
  it('changes.phone.from/to 通过继承 key 上下文脱敏（ticket §6.5）', () => {
    expect(sanitizeDetail({
      changes: { phone: { from: '13800000000', to: '13912345678' } },
    })).toEqual({
      changes: { phone: { from: '138****0000', to: '139****5678' } },
    })
  })
  it('非 PII 字段（amount/id）保持原值', () => {
    expect(sanitizeDetail({ amount: 100, status: 'ok', id: 'X-001' })).toEqual({
      amount: 100, status: 'ok', id: 'X-001',
    })
  })
  it('null / undefined / primitive 直接返回', () => {
    expect(sanitizeDetail(null)).toBe(null)
    expect(sanitizeDetail(undefined)).toBe(undefined)
    expect(sanitizeDetail(42 as any)).toBe(42)
    expect(sanitizeDetail('plain' as any)).toBe('plain')
  })
  it('snake_case key（id_card / open_id）也被脱敏', () => {
    expect(sanitizeDetail({ id_card: '110101199001011234', open_id: 'oABC1234XYZ5678' })).toEqual({
      id_card: '1101**********1234',
      open_id: 'oABC*******5678',
    })
  })
})
