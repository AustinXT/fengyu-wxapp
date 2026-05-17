/**
 * PII 脱敏 helper（三端字面一致 — 由 cross-end-pii-snapshot.test.js 守护）
 *
 * 函数：
 *   maskPhone(phone)        — 手机号脱敏（11 位 → 138****5678）
 *   maskName(name)          — 姓名脱敏（默认 SENSITIVE_KEYS 不含 name，调用方按需调用）
 *   maskIdCard(id)          — 身份证脱敏（前 4 后 4 + 中间 *）
 *   maskEmail(email)        — 邮箱脱敏（local 首末保留）
 *   maskOpenid(openid)      — openid 脱敏（前 4 + 末 4）
 *   sanitizeDetail(input)   — 递归对象按 SENSITIVE_KEYS 脱敏（仅 PII 键）
 *   SENSITIVE_KEYS          — 默认敏感键集合
 */

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return ''
  const s = phone.trim()
  if (s.length === 0) return ''
  if (s.length <= 4) return '*'.repeat(s.length)
  if (s.length <= 7) return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1]
  return s.slice(0, 3) + '*'.repeat(Math.max(4, s.length - 7)) + s.slice(-4)
}

function maskName(name) {
  if (!name || typeof name !== 'string') return ''
  const s = name.trim()
  if (s.length === 0) return ''
  if (s.length === 1) return '*'
  if (s.length === 2) return s[0] + '*'
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1]
}

function maskIdCard(id) {
  if (!id || typeof id !== 'string') return ''
  const s = id.trim()
  if (s.length === 0) return ''
  if (s.length < 8) return '*'.repeat(s.length)
  return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4)
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return ''
  const s = email.trim()
  if (s.length === 0) return ''
  const at = s.indexOf('@')
  if (at < 0) return maskName(s)
  const local = s.slice(0, at)
  const domain = s.slice(at)
  if (local.length === 0) return s
  if (local.length === 1) return local + domain
  if (local.length === 2) return local[0] + '*' + domain
  return local[0] + '*'.repeat(local.length - 2) + local[local.length - 1] + domain
}

function maskOpenid(openid) {
  if (!openid || typeof openid !== 'string') return ''
  const s = openid.trim()
  if (s.length === 0) return ''
  if (s.length <= 8) return '*'.repeat(s.length)
  return s.slice(0, 4) + '*'.repeat(Math.max(4, s.length - 8)) + s.slice(-4)
}

const SENSITIVE_KEYS = new Set([
  'phone', 'mobile', 'tel',
  'idCard', 'id_card', 'idNumber',
  'email',
  'openid', 'open_id',
])

function maskByKey(key, value) {
  if (key === 'phone' || key === 'mobile' || key === 'tel') return maskPhone(value)
  if (key === 'idCard' || key === 'id_card' || key === 'idNumber') return maskIdCard(value)
  if (key === 'email') return maskEmail(value)
  if (key === 'openid' || key === 'open_id') return maskOpenid(value)
  return value
}

/**
 * 递归脱敏对象。
 * 关键设计：进入 SENSITIVE_KEY 后向下"继承"当前 key 类型，使 changes.phone.{from,to} 这类
 * "diff 子对象内字符串"也按 phone 规则脱敏（详见 ticket §6.5 验证清单）。
 */
function sanitizeDetail(input, inheritedKey) {
  if (input == null) return input
  if (typeof input === 'string') {
    return inheritedKey ? maskByKey(inheritedKey, input) : input
  }
  if (typeof input !== 'object') return input
  if (Array.isArray(input)) return input.map(function (v) { return sanitizeDetail(v, inheritedKey) })
  const out = {}
  for (const k of Object.keys(input)) {
    const v = input[k]
    const ctxKey = SENSITIVE_KEYS.has(k) ? k : inheritedKey
    if (typeof v === 'string') {
      out[k] = ctxKey ? maskByKey(ctxKey, v) : v
    } else if (v && typeof v === 'object') {
      out[k] = sanitizeDetail(v, ctxKey)
    } else {
      out[k] = v
    }
  }
  return out
}

module.exports = {
  maskPhone,
  maskName,
  maskIdCard,
  maskEmail,
  maskOpenid,
  sanitizeDetail,
  SENSITIVE_KEYS,
}
