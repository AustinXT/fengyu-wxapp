/**
 * 本地 https 模块短路（仅拦截 clientApi HTTP 触发器 host）
 *
 * 实施目的：staffApi 的 staff.uploadAvatar 用 require('https').request 调
 * clientApi HTTP 触发器；测试环境不能真发出 HTTPS 请求，需在 process 内拦截。
 *
 * 行为：
 *   - hostname 为 invoke.mjs 注入的 MOCK_CLIENT_API_HOSTNAME → 走 mock
 *   - 其他 hostname（如 api.weixin.qq.com，wxacode.js 用）→ 透传给真 https
 *
 * Mock 同时校验入站 HMAC（确保 staffApi 真的签了），不匹配返回 401。
 * 模拟的 fileID/avatarUrl 嵌入 client envId 字符串，便于 spec 断言"真的走到了 client env"。
 */
const crypto = require('crypto')

const CLIENT_ENV_ID = 'cloud1-3gpht4b01ff88838'
const CDN_BASE = `https://636c-${CLIENT_ENV_ID}-1406056527.tcb.qcloud.la`

// 由 invoke.mjs 在 install 时填入；spec/setup 也可改
let MOCK_HOSTNAME = null
let MOCK_CLIENT_SECRET = null
let realHttps = null

function setMockConfig({ hostname, clientSecret, real }) {
  MOCK_HOSTNAME = hostname
  MOCK_CLIENT_SECRET = clientSecret
  realHttps = real
}

/**
 * 模拟一次 clientApi HTTP 触发器响应
 * @param {string} bodyText - 请求体（JSON 字符串）
 * @param {object} headers - 请求头（含 x-fengyu-signature）
 * @returns {{statusCode:number, body:string}}
 */
function simulateClientApiResponse(bodyText, headers) {
  const sig = headers['x-fengyu-signature'] || headers['X-Fengyu-Signature']
  if (!sig) {
    return jsonResp(200, { code: -401, errorType: 'UNAUTHORIZED', message: 'UNAUTHORIZED: 缺少签名头' })
  }
  if (!MOCK_CLIENT_SECRET) {
    return jsonResp(200, { code: -1, message: 'mock: MOCK_CLIENT_SECRET 未配置' })
  }
  const expected = crypto.createHmac('sha256', MOCK_CLIENT_SECRET).update(bodyText).digest('hex')
  const sigBuf = Buffer.from(String(sig))
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return jsonResp(200, { code: -401, errorType: 'UNAUTHORIZED', message: 'UNAUTHORIZED: 签名不匹配' })
  }

  let parsed
  try { parsed = JSON.parse(bodyText) } catch (_) {
    return jsonResp(200, { code: -400, errorType: 'INVALID_PARAMS', message: 'INVALID_PARAMS: JSON 解析失败' })
  }
  const { action, payload, timestamp } = parsed
  if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) {
    return jsonResp(200, { code: -401, errorType: 'UNAUTHORIZED', message: 'UNAUTHORIZED: 时间戳过期或缺失' })
  }
  if (action !== 'auth.uploadStaffAvatar') {
    return jsonResp(200, { code: -403, errorType: 'PERMISSION_DENIED', message: 'PERMISSION_DENIED: 该 action 不暴露 HTTP 入口' })
  }

  // 复刻 client 端 uploadStaffAvatar 的参数校验（让测试无需真上传）
  const { base64, ext, employeeId } = payload || {}
  if (!base64) {
    return jsonResp(200, { code: -400, errorType: 'INVALID_PARAMS', message: 'INVALID_PARAMS: 缺少 base64 参数' })
  }
  if (!employeeId) {
    return jsonResp(200, { code: -400, errorType: 'INVALID_PARAMS', message: 'INVALID_PARAMS: 缺少 employeeId' })
  }
  const normalizedExt = String(ext || 'jpg').toLowerCase()
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(normalizedExt)) {
    return jsonResp(200, { code: -400, errorType: 'INVALID_PARAMS', message: 'INVALID_PARAMS: 不支持的图片格式' })
  }
  const buf = Buffer.from(base64, 'base64')
  if (buf.length === 0) {
    return jsonResp(200, { code: -400, errorType: 'INVALID_PARAMS', message: 'INVALID_PARAMS: 头像数据解析失败' })
  }
  if (buf.length > 2 * 1024 * 1024) {
    return jsonResp(200, { code: -400, errorType: 'INVALID_PARAMS', message: 'INVALID_PARAMS: 图片大小超过 2MB' })
  }

  const rand = Math.random().toString(36).slice(2, 8)
  const cloudPath = `avatars/staff/${employeeId}/${Date.now()}_${rand}.${normalizedExt}`
  const fileID = `cloud://${CLIENT_ENV_ID}.bucket/${cloudPath}`
  const avatarUrl = `${CDN_BASE}/${cloudPath}`
  return jsonResp(200, { code: 0, message: 'success', data: { fileID, avatarUrl } })
}

function jsonResp(statusCode, obj) {
  return { statusCode, body: JSON.stringify(obj) }
}

/**
 * 模拟 http.IncomingMessage 行为：emit data/end 给消费者
 */
function fakeIncomingMessage(statusCode, bodyText) {
  const { Readable } = require('stream')
  const r = new Readable({ read() {} })
  r.statusCode = statusCode
  r.headers = { 'content-type': 'application/json' }
  process.nextTick(() => {
    r.push(bodyText)
    r.push(null)
  })
  return r
}

/**
 * 模拟 http.ClientRequest：暂存 write 的 body，end() 触发 callback 拿模拟 response
 */
function fakeClientRequest(reqOptions, callback) {
  const { EventEmitter } = require('events')
  const req = new EventEmitter()
  const chunks = []
  req.write = (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  req.end = (lastChunk) => {
    if (lastChunk) chunks.push(typeof lastChunk === 'string' ? Buffer.from(lastChunk) : lastChunk)
    const bodyText = Buffer.concat(chunks).toString('utf-8')
    const { statusCode, body } = simulateClientApiResponse(bodyText, reqOptions.headers || {})
    const res = fakeIncomingMessage(statusCode, body)
    process.nextTick(() => callback(res))
  }
  return req
}

/**
 * 选择性短路：只拦截 hostname 命中 MOCK_HOSTNAME 的请求
 */
function patchedRequest(options, callback) {
  // options 可能是 string url、URL 对象或 RequestOptions
  let hostname = null
  let reqOptions = options
  if (typeof options === 'string') {
    const u = new URL(options)
    hostname = u.hostname
    reqOptions = { hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: {} }
  } else if (options instanceof URL) {
    hostname = options.hostname
    reqOptions = { hostname, port: options.port, path: options.pathname + options.search, method: 'GET', headers: {} }
  } else {
    hostname = options.hostname || options.host
  }

  if (MOCK_HOSTNAME && hostname === MOCK_HOSTNAME) {
    return fakeClientRequest(reqOptions, callback)
  }
  // 透传给真 https
  return realHttps.request(options, callback)
}

module.exports = {
  setMockConfig,
  patchedRequest,
  // 暴露常量给 spec 断言
  CLIENT_ENV_ID,
  CDN_BASE,
}
