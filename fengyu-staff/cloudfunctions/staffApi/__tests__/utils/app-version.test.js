/**
 * app-version 工具测试 —— 从请求 payload 提取前端版本号（向后兼容分流管道）
 */
const { extractAppVersion } = require('../../utils/app-version')

describe('extractAppVersion', () => {
  test('提取合法版本串', () => {
    expect(extractAppVersion({ _appVersion: 'v0.17.14' })).toBe('v0.17.14')
  })

  test('去除首尾空白', () => {
    expect(extractAppVersion({ _appVersion: '  v1.0.0  ' })).toBe('v1.0.0')
  })

  test('缺失 _appVersion 返回 null', () => {
    expect(extractAppVersion({})).toBeNull()
    expect(extractAppVersion({ foo: 'bar' })).toBeNull()
  })

  test('空串 / 纯空白返回 null', () => {
    expect(extractAppVersion({ _appVersion: '' })).toBeNull()
    expect(extractAppVersion({ _appVersion: '   ' })).toBeNull()
  })

  test('非字符串返回 null', () => {
    expect(extractAppVersion({ _appVersion: 123 })).toBeNull()
    expect(extractAppVersion({ _appVersion: null })).toBeNull()
    expect(extractAppVersion({ _appVersion: { v: 1 } })).toBeNull()
  })

  test('payload 非对象返回 null', () => {
    expect(extractAppVersion(null)).toBeNull()
    expect(extractAppVersion(undefined)).toBeNull()
    expect(extractAppVersion('x')).toBeNull()
  })
})
