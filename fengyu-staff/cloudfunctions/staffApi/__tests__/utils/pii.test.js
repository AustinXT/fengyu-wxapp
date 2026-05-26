/**
 * staff 端 pii.js 行为单测（与 admin pii.test.ts 字面一致）。
 * 跨端字面一致性由 routes/cross-end-pii-snapshot.test.js 守护。
 */
const {
  maskPhone,
  maskName,
  maskIdCard,
  maskEmail,
  maskOpenid,
  sanitizeDetail,
  SENSITIVE_KEYS,
} = require('../../utils/pii')

describe('maskPhone', () => {
  test('11 位手机号 → 前 3 后 4', () => {
    expect(maskPhone('13812345678')).toBe('138****5678')
  })
  test('5 位 → 首末保留', () => {
    expect(maskPhone('12345')).toBe('1***5')
  })
  test('4 位及以下 → 全 *', () => {
    expect(maskPhone('1234')).toBe('****')
  })
  test('空 / null → 空', () => {
    expect(maskPhone('')).toBe('')
    expect(maskPhone(null)).toBe('')
  })
})

describe('maskName', () => {
  test('2 字 → 首 + *', () => {
    expect(maskName('张三')).toBe('张*')
  })
  test('3 字 → 首末保留', () => {
    expect(maskName('王小明')).toBe('王*明')
  })
  test('4 字 → 首末保留 + 中间 **', () => {
    expect(maskName('李四五六')).toBe('李**六')
  })
})

describe('maskIdCard', () => {
  test('18 位身份证', () => {
    expect(maskIdCard('110101199001011234')).toBe('1101**********1234')
  })
  test('短串', () => {
    expect(maskIdCard('12345')).toBe('*****')
  })
})

describe('maskEmail', () => {
  test('正常邮箱', () => {
    expect(maskEmail('foo@bar.com')).toBe('f*o@bar.com')
  })
  test('local 1 字 → 不脱敏', () => {
    expect(maskEmail('a@b.c')).toBe('a@b.c')
  })
})

describe('maskOpenid', () => {
  test('正常 openid', () => {
    expect(maskOpenid('oABC1234XYZ5678')).toBe('oABC*******5678')
  })
})

describe('SENSITIVE_KEYS', () => {
  test('9 项白名单', () => {
    expect(SENSITIVE_KEYS.size).toBe(9)
    expect(SENSITIVE_KEYS.has('phone')).toBe(true)
    expect(SENSITIVE_KEYS.has('name')).toBe(false)
  })
})

describe('sanitizeDetail', () => {
  test('顶层 phone 脱敏', () => {
    expect(sanitizeDetail({ phone: '13812345678' })).toEqual({ phone: '138****5678' })
  })
  test('changes.phone.{from,to} 通过继承上下文脱敏', () => {
    expect(sanitizeDetail({
      changes: { phone: { from: '13800000000', to: '13912345678' } },
    })).toEqual({
      changes: { phone: { from: '138****0000', to: '139****5678' } },
    })
  })
  test('name 默认不脱敏', () => {
    expect(sanitizeDetail({ name: '张三' })).toEqual({ name: '张三' })
  })
  test('snake_case 也被脱敏', () => {
    expect(sanitizeDetail({ id_card: '110101199001011234' })).toEqual({
      id_card: '1101**********1234',
    })
  })
})
