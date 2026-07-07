

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


function parseErrorPrefix(message) {
  if (!message || typeof message !== 'string') return null
  const m = message.match(/^([A-Z_]+):\s*/)
  if (!m) return null
  if (!ERROR_PREFIXES.includes(m[1])) return null
  return { prefix: m[1], displayMessage: message.slice(m[0].length) }
}


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
