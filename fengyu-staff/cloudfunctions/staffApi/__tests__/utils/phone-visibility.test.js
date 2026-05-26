/**
 * phone-visibility helper 单测
 * 规则：manager 看全号，其余角色脱敏；空值安全。
 */

const { maskPhoneForAuth } = require('../../utils/phone-visibility')

describe('maskPhoneForAuth', () => {
  test('manager 看完整手机号', () => {
    expect(maskPhoneForAuth('13812345678', { roles: ['manager'] })).toBe('13812345678')
  })

  test('manager 角色与其它角色并存仍看全号', () => {
    expect(maskPhoneForAuth('13812345678', { roles: ['finance', 'manager'] })).toBe('13812345678')
  })

  test('普通员工（无 manager）脱敏', () => {
    expect(maskPhoneForAuth('13812345678', { roles: [] })).toBe('138****5678')
    expect(maskPhoneForAuth('13812345678', { roles: ['customer_mgr'] })).toBe('138****5678')
  })

  test('manager 但手机号为空 → 返回空串', () => {
    expect(maskPhoneForAuth(null, { roles: ['manager'] })).toBe('')
    expect(maskPhoneForAuth('', { roles: ['manager'] })).toBe('')
  })

  test('普通员工手机号为空 → 返回空串', () => {
    expect(maskPhoneForAuth(null, { roles: [] })).toBe('')
  })

  test('auth 缺失 / roles 非数组 → 当作非 manager 脱敏', () => {
    expect(maskPhoneForAuth('13812345678', undefined)).toBe('138****5678')
    expect(maskPhoneForAuth('13812345678', {})).toBe('138****5678')
    expect(maskPhoneForAuth('13812345678', { roles: null })).toBe('138****5678')
  })
})
