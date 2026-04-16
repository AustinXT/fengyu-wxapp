/**
 * 脱敏工具（仅用于日志/审计）
 */

/**
 * 手机号脱敏：保留前 3 后 4，中间 4 位替换为 ****
 * - 11 位：138****5678
 * - 长度不足 7 位：原样返回
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return phone || ''
  if (phone.length < 7) return phone
  return phone.slice(0, 3) + '****' + phone.slice(-4)
}

module.exports = { maskPhone }
