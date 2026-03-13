/**
 * 参数校验中间件测试
 */

const { requireFields, validateTypes } = require('../../middleware/validate')

describe('requireFields', () => {
  test('所有必填字段存在则通过', () => {
    const ctx = { event: { payload: { name: '张三', phone: '138' } } }
    let called = false
    requireFields('name', 'phone')(ctx, () => { called = true })
    expect(called).toBe(true)
  })

  test('缺少必填字段抛出 INVALID_PARAMS', () => {
    const ctx = { event: { payload: { name: '张三' } } }
    expect(() => requireFields('name', 'phone', 'age')(ctx, () => {}))
      .toThrow(/INVALID_PARAMS.*phone.*age/)
  })

  test('payload 为空对象', () => {
    const ctx = { event: { payload: {} } }
    expect(() => requireFields('name')(ctx, () => {}))
      .toThrow(/INVALID_PARAMS.*name/)
  })

  test('payload 不存在', () => {
    const ctx = { event: {} }
    expect(() => requireFields('name')(ctx, () => {}))
      .toThrow(/INVALID_PARAMS/)
  })

  test('字段值为 undefined 视为缺少', () => {
    const ctx = { event: { payload: { name: undefined } } }
    expect(() => requireFields('name')(ctx, () => {}))
      .toThrow(/INVALID_PARAMS/)
  })

  test('字段值为 null / 空字符串 / 0 / false 视为存在', () => {
    const ctx = { event: { payload: { a: null, b: '', c: 0, d: false } } }
    let called = false
    requireFields('a', 'b', 'c', 'd')(ctx, () => { called = true })
    expect(called).toBe(true)
  })
})

describe('validateTypes', () => {
  test('类型匹配则通过', () => {
    const ctx = {
      event: {
        payload: { name: '张三', age: 25, tags: ['vip'], meta: { k: 1 } },
      },
    }
    let called = false
    validateTypes({ name: 'string', age: 'number', tags: 'array', meta: 'object' })(ctx, () => { called = true })
    expect(called).toBe(true)
  })

  test('字符串类型不匹配抛出 INVALID_PARAMS', () => {
    const ctx = { event: { payload: { name: 123 } } }
    expect(() => validateTypes({ name: 'string' })(ctx, () => {}))
      .toThrow(/INVALID_PARAMS.*name.*string.*number/)
  })

  test('数组使用 array 类型校验通过', () => {
    const ctx = { event: { payload: { items: [1, 2] } } }
    let called = false
    validateTypes({ items: 'array' })(ctx, () => { called = true })
    expect(called).toBe(true)
  })

  test('object 不应匹配 array', () => {
    const ctx = { event: { payload: { items: [1, 2] } } }
    expect(() => validateTypes({ items: 'object' })(ctx, () => {}))
      .toThrow(/INVALID_PARAMS.*items.*object.*array/)
  })

  test('未提供的可选字段不校验', () => {
    const ctx = { event: { payload: {} } }
    let called = false
    validateTypes({ name: 'string', age: 'number' })(ctx, () => { called = true })
    expect(called).toBe(true)
  })
})
