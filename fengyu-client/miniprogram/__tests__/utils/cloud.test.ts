/**
 * cloud.ts 工具函数测试
 * 覆盖：sanitizeErrorMessage（技术性错误过滤）、callClientApi（网络错误防护）
 */

import { sanitizeErrorMessage, callClientApi, bindPhoneWithCloudID } from '../../utils/cloud'
import { getApiFnName } from '../../utils/cloud-env'

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
    ;(globalThis as any).wx?.__resetStorage?.()
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

  test('退出态阻断私有 action，不调用 clientApi', async () => {
    ;(globalThis as any).wx.setStorageSync('clientLoggedOut', true)

    await expect(callClientApi('coupon.list', {})).rejects.toMatchObject({
      code: -403,
      errorType: 'PHONE_REQUIRED',
      data: null,
    })
    expect((globalThis as any).wx.cloud.callFunction).not.toHaveBeenCalled()
  })

  test('退出态允许公开浏览 action', async () => {
    ;(globalThis as any).wx.setStorageSync('clientLoggedOut', true)
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: 0, message: 'success', data: { spuList: [] } },
    })

    const data = await callClientApi<{ spuList: any[] }>('product.shopInit', {})
    expect(data.spuList).toEqual([])
    expect((globalThis as any).wx.cloud.callFunction).toHaveBeenCalledWith({
      name: getApiFnName(),
      data: {
        action: 'product.shopInit',
        payload: expect.objectContaining({ _appVersion: expect.any(String) }),
      },
    })
  })

  test('退出态允许 auth.login 通过 OPENID 恢复已有账户', async () => {
    ;(globalThis as any).wx.setStorageSync('clientLoggedOut', true)
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: {
        code: 0,
        message: 'success',
        data: { userId: 'FYGK-20260901-00001', phone: '13800000000' },
      },
    })

    const data = await callClientApi<{ userId: string; phone: string }>('auth.login', {})

    expect(data.phone).toBe('13800000000')
    expect((globalThis as any).wx.cloud.callFunction).toHaveBeenCalledWith({
      name: getApiFnName(),
      data: {
        action: 'auth.login',
        payload: expect.objectContaining({ _appVersion: expect.any(String) }),
      },
    })
  })

  test('退出态允许 store.getUnbindRequest，门店详情页并发请求不 fail-fast', async () => {
    ;(globalThis as any).wx.setStorageSync('clientLoggedOut', true)
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: 0, message: 'success', data: { request: null } },
    })

    const data = await callClientApi<{ request: unknown }>('store.getUnbindRequest', { storeId: 'store-1' })

    // 服务端对访客返回 {request:null}，本地白名单放行后整页 Promise.all 不再被拦截
    expect(data.request).toBeNull()
    expect((globalThis as any).wx.cloud.callFunction).toHaveBeenCalledWith({
      name: getApiFnName(),
      data: {
        action: 'store.getUnbindRequest',
        payload: expect.objectContaining({ storeId: 'store-1' }),
      },
    })
  })

  // ===== bindPhoneWithCloudID single-flight：付费手机号验证防双消耗 =====

  test('并发调用复用同一 in-flight 请求，只发一次云函数调用', async () => {
    let resolveFirst!: (value: unknown) => void
    const slowFirst = new Promise((resolve) => { resolveFirst = resolve })
    const callFn = (globalThis as any).wx.cloud.callFunction
    callFn.mockImplementationOnce(() => slowFirst)

    const p1 = bindPhoneWithCloudID('CLOUD-1')
    const p2 = bindPhoneWithCloudID('CLOUD-2') // 第二次调用应直接复用 p1，不消耗第二个 cloudID

    resolveFirst({
      result: { code: 0, message: 'success', data: { userId: 'u-1', phone: '13800000000', updatedOrdersCount: 0 } },
    })

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.userId).toBe('u-1')
    expect(r2.userId).toBe('u-1')
    expect(callFn).toHaveBeenCalledTimes(1)
    // 成功后清登出标记并持久化 phone
    expect((globalThis as any).wx.getStorageSync('clientLoggedOut')).toBe('')
    expect((globalThis as any).wx.getStorageSync('phone')).toBe('13800000000')
  })

  test('in-flight 结束后再次调用发起全新请求（锁不粘滞）', async () => {
    const callFn = (globalThis as any).wx.cloud.callFunction
    callFn.mockResolvedValue({
      result: { code: 0, message: 'success', data: { userId: 'u-2', phone: '13900000000', updatedOrdersCount: 0 } },
    })

    await bindPhoneWithCloudID('CLOUD-A')
    await bindPhoneWithCloudID('CLOUD-B')

    expect(callFn).toHaveBeenCalledTimes(2)
  })

  // ===== errorType 透传：白名单业务错误信任后端文案，跳过 sanitize =====

  test('白名单业务错误（errorType 非空）长文案原样透传，不被 sanitize 截断', async () => {
    const longMsg = '储值卡余额不足：本次开单实付 ¥88.00，当前账户可用余额仅 ¥12.00，尚差 ¥76.00，请先为顾客充值或调整本单的储值卡抵扣方案后再重新提交订单'
    expect(longMsg.length).toBeGreaterThan(60)
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: -400, message: longMsg, errorType: 'INSUFFICIENT_BALANCE', data: null },
    })

    try {
      await callClientApi('order.create', {})
      expect.unreachable('should throw')
    } catch (err: any) {
      expect(err.message).toBe(longMsg)
      expect(err.errorType).toBe('INSUFFICIENT_BALANCE')
      expect(err.code).toBe(-400)
    }
  })

  test('系统错误（errorType 为空）长文案仍被 sanitize 兜底为 fallback', async () => {
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: -1, message: 'A'.repeat(80), errorType: null, data: null },
    })

    try {
      await callClientApi('order.create', {})
      expect.unreachable('should throw')
    } catch (err: any) {
      expect(err.message).toBe('请求失败')
      expect(err.code).toBe(-1)
    }
  })

  test('系统错误（errorType 为空）含技术关键词仍被 sanitize 兜底', async () => {
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: -1, message: 'duplicate key violates unique constraint', errorType: null },
    })

    try {
      await callClientApi('order.create', {})
      expect.unreachable('should throw')
    } catch (err: any) {
      expect(err.message).toBe('请求失败')
    }
  })
})
