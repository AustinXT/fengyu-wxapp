/**
 * staffApi → clientApi 跨 env 桥的错误还原（issue #214）
 *
 * 这条链路最容易被 mock 掩盖：clientApi 的 `buildErrorResponse` 会把一级白名单前缀
 * 从 message 里**剥掉**（放进 errorType），而写测试时很自然会 mock 一个「带全前缀」
 * 的 message —— 那种形态生产根本不存在，于是「店员看到服务器内部错误」这个缺陷
 * 就被理想化的 mock 藏住了。这里直接按 clientApi 的真实响应形态断言。
 */

// 本模块被 __tests__/setup.js 用 require.cache 全局 mock（供 routes 测试用），
// 这里要测真实实现，所以先把 mock 从 cache 里摘掉再 require。
const path = require('path')
const bridgePath = require.resolve('../../utils/client-api-bridge')
delete require.cache[bridgePath]
const { buildBridgeError } = require(bridgePath)

describe('client-api-bridge：错误一级前缀还原', () => {
  // clientApi buildErrorResponse 的真实输出形态：message 不含一级前缀，前缀在 errorType
  test('按 errorType 重建一级前缀（clientApi 已剥掉它）', () => {
    const err = buildBridgeError({
      code: -409,
      errorType: 'CONFLICT',
      message: 'PAYMENT_ALREADY_SUCCEEDED: 支付已成功，正在更新订单，请稍后刷新',
    })
    expect(err.message).toBe(
      'CONFLICT: PAYMENT_ALREADY_SUCCEEDED: 支付已成功，正在更新订单，请稍后刷新',
    )
  })

  test('二级子标签原样保留（只补一级前缀）', () => {
    const err = buildBridgeError({
      code: -409,
      errorType: 'CONFLICT',
      message: 'PAYMENT_STATUS_UNCERTAIN: 暂时无法确认支付结果，请稍后重试',
    })
    expect(err.message.startsWith('CONFLICT: PAYMENT_STATUS_UNCERTAIN:')).toBe(true)
  })

  test('message 已自带前缀时不重复拼接', () => {
    const err = buildBridgeError({
      code: -409,
      errorType: 'CONFLICT',
      message: 'CONFLICT: 已经带前缀了',
    })
    expect(err.message).toBe('CONFLICT: 已经带前缀了')
  })

  test('errorType 缺失（clientApi 自身降级为 -1）→ 归 INVALID_STATE，不裸奔', () => {
    const err = buildBridgeError({ code: -1, errorType: null, message: '服务器内部错误' })
    expect(err.message).toBe('INVALID_STATE: 服务器内部错误')
  })

  test('空响应 → 仍给出带前缀的可归类错误', () => {
    expect(buildBridgeError(null).message).toBe('INVALID_STATE: clientApi 调用失败')
  })

  // 白名单来自 staffApi utils/error-codes.js；前缀对不上会被降级成「服务器内部错误」
  test('还原出的前缀落在 9 项白名单内', () => {
    const { ERROR_PREFIXES } = require(path.resolve(__dirname, '../../utils/error-codes'))
    for (const type of ['CONFLICT', 'INVALID_STATE', 'NOT_FOUND', 'PERMISSION_DENIED']) {
      const err = buildBridgeError({ code: -1, errorType: type, message: 'x' })
      const prefix = err.message.split(':')[0]
      expect(ERROR_PREFIXES).toContain(prefix)
    }
  })
})
