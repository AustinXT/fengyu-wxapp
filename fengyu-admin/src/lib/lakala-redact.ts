/**
 * 拉卡拉商户入网 · 通用脱敏（plan §0★ + §1.3）
 *
 * 所有写入 `lakala_merchant_logs.req_body / resp_body` 前 **必须** 调 redact()。
 * 同样适用于：操作日志 detail jsonb、回调 inbound payload 持久化、UI 渲染前置脱敏。
 *
 * 设计原则：
 *   1. PII 字段（idCard / bankCard / phone / 等 11 项）按内容长度 mask 中间几位
 *   2. 费率字段（feeRate / rateCode / 等 10 项）**直接替换为 '***' 字符串**
 *      —— 任何 admin 角色（含 super-admin）都无法从日志反查费率，杜绝意外暴露
 *   3. 嵌套对象/数组递归处理；继承父键上下文（changes.idCard.{from,to} 也被识别）
 *   4. 非字符串值（数字、布尔、null）按 key 命中后也直接 '***'（费率有时是数字 0.6）
 *
 * 与 fengyu-admin/src/lib/pii.ts 的区别：
 *   - pii.ts 服务全站审计日志，键集合更小（不含费率）；
 *   - lakala-redact.ts 专为拉卡拉接口流量定制，键集合是 pii.ts 的超集 + 费率，
 *     并对费率走"覆盖式"脱敏（不留任何提示）。
 */

/** PII 敏感字段名（plan §0★ 必须包含项） */
const PII_FIELDS: ReadonlySet<string> = new Set([
  'idCard',
  'id_card',
  'idNumber',
  'idNo',
  'legalCertNo',
  'legalIdNo',
  'larIdcard',
  'acctIdcard',
  'certNo',
  'cert_no',
  'bankCard',
  'bankCardNo',
  'accountNo',
  'settleAcctNo',
  'acctNo',
  'phone',
  'mobile',
  'tel',
  'contactMobile',
  'larMobile',
  'merContactMobile',
  'shopContactMobile',
])

/** 费率敏感字段名（plan §0★ 必须包含项；命中直接 '***'） */
const RATE_FIELDS: ReadonlySet<string> = new Set([
  'feeRate',
  'rateCode',
  'rateType',
  'feeData',
  'rate',
  'serviceFee',
  'merFeeRate',
  'singleFeeRate',
  'cardFeeRate',
  'costFeeRate',
  'feeRatePct',
  'feeRateTypeCode',
  'feeRateTypeName',
  'feeUpperAmtPcnt',
  'feeLowerAmtPcnt',
  'limitTypeCode',
])

const RATE_MASK = '***' as const

function isPiiKey(key: string): boolean {
  return PII_FIELDS.has(key)
}

function isRateKey(key: string): boolean {
  return RATE_FIELDS.has(key)
}

/**
 * 手机号脱敏。
 * 11 位标准 → 前 3 + **** + 后 4（138****1234）
 * 其它长度按"前 3 后 4 中间补 *"兜底，<8 位整段 *
 */
export function maskPhone(value: string): string {
  if (!value || typeof value !== 'string') return ''
  const s = value.trim()
  if (s.length === 0) return ''
  if (s.length < 8) return '*'.repeat(s.length)
  return s.slice(0, 3) + '*'.repeat(Math.max(4, s.length - 7)) + s.slice(-4)
}

/**
 * 身份证脱敏。
 * 18 位标准 → 前 6 + ******** + 后 4（110101********1234）
 */
export function maskIdCard(value: string): string {
  if (!value || typeof value !== 'string') return ''
  const s = value.trim()
  if (s.length === 0) return ''
  if (s.length < 10) return '*'.repeat(s.length)
  return s.slice(0, 6) + '*'.repeat(s.length - 10) + s.slice(-4)
}

/**
 * 银行卡脱敏。
 * 16–19 位 → 前 4 + **** + 后 4（6225****1234）
 */
export function maskBankCard(value: string): string {
  if (!value || typeof value !== 'string') return ''
  const s = value.trim()
  if (s.length === 0) return ''
  if (s.length < 8) return '*'.repeat(s.length)
  return s.slice(0, 4) + '*'.repeat(Math.max(4, s.length - 8)) + s.slice(-4)
}

/**
 * 单条字符串按 PII 字段类型脱敏。
 *
 * - 手机号类（phone/mobile/...）→ maskPhone
 * - 身份证类（idCard/legalCertNo/...）→ maskIdCard
 * - 银行卡 / 结算账户类（bankCard/acctNo/...）→ maskBankCard
 */
function maskPiiByKey(key: string, value: string): string {
  if (
    key === 'phone' ||
    key === 'mobile' ||
    key === 'tel' ||
    key === 'contactMobile' ||
    key === 'larMobile' ||
    key === 'merContactMobile' ||
    key === 'shopContactMobile'
  ) {
    return maskPhone(value)
  }
  if (
    key === 'idCard' ||
    key === 'id_card' ||
    key === 'idNumber' ||
    key === 'idNo' ||
    key === 'legalCertNo' ||
    key === 'legalIdNo' ||
    key === 'larIdcard' ||
    key === 'acctIdcard' ||
    key === 'certNo' ||
    key === 'cert_no'
  ) {
    return maskIdCard(value)
  }
  if (
    key === 'bankCard' ||
    key === 'bankCardNo' ||
    key === 'accountNo' ||
    key === 'settleAcctNo' ||
    key === 'acctNo'
  ) {
    return maskBankCard(value)
  }
  return value
}

/**
 * 通用脱敏入口。
 *
 * 对 input 做深拷贝并按字段名脱敏：
 *   - PII 字段：按内容类型 mask 中间几位（保留前后供运维肉眼识别）
 *   - 费率字段：直接替换为 '***'（无类型化提示）
 *   - 其它字段：保留原值
 *
 * 关键设计：嵌套对象内继承父 key 上下文，让 changes.feeRate.{from,to} 这类 diff 子对象也被 mask。
 *
 * 用法：
 *   redact(reqBody)  → 写 lakala_merchant_logs.req_body
 *   redact(respBody) → 写 lakala_merchant_logs.resp_body
 */
export function redact(input: unknown): unknown {
  return redactInternal(input, undefined)
}

function redactInternal(input: unknown, inheritedKey: string | undefined): unknown {
  if (input === null || input === undefined) return input

  if (typeof input === 'string') {
    if (inheritedKey && isRateKey(inheritedKey)) return RATE_MASK
    if (inheritedKey && isPiiKey(inheritedKey)) return maskPiiByKey(inheritedKey, input)
    return input
  }

  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
    if (inheritedKey && isRateKey(inheritedKey)) return RATE_MASK
    return input
  }

  if (Array.isArray(input)) {
    // 数组内继承父 key（如 feeData: [{ feeRate: 0.6 }] — feeData 命中 RATE → 整 array → 每项 → '***'）
    if (inheritedKey && isRateKey(inheritedKey)) return RATE_MASK
    return input.map((v) => redactInternal(v, inheritedKey))
  }

  if (typeof input === 'object') {
    if (inheritedKey && isRateKey(inheritedKey)) return RATE_MASK
    const src = input as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src)) {
      const v = src[k]
      const ctxKey = isRateKey(k) || isPiiKey(k) ? k : inheritedKey
      if (isRateKey(k)) {
        out[k] = RATE_MASK
      } else if (typeof v === 'string') {
        out[k] = ctxKey ? maskPiiByKey(ctxKey, v) : v
      } else if (v && typeof v === 'object') {
        out[k] = redactInternal(v, ctxKey)
      } else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
        out[k] = ctxKey && isRateKey(ctxKey) ? RATE_MASK : v
      } else {
        out[k] = v
      }
    }
    return out
  }

  return input
}

/**
 * 给测试 / 静态扫描守护用的常量导出。
 * 见 plan §0★ 测试守护 lakala-no-rate-leak.test.ts。
 */
export const REDACT_PII_FIELDS: ReadonlySet<string> = PII_FIELDS
export const REDACT_RATE_FIELDS: ReadonlySet<string> = RATE_FIELDS
export const REDACT_RATE_MASK = RATE_MASK
