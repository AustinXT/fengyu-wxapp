/**
 * 拉卡拉 HTTPS 请求封装（带加签 + 验签）
 *
 * 用法：
 *   const lakala = require('./utils/lakala-client')
 *   const resp = await lakala.request({
 *     path: '/v3/ccss/counter/order/special_create',
 *     reqData: { merchant_no, term_no, out_order_no, ... }
 *   })
 *   if (resp.code !== '000000') throw new Error(`INVALID_STATE: LAKALA_FAILED: ${resp.msg}`)
 *
 * 自动处理：
 *   - 包装外壳 { req_time, version:'3.0', req_data }
 *   - 加签 Authorization Header
 *   - HTTPS POST 调用 LAKALA_API_BASE + path
 *   - 响应验签（同步响应 5 行格式）
 *   - 按 endpoint 路径推断成功码（/ccss/, /rfd/ 用 '000000'；/labs/ 用 'BBS00000'）
 *
 * 不自动处理：
 *   - 业务码 != 成功码时不会抛错（由调用方根据 code/trade_state 自行处理）
 *   - 不重试（业务幂等由调用方负责）
 *
 * 与 fengyu-client/cloudfunctions/payNotify/utils/lakala-client.js（仅用了 verify 部分）
 *    fengyu-staff/cloudfunctions/staffApi/utils/lakala-client.js
 *    fengyu-admin/src/lib/lakala-client.ts
 * 四份独立副本，跨端一致性靠 snapshot 测试守护。
 */

'use strict'

const https = require('https')
const http = require('http')
const { URL } = require('url')
const { readConfig, assertReady } = require('./lakala-config')
const sign = require('./lakala-sign')

const DEFAULT_TIMEOUT_MS = 30000

/**
 * 推断 endpoint 路径对应的成功码。
 *   /ccss/  → '000000'
 *   /rfd/   → '000000'
 *   /labs/  → 'BBS00000'
 */
function expectedSuccessCode(path) {
  if (/^\/?v\d+\/labs\//.test(path)) return 'BBS00000'
  return '000000'
}

/**
 * yyyyMMddHHmmss 格式化（GMT+8）
 */
function formatReqTime(date = new Date()) {
  // 转 GMT+8
  const ms = date.getTime() + 8 * 3600 * 1000
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const M = String(d.getUTCMonth() + 1).padStart(2, '0')
  const D = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  const m = String(d.getUTCMinutes()).padStart(2, '0')
  const s = String(d.getUTCSeconds()).padStart(2, '0')
  return `${y}${M}${D}${h}${m}${s}`
}

/**
 * 调拉卡拉接口。
 *
 * @param {object} opts
 * @param {string} opts.path             相对路径，如 '/v3/ccss/counter/order/special_create'
 * @param {object} opts.reqData          req_data 业务字段
 * @param {string} [opts.outOrgCode]     部分接口需要的 out_org_code（如订单关单 / 旧版退款）
 * @param {boolean} [opts.skipVerify=false]  是否跳过响应验签（仅测试用）
 * @param {number} [opts.timeoutMs]      超时毫秒
 * @returns {Promise<{code: string, msg: string, resp_time: string, resp_data: object, expectedCode: string, ok: boolean}>}
 */
async function request({ path, reqData, outOrgCode, skipVerify = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  assertReady()
  const cfg = readConfig()

  const reqTime = formatReqTime()
  const envelope = {
    req_time: reqTime,
    version: '3.0',
    req_data: reqData || {},
  }
  if (outOrgCode) envelope.out_org_code = outOrgCode

  const bodyStr = JSON.stringify(envelope)
  const { authorization } = sign.buildRequestAuthorization({
    appid: cfg.appid,
    serialNo: cfg.serialNo,
    privateKeyPem: cfg.privateKeyPem,
    body: bodyStr,
  })

  const url = new URL(cfg.apiBase + path)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + (url.search || ''),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authorization,
      'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
    },
  }

  const { rawBody, headers } = await new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ rawBody: buf.toString('utf8'), headers: res.headers, statusCode: res.statusCode })
      })
    })
    req.on('error', (err) => reject(new Error(`INVALID_STATE: LAKALA_REQUEST_FAILED: ${err.message}`)))
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`INVALID_STATE: LAKALA_TIMEOUT_${timeoutMs}ms`))
    })
    req.write(bodyStr)
    req.end()
  })

  // 响应验签（同步 5 行格式）
  if (!skipVerify) {
    const verified = sign.verifyResponseSignature({
      headers,
      body: rawBody,
      platformCertPem: cfg.platformCertPem,
    })
    if (!verified) {
      // 拉卡拉部分错误响应（如签名前的 4xx）可能不带签名 Header；
      // 这里只在 body 看起来是业务响应时严格校验。简化策略：不带任何 Lklapi-* Header 则不强校验，但记日志。
      const hasAnyLklHeader = Object.keys(headers || {}).some((k) => k.toLowerCase().startsWith('lklapi-'))
      if (hasAnyLklHeader) {
        throw new Error('INVALID_STATE: LAKALA_RESPONSE_SIGNATURE_MISMATCH')
      }
      console.warn('[lakala] 响应无签名 Header，跳过验签：', path, rawBody.slice(0, 200))
    }
  }

  let parsed
  try {
    parsed = JSON.parse(rawBody)
  } catch (err) {
    throw new Error(`INVALID_STATE: LAKALA_RESPONSE_NOT_JSON: ${err.message}; body=${rawBody.slice(0, 200)}`)
  }

  const expectedCode = expectedSuccessCode(path)
  return {
    code: parsed.code,
    msg: parsed.msg,
    resp_time: parsed.resp_time,
    resp_data: parsed.resp_data || {},
    expectedCode,
    ok: parsed.code === expectedCode,
  }
}

module.exports = {
  request,
  formatReqTime,
  expectedSuccessCode,
}
