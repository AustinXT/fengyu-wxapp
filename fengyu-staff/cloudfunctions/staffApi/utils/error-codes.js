/** 错误码/错误前缀（云函数侧）*/

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
