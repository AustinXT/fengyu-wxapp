

'use strict'

const crypto = require('crypto')

const ALGORITHM_LABEL = 'LKLAPI-SHA256withRSA'


function randomNonce(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  const buf = crypto.randomBytes(length)
  for (let i = 0; i < length; i++) {
    out += chars[buf[i] % chars.length]
  }
  return out
}


function buildSignTarget5({ appid, serialNo, timestamp, nonceStr, body }) {
  return `${appid}\n${serialNo}\n${timestamp}\n${nonceStr}\n${body}\n`
}


function buildSignTarget3({ timestamp, nonceStr, body }) {
  return `${timestamp}\n${nonceStr}\n${body}\n`
}


function rsaSign(target, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(target, 'utf8')
  signer.end()
  return signer.sign(privateKeyPem, 'base64')
}


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


function parseAuthorizationHeader(authorizationHeader) {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') return null
  const trimmed = authorizationHeader.trim()
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) return null
  const algorithm = trimmed.slice(0, spaceIdx)
  if (algorithm !== ALGORITHM_LABEL) return null
  const rest = trimmed.slice(spaceIdx + 1)
  const out = { algorithm }
  
  
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
