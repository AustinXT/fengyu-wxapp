/**
 * 错误码/错误前缀白名单（payNotify 云函数侧）
 *
 * 9 项官方白名单 + parseErrorPrefix + buildErrorResponse 工具函数。
 * 与 fengyu-staff/cloudfunctions/staffApi/utils/error-codes.js、
 * fengyu-client/cloudfunctions/clientApi/utils/error-codes.js、
 * fengyu-admin/src/lib/api-error.ts 三处必须字节同义。
 *
 * 跨端一致性由以下 snapshot 测试守护，任一端漂移立即报错：
 *   - fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js
 *   - fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts
 *
 * payNotify 的响应外壳仍保持 {code: 'SUCCESS' | 'FAIL', message}（拉卡拉/微信支付回调协议），
 * 本模块仅提供 parseErrorPrefix 给错误日志做归类（ops 监控按 errorType 分组），
 * 以及 buildErrorResponse 在未来需要时复用。
 *
 * 关于 'PERMISSION_DENIED: PAYNOTIFY_DISABLED' feature flag：
 *   D-Q1-2026-04-26 决策守卫返回的 message 中 PAYNOTIFY_DISABLED 是二级前缀子标签，
 *   parseErrorPrefix 只解析一级，子标签透出在 displayMessage 中供日志归类。
 */

'use strict'

const ERROR_PREFIXES = Object.freeze([
  'UNAUTHORIZED',
  'PHONE_REQUIRED',
  'INVALID_PARAMS',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'INSUFFICIENT_BALANCE',
  'CONFLICT',
  'INVALID_STATE',
  'CLIENT_NOT_REGISTERED',
])

const CODE_MAP = Object.freeze({
  UNAUTHORIZED: -401,
  PHONE_REQUIRED: -403,
  PERMISSION_DENIED: -403,
  INVALID_PARAMS: -400,
  INSUFFICIENT_BALANCE: -400,
  INVALID_STATE: -400,
  CLIENT_NOT_REGISTERED: -400,
  NOT_FOUND: -404,
  CONFLICT: -409,
})

/**
 * 解析 message 中的一级错误前缀。
 * @param {string} message
 * @returns {{prefix: string, displayMessage: string} | null}
 */
function parseErrorPrefix(message) {
  if (!message || typeof message !== 'string') return null
  const m = message.match(/^([A-Z_]+):\s*/)
  if (!m) return null
  if (!ERROR_PREFIXES.includes(m[1])) return null
  return { prefix: m[1], displayMessage: message.slice(m[0].length) }
}

/**
 * 把 catch 到的 error 统一转换为 { code, message, errorType, data } 响应体。
 * 不在 9 项白名单中的错误一律降级为 {code:-1, message:'服务器内部错误', errorType:null}，
 * 原始 message 由调用方在外层 console.error 打印。
 *
 * @param {Error|unknown} error
 * @returns {{code: number, message: string, errorType: string|null, data: any}}
 */
function buildErrorResponse(error) {
  const errorMessage = (error && error.message) || '服务器内部错误'
  const parsed = parseErrorPrefix(errorMessage)
  if (parsed) {
    return {
      code: CODE_MAP[parsed.prefix] || -1,
      message: parsed.displayMessage,
      errorType: parsed.prefix,
      data: (error && error.data) || null,
    }
  }
  return {
    code: -1,
    message: '服务器内部错误',
    errorType: null,
    data: null,
  }
}

module.exports = { ERROR_PREFIXES, CODE_MAP, parseErrorPrefix, buildErrorResponse }
