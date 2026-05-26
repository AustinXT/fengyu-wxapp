/**
 * HMAC HTTP 桥 invoker
 *
 * 直接 require clientApi/index.js → 构造 {httpMethod, headers, body} 形态 event
 * → 调 exports.main(event, {})，模拟 CloudBase HTTP 触发器接到 staffApi 跨 env 请求。
 *
 * 守卫链由 fengyu-client/cloudfunctions/clientApi/index.js handleHttpEntry 实现：
 *   1. event.httpMethod === 'POST'
 *   2. headers.x-fengyu-signature = HMAC-SHA256(rawBody, CLIENT_SECRET) timingSafeEqual
 *   3. body.timestamp 在 ±5min 内
 *   4. body.action 在 HTTP_ACTION_ALLOWLIST 内
 *
 * 任一校验失败返回 statusCode=200 + JSON.stringify({code:-XXX, errorType, message})。
 */
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from '../setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WX_MOCK_PATH = path.join(
  REPO_ROOT, 'fengyu-client', 'tests', 'e2e-cloudfn', 'helpers', 'wx-server-sdk-mock.js'
)

function installWxServerSdkMock() {
  if (Module.__wxMockInstalled) return
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function patched(request, parent, ...rest) {
    if (request === 'wx-server-sdk') return WX_MOCK_PATH
    return origResolve.call(this, request, parent, ...rest)
  }
  Module.__wxMockInstalled = true
}

installWxServerSdkMock()

const CLIENT_API_DIR = path.join(REPO_ROOT, 'fengyu-client', 'cloudfunctions', 'clientApi')

let _clientMain = null
function loadClientApi() {
  if (!_clientMain) {
    const r = createRequire(path.join(CLIENT_API_DIR, 'package.json'))
    _clientMain = r(path.join(CLIENT_API_DIR, 'index.js')).main
  }
  return _clientMain
}

/**
 * 调 clientApi HTTP 触发器入口（HMAC + allowlist）
 *
 * @param {object} opts
 * @param {string} opts.action - body.action（被 allowlist 校验）
 * @param {object} opts.payload - body.payload
 * @param {string?} opts.secret - 用此密钥算签名；默认 process.env.CLIENT_SECRET
 * @param {number?} opts.timestamp - body.timestamp，默认 Date.now()
 * @param {boolean?} opts.badSig - true 时签名长度与正确签名相同但内容篡改，验证 timingSafeEqual
 * @param {boolean?} opts.omitSig - true 时不发 x-fengyu-signature 头
 * @param {boolean?} opts.rawBodyOverride - 字符串则直接当 body 发送（绕过 JSON.stringify），如发 '{not json' 验证 JSON parse 失败分支
 * @param {string?} opts.method - httpMethod，默认 'POST'
 *
 * @returns {Promise<{statusCode, body, raw}>} body 为 JSON 解析后对象（解析失败时 = null，raw 为原始字符串）
 */
export async function callHttpBridge(opts = {}) {
  const main = loadClientApi()
  const {
    action,
    payload = {},
    secret = process.env.CLIENT_SECRET,
    timestamp = Date.now(),
    badSig = false,
    omitSig = false,
    rawBodyOverride = null,
    method = 'POST',
  } = opts

  const bodyStr = rawBodyOverride !== null
    ? rawBodyOverride
    : JSON.stringify({ action, payload, timestamp })

  const headers = {}
  if (!omitSig) {
    const correctSig = crypto.createHmac('sha256', secret || '')
      .update(bodyStr)
      .digest('hex')
    if (badSig) {
      // 长度一致但内容篡改 — 验证 timingSafeEqual 而非 .length 短路
      const flipped = correctSig.replace(/[0-9a-f]/, (c) => c === 'a' ? 'b' : 'a')
      // flipped 应与原长一致；如果失败兜底补尾
      headers['x-fengyu-signature'] = flipped.length === correctSig.length
        ? flipped
        : correctSig.slice(0, -1) + (correctSig.slice(-1) === '0' ? '1' : '0')
    } else {
      headers['x-fengyu-signature'] = correctSig
    }
  }

  const event = {
    httpMethod: method,
    headers,
    body: bodyStr,
  }

  const res = await main(event, {})
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (_e) { /* leave null */ }
  return { statusCode: res.statusCode, body: parsed, raw: res.body }
}
