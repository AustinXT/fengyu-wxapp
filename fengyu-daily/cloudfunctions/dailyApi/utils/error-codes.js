/**
 * 错误码/错误前缀白名单（云函数侧）
 *
 * 9 项官方白名单 + parseErrorPrefix + buildErrorResponse 工具函数。
 * 与 fengyu-client/cloudfunctions/clientApi/utils/error-codes.js、
 * fengyu-client/cloudfunctions/payNotify/error-codes.js、
 * fengyu-admin/src/lib/api-error.ts 三处必须字节同义。
 *
 * 跨端一致性由以下 snapshot 测试守护，任一端漂移立即报错：
 *   - fengyu-staff/cloudfunctions/staffApi/__tests__/routes/cross-end-error-codes-snapshot.test.js
 *   - fengyu-admin/src/lib/__tests__/error-codes-cross-end.test.ts
 *
 * code 映射注意：
 *   - PHONE_REQUIRED 与 PERMISSION_DENIED 共用 -403 → 前端必须按 errorType 区分
 *   - INVALID_PARAMS / INSUFFICIENT_BALANCE / INVALID_STATE / CLIENT_NOT_REGISTERED
 *     共用 -400 → 同理按 errorType 区分
 *
 * 二级前缀语法（CAS-guard / payNotify feature flag 等场景）：
 *   throw new Error('INVALID_STATE: STATE_TRANSITION_BLOCKED: 订单状态已被其他操作变更')
 *   parseErrorPrefix 仅解析一级前缀，子标签随 displayMessage 透出。
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
