/**
 * 拉卡拉「安全统一接入规范」加签 / 验签实现
 *
 * 算法：SHA256withRSA（RSA-2048），签名 Base64 单行编码
 *
 * 三种签名格式（务必区分）：
 *
 *   1. 请求加签（同步调拉卡拉接口） — 5 行
 *      待签内容：${appid}\n${serial_no}\n${timestamp}\n${nonce_str}\n${body}\n
 *      header：Authorization: LKLAPI-SHA256withRSA appid="...",serial_no="...",timestamp="...",nonce_str="...",signature="..."
 *
 *   2. 同步响应验签（拉卡拉响应的 Header） — 5 行（同请求格式）
 *      待签内容：${Lklapi-Appid}\n${Lklapi-Serial}\n${Lklapi-Timestamp}\n${Lklapi-Nonce}\n${body}\n
 *      header 字段：Lklapi-Appid / Lklapi-Serial / Lklapi-Timestamp / Lklapi-Nonce / Lklapi-Signature / Lklapi-Traceid
 *
 *   3. 异步通知验签（payNotify 收到的回调） — 3 行（与请求加签不同！）
 *      待签内容：${timestamp}\n${nonce_str}\n${body}\n
 *      header 格式：Authorization: LKLAPI-SHA256withRSA timestamp="...",nonce_str="...",signature="..."
 *      关键约束：body 必须用 HTTP 请求体原始字节，不能 JSON.parse 后再 stringify
 *
 * 每行末尾的 \n 必须保留（包括最后一行），拉卡拉文档明确丢失该换行符是 90% 验签错误来源。
 *
 * 与 fengyu-client/cloudfunctions/payNotify/utils/lakala-sign.js
 *    fengyu-staff/cloudfunctions/staffApi/utils/lakala-sign.js
 *    fengyu-admin/src/lib/lakala-sign.ts
 * 四份独立副本，跨端一致性靠 snapshot 测试守护。
 */

'use strict'

const crypto = require('crypto')

const ALGORITHM_LABEL = 'LKLAPI-SHA256withRSA'

/**
 * 生成 nonce 字符串（默认 12 字符，A-Za-z0-9）
 */
function randomNonce(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  const buf = crypto.randomBytes(length)
  for (let i = 0; i < length; i++) {
    out += chars[buf[i] % chars.length]
  }
  return out
}

/**
 * 拼接 5 行待签字符串（请求加签 / 同步响应验签共用）
 */
function buildSignTarget5({ appid, serialNo, timestamp, nonceStr, body }) {
  return `${appid}\n${serialNo}\n${timestamp}\n${nonceStr}\n${body}\n`
}

/**
 * 拼接 3 行待签字符串（异步通知验签专用）
 */
function buildSignTarget3({ timestamp, nonceStr, body }) {
  return `${timestamp}\n${nonceStr}\n${body}\n`
}

/**
 * 用 RSA 私钥 PEM 对待签字符串 SHA256withRSA 签名，返回 Base64 单行。
 */
function rsaSign(target, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(target, 'utf8')
  signer.end()
  return signer.sign(privateKeyPem, 'base64')
}

/**
 * 用 RSA 公钥证书 PEM 验签。返回 boolean。
 */
function rsaVerify(target, signatureB64, publicCertPem) {
  try {
    const verifier = crypto.createVerify('RSA-SHA256')
    verifier.update(target, 'utf8')
    verifier.end()
    return verifier.verify(publicCertPem, signatureB64, 'base64')
  } catch (err) {
    return false
  }
}

/**
 * 生成请求加签 Header 值（Authorization 字段值）
 *
 * @param {object} opts
 * @param {string} opts.appid           接入方 appid
 * @param {string} opts.serialNo        接入方加签证书序列号
 * @param {string} opts.privateKeyPem   接入方私钥 PEM
 * @param {string} opts.body            完整请求体字符串（先 JSON.stringify 后再签）
 * @param {string} [opts.timestamp]     秒级 unix（默认现在）
 * @param {string} [opts.nonceStr]      12 字符随机（默认随机生成）
 * @returns {{authorization: string, timestamp: string, nonceStr: string, signature: string}}
 */
function buildRequestAuthorization({ appid, serialNo, privateKeyPem, body, timestamp, nonceStr }) {
  if (!appid || !serialNo || !privateKeyPem) {
    throw new Error('INVALID_PARAMS: LAKALA_SIGN_MISSING_KEYS')
  }
  if (typeof body !== 'string') {
    throw new Error('INVALID_PARAMS: LAKALA_SIGN_BODY_MUST_BE_STRING')
  }
  const ts = timestamp || String(Math.floor(Date.now() / 1000))
  const nonce = nonceStr || randomNonce(12)
  const target = buildSignTarget5({ appid, serialNo, timestamp: ts, nonceStr: nonce, body })
  const signature = rsaSign(target, privateKeyPem)
  const authorization =
    `${ALGORITHM_LABEL} appid="${appid}",serial_no="${serialNo}",timestamp="${ts}",nonce_str="${nonce}",signature="${signature}"`
  return { authorization, timestamp: ts, nonceStr: nonce, signature }
}

/**
 * 验证拉卡拉同步响应（5 行格式）。从响应 Headers 取 Lklapi-* 字段。
 *
 * @param {object} opts
 * @param {object} opts.headers          响应 Headers（key 不区分大小写）
 * @param {string} opts.body             响应 body 字符串
 * @param {string} opts.platformCertPem  拉卡拉平台公钥证书 PEM
 * @returns {boolean}
 */
function verifyResponseSignature({ headers, body, platformCertPem }) {
  if (!platformCertPem) return false
  const h = lowerCaseHeaders(headers)
  const appid = h['lklapi-appid'] || ''
  const serialNo = h['lklapi-serial'] || ''
  const timestamp = h['lklapi-timestamp'] || ''
  const nonceStr = h['lklapi-nonce'] || ''
  const signature = h['lklapi-signature'] || ''
  if (!signature || !timestamp || !nonceStr) return false
  const target = buildSignTarget5({ appid, serialNo, timestamp, nonceStr, body })
  return rsaVerify(target, signature, platformCertPem)
}

/**
 * 验证拉卡拉异步通知（3 行格式）。从回调 Authorization Header 解析。
 *
 * @param {object} opts
 * @param {string} opts.authorizationHeader  回调 Authorization Header 值（LKLAPI-SHA256withRSA timestamp="...",nonce_str="...",signature="..."）
 * @param {string} opts.rawBody              HTTP 请求体原始字符串（绝对不能 JSON.parse 后再 stringify）
 * @param {string} opts.platformCertPem      拉卡拉平台公钥证书 PEM
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyAsyncNotification({ authorizationHeader, rawBody, platformCertPem }) {
  if (!platformCertPem) return { ok: false, reason: 'NO_PLATFORM_CERT' }
  if (!authorizationHeader) return { ok: false, reason: 'NO_AUTHORIZATION_HEADER' }
  if (typeof rawBody !== 'string') return { ok: false, reason: 'BODY_NOT_STRING' }

  const parsed = parseAuthorizationHeader(authorizationHeader)
  if (!parsed) return { ok: false, reason: 'BAD_AUTHORIZATION_FORMAT' }
  const { timestamp, nonceStr, signature } = parsed
  if (!timestamp || !nonceStr || !signature) {
    return { ok: false, reason: 'MISSING_SIGN_FIELDS' }
  }
  const target = buildSignTarget3({ timestamp, nonceStr, body: rawBody })
  const ok = rsaVerify(target, signature, platformCertPem)
  return ok ? { ok: true } : { ok: false, reason: 'SIGNATURE_MISMATCH' }
}

/**
 * 解析 Authorization Header 值。
 * 同步请求格式（5 字段）：LKLAPI-SHA256withRSA appid="...",serial_no="...",timestamp="...",nonce_str="...",signature="..."
 * 异步通知格式（3 字段）：LKLAPI-SHA256withRSA timestamp="...",nonce_str="...",signature="..."
 */
function parseAuthorizationHeader(authorizationHeader) {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') return null
  const trimmed = authorizationHeader.trim()
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) return null
  const algorithm = trimmed.slice(0, spaceIdx)
  if (algorithm !== ALGORITHM_LABEL) return null
  const rest = trimmed.slice(spaceIdx + 1)
  const out = { algorithm }
  // 按逗号拆，每段 key="value" 形式
  // value 内不含逗号或引号（拉卡拉签名是 Base64，不会含这些字符；timestamp/nonce 也安全）
  const segments = rest.split(',')
  for (const seg of segments) {
    const m = seg.trim().match(/^([A-Za-z_]+)="(.*)"$/)
    if (!m) continue
    const key = m[1]
    const value = m[2]
    if (key === 'appid') out.appid = value
    else if (key === 'serial_no') out.serialNo = value
    else if (key === 'timestamp') out.timestamp = value
    else if (key === 'nonce_str') out.nonceStr = value
    else if (key === 'signature') out.signature = value
  }
  return out
}

/**
 * Headers key 统一转小写（HTTP Header 大小写不敏感）
 */
function lowerCaseHeaders(headers) {
  const out = {}
  if (!headers) return out
  for (const k of Object.keys(headers)) {
    out[k.toLowerCase()] = headers[k]
  }
  return out
}

module.exports = {
  ALGORITHM_LABEL,
  randomNonce,
  buildSignTarget5,
  buildSignTarget3,
  rsaSign,
  rsaVerify,
  buildRequestAuthorization,
  verifyResponseSignature,
  verifyAsyncNotification,
  parseAuthorizationHeader,
  lowerCaseHeaders,
}
