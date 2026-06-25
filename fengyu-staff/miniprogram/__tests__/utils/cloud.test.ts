/**
 * cloud.ts 工具函数测试
 * 覆盖 sanitizeErrorMessage — 前端错误过滤防线
 */
import { sanitizeErrorMessage, callStaffApi } from '../../utils/cloud'

describe('sanitizeErrorMessage', () => {
  // ===== 正常业务错误（应原样透传） =====

  test('业务错误消息原样返回', () => {
    expect(sanitizeErrorMessage('该顾客已有待支付订单')).toBe('该顾客已有待支付订单')
  })

  test('权限错误原样返回', () => {
    expect(sanitizeErrorMessage('暂无权限')).toBe('暂无权限')
  })

  test('参数错误原样返回', () => {
    expect(sanitizeErrorMessage('缺少 saleOrderId')).toBe('缺少 saleOrderId')
  })

  test('短错误消息原样返回', () => {
    expect(sanitizeErrorMessage('操作失败')).toBe('操作失败')
  })

  // ===== 技术性错误（应被过滤为通用提示） =====

  test('SQL 约束错误被过滤', () => {
    expect(sanitizeErrorMessage('violates unique constraint "uq_sale_orders"'))
      .toBe('请求失败')
  })

  test('数据库连接错误被过滤', () => {
    expect(sanitizeErrorMessage('ECONNREFUSED 127.0.0.1:5432'))
      .toBe('请求失败')
  })

  test('超时错误被过滤', () => {
    expect(sanitizeErrorMessage('ETIMEDOUT: connection timed out'))
      .toBe('请求失败')
  })

  test('TypeError 被过滤', () => {
    expect(sanitizeErrorMessage("TypeError: Cannot read properties of undefined (reading 'id')"))
      .toBe('请求失败')
  })

  test('ReferenceError 被过滤', () => {
    expect(sanitizeErrorMessage('ReferenceError: pg is not defined'))
      .toBe('请求失败')
  })

  test('duplicate key 错误被过滤', () => {
    expect(sanitizeErrorMessage('duplicate key value violates unique constraint'))
      .toBe('请求失败')
  })

  test('SQL 语法错误被过滤', () => {
    expect(sanitizeErrorMessage('syntax error at or near "SELEC"'))
      .toBe('请求失败')
  })

  test('relation 不存在错误被过滤', () => {
    expect(sanitizeErrorMessage('relation "sale_orders" does not exist'))
      .toBe('请求失败')
  })

  test('column 不存在错误被过滤', () => {
    expect(sanitizeErrorMessage('column "unknown_col" of relation "orders" does not exist'))
      .toBe('请求失败')
  })

  test('null 访问错误被过滤', () => {
    expect(sanitizeErrorMessage('Cannot read property of null'))
      .toBe('请求失败')
  })

  // ===== 过长消息（通常是技术堆栈） =====

  test('超过 60 字符的消息被过滤', () => {
    const longMsg = 'Error: connect ECONNREFUSED at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16) at GetAddrInfoReqWrap.onlookup'
    expect(longMsg.length).toBeGreaterThan(60)
    expect(sanitizeErrorMessage(longMsg)).toBe('请求失败')
  })

  test('刚好 60 字符的消息不被过滤', () => {
    const msg60 = '一'.repeat(60)
    expect(sanitizeErrorMessage(msg60)).toBe(msg60)
  })

  // ===== 边界情况 =====

  test('空字符串返回 fallback', () => {
    expect(sanitizeErrorMessage('')).toBe('请求失败')
  })

  test('自定义 fallback', () => {
    expect(sanitizeErrorMessage('', '网络异常')).toBe('网络异常')
  })

  test('undefined/null 输入返回 fallback', () => {
    expect(sanitizeErrorMessage(undefined as any)).toBe('请求失败')
    expect(sanitizeErrorMessage(null as any)).toBe('请求失败')
  })

  // ===== 混合场景 =====

  test('含 constraint 但也是业务词的消息也被过滤（保守策略）', () => {
    // 安全策略：宁可过滤业务消息也不泄露技术信息
    expect(sanitizeErrorMessage('violates constraint rule')).toBe('请求失败')
  })

  test('INVALID_PARAMS 前缀原样返回', () => {
    expect(sanitizeErrorMessage('INVALID_PARAMS: 缺少参数')).toBe('INVALID_PARAMS: 缺少参数')
  })

  test('PERMISSION_DENIED 前缀原样返回', () => {
    expect(sanitizeErrorMessage('PERMISSION_DENIED: 无权操作')).toBe('PERMISSION_DENIED: 无权操作')
  })
})

describe('callStaffApi errorType 透传', () => {
  const origWx = (globalThis as any).wx

  beforeEach(() => {
    // 在 setup.ts 的 wx mock 基础上补 cloud.callFunction
    ;(globalThis as any).wx = {
      ...(globalThis as any).wx,
      cloud: { callFunction: vi.fn() },
    }
  })

  afterEach(() => {
    ;(globalThis as any).wx = origWx
  })

  test('白名单业务错误（errorType 非空）长文案原样透传，不被 sanitize 截断', async () => {
    const longMsg = '储值卡余额不足：本次开单实付 ¥88.00，当前账户可用余额仅 ¥12.00，尚差 ¥76.00，请先为顾客充值或调整本单的储值卡抵扣方案后再重新提交订单'
    expect(longMsg.length).toBeGreaterThan(60)
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: -400, message: longMsg, errorType: 'INSUFFICIENT_BALANCE', data: null },
    })

    await expect(callStaffApi('order.create', {})).rejects.toMatchObject({
      message: longMsg,
      errorType: 'INSUFFICIENT_BALANCE',
      code: -400,
    })
  })

  test('PERMISSION_DENIED 业务文案原样透传 + errorType 保留', async () => {
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: -403, message: '顾客不在当前数据范围', errorType: 'PERMISSION_DENIED' },
    })

    await expect(callStaffApi('customer.detail', {})).rejects.toMatchObject({
      message: '顾客不在当前数据范围',
      errorType: 'PERMISSION_DENIED',
    })
  })

  test('系统错误（errorType 为空）长文案仍被 sanitize 兜底为 fallback', async () => {
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: -1, message: 'A'.repeat(80), errorType: null },
    })

    await expect(callStaffApi('order.create', {})).rejects.toMatchObject({
      message: '请求失败',
      code: -1,
    })
  })

  test('正常响应返回 data', async () => {
    ;(globalThis as any).wx.cloud.callFunction.mockResolvedValue({
      result: { code: 0, message: 'success', data: { list: [{ id: 1 }] } },
    })

    const data = await callStaffApi<{ list: any[] }>('order.list', {})
    expect(data.list).toHaveLength(1)
  })
})
