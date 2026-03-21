/**
 * cloud.ts 工具函数测试
 * 覆盖：sanitizeErrorMessage（技术性错误过滤）、callClientApi（网络错误防护）
 */

import { sanitizeErrorMessage, callClientApi } from '../../utils/cloud'

describe('sanitizeErrorMessage', () => {
  test('空字符串 → 默认 fallback', () => {
    expect(sanitizeErrorMessage('')).toBe('请求失败')
  })

  test('null/undefined → 默认 fallback', () => {
    expect(sanitizeErrorMessage(null as any)).toBe('请求失败')
    expect(sanitizeErrorMessage(undefined as any)).toBe('请求失败')
  })

  test('正常业务错误消息原样返回', () => {
    expect(sanitizeErrorMessage('该手机号已被绑定')).toBe('该手机号已被绑定')
    expect(sanitizeErrorMessage('门店不存在')).toBe('门店不存在')
  })

  test('自定义 fallback 参数生效', () => {
    expect(sanitizeErrorMessage('', '操作失败')).toBe('操作失败')
    expect(sanitizeErrorMessage('violates constraint', '操作失败')).toBe('操作失败')
  })

  // 技术性关键词过滤
  test('含 "violates" → fallback', () => {
    expect(sanitizeErrorMessage('violates foreign key constraint')).toBe('请求失败')
  })

  test('含 "constraint" → fallback', () => {
    expect(sanitizeErrorMessage('unique constraint violation')).toBe('请求失败')
  })

  test('含 "duplicate key" → fallback', () => {
    expect(sanitizeErrorMessage('duplicate key value violates unique')).toBe('请求失败')
  })

  test('含 "ECONNREFUSED" → fallback', () => {
    expect(sanitizeErrorMessage('ECONNREFUSED 127.0.0.1:5432')).toBe('请求失败')
  })

  test('含 "ETIMEDOUT" → fallback', () => {
    expect(sanitizeErrorMessage('ETIMEDOUT connection timeout')).toBe('请求失败')
  })

  test('含 "TypeError" → fallback', () => {
    expect(sanitizeErrorMessage('TypeError: Cannot read properties of undefined')).toBe('请求失败')
  })

  test('含 "ReferenceError" → fallback', () => {
    expect(sanitizeErrorMessage('ReferenceError: foo is not defined')).toBe('请求失败')
  })

  test('含 "Cannot read" → fallback', () => {
    expect(sanitizeErrorMessage('Cannot read property length of null')).toBe('请求失败')
  })

  test('含 "undefined is not" → fallback', () => {
    expect(sanitizeErrorMessage('undefined is not a function')).toBe('请求失败')
  })

  test('含 "null is not" → fallback', () => {
    expect(sanitizeErrorMessage('null is not an object')).toBe('请求失败')
  })

  test('含 "syntax error" → fallback', () => {
    expect(sanitizeErrorMessage('syntax error at or near "WHERE"')).toBe('请求失败')
  })

  test('大小写不敏感："VIOLATES" → fallback', () => {
    expect(sanitizeErrorMessage('VIOLATES foreign key')).toBe('请求失败')
  })

  test('大小写不敏感："TYPEERROR" → fallback', () => {
    expect(sanitizeErrorMessage('TYPEERROR something')).toBe('请求失败')
  })

  // 长度过滤
  test('消息长度 ≤ 60 → 通过', () => {
    const msg = '手机号格式不正确，请输入11位有效手机号'  // 18 chars
    expect(sanitizeErrorMessage(msg)).toBe(msg)
  })

  test('消息长度恰好 60 → 通过', () => {
    const msg = 'A'.repeat(60)
    expect(sanitizeErrorMessage(msg)).toBe(msg)
  })

  test('消息长度 61 → fallback', () => {
    const msg = 'A'.repeat(61)
    expect(sanitizeErrorMessage(msg)).toBe('请求失败')
  })

  test('消息很长（> 60 字符）→ fallback', () => {
    // 61 个中文字符（每个 length=1），超过 60 字符限制
    const msg = '这'.repeat(61)
    expect(sanitizeErrorMessage(msg)).toBe('请求失败')
  })
})

describe('callClientApi 网络错误防护', () => {
  const origCloud = (globalThis as any).wx?.cloud

  beforeEach(() => {
    // 模拟 wx.cloud
    ;(globalThis as any).wx = {
      ...(globalThis as any).wx,
      cloud: {
        callFunction: vi.fn(),
        CloudID: vi.fn((id: string) => ({ cloudID: id })),
      },
    }
  })

  afterEach(() => {
    if (origCloud) {
      ;(globalThis as any).wx.cloud = origCloud
    }
  })

  test('业务错误携带 errorType 和 data', async () => {
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: -403, message: '请先绑定手机号', errorType: 'PHONE_REQUIRED', data: null },
    })

    try {
      await callClientApi('order.create', {})
      expect.unreachable('should throw')
    } catch (err: any) {
      expect(err.message).toBe('请先绑定手机号')
      expect(err.errorType).toBe('PHONE_REQUIRED')
      expect(err.code).toBe(-403)
    }
  })

  test('网络超时错误 → 友好提示，不暴露技术信息', async () => {
    ;(globalThis as any).wx.cloud.callFunction.mockRejectedValue(
      new Error('cloud.callFunction:fail Error: timeout')
    )

    try {
      await callClientApi('order.list', {})
      expect.unreachable('should throw')
    } catch (err: any) {
      expect(err.message).toBe('网络异常，请稍后重试')
      expect(err.code).toBe(-1)
      // 不应暴露原始 SDK 错误
      expect(err.message).not.toContain('cloud.callFunction')
    }
  })

  test('网络断开错误 → 友好提示', async () => {
    ;(globalThis as any).wx.cloud.callFunction.mockRejectedValue({
      errMsg: 'cloud.callFunction:fail Error: ECONNREFUSED',
    })

    try {
      await callClientApi('store.list', {})
      expect.unreachable('should throw')
    } catch (err: any) {
      expect(err.message).toBe('网络异常，请稍后重试')
      expect(err.code).toBe(-1)
    }
  })

  test('正常响应返回 data', async () => {
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: 0, message: 'success', data: { orders: [{ id: 1 }] } },
    })

    const data = await callClientApi<{ orders: any[] }>('order.list', {})
    expect(data.orders).toHaveLength(1)
  })
})
