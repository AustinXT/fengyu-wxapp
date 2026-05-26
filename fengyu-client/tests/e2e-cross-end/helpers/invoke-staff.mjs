/**
 * cross-end staffApi invoke wrapper
 *
 * 直接 require fengyu-staff/cloudfunctions/staffApi/index.js 并调用 main()。
 * 与 e2e-cloudfn/helpers/invoke.mjs 共享同一份 wx-server-sdk mock 安装（installWxServerSdkMock
 * 用 Module.__wxMockInstalled 标志位幂等），所以无论先 import client 还是 staff invoke，
 * mock 都只装一次。
 *
 * 用法：
 *   await invokeStaffAs(TEST_MANAGER_OPENID, 'order.create', { clientPhone, items, ... })
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from '../setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 借用 e2e-cloudfn 的 wx-server-sdk mock（OPENID 解析逻辑一致）
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

const STAFF_API_DIR = path.join(REPO_ROOT, 'fengyu-staff', 'cloudfunctions', 'staffApi')

let _staffMain = null
function loadStaffApi() {
  if (!_staffMain) {
    const r = createRequire(path.join(STAFF_API_DIR, 'package.json'))
    _staffMain = r(path.join(STAFF_API_DIR, 'index.js')).main
  }
  return _staffMain
}

/**
 * 调用 staffApi（最底层）
 */
export async function invokeStaffApi(action, payload = {}) {
  const main = loadStaffApi()
  return await main({ action, payload }, {})
}

/**
 * 以指定 openid 身份调 staffApi
 * 自动注入 _testOpenid（staffApi auth 中间件在 ALLOW_TEST_OPENID=true 时读取）
 */
export async function invokeStaffAs(openid, action, payload = {}) {
  if (!openid) throw new Error('invokeStaffAs: openid required')
  globalThis.__e2e_current_openid__ = openid
  try {
    return await invokeStaffApi(action, { _testOpenid: openid, ...payload })
  } finally {
    delete globalThis.__e2e_current_openid__
  }
}

// 与 client expectError/expectSuccess 同语义；staffApi 的 buildErrorResponse 同样产出 errorType 字段
export function expectError(res, errorType, opts = {}) {
  if (res.code === 0) {
    throw new Error(`expect error errorType=${errorType}, but got success: ${JSON.stringify(res.data)}`)
  }
  if (errorType && res.errorType !== errorType) {
    throw new Error(
      `expect errorType=${errorType}, got errorType=${res.errorType ?? 'null'} (code=${res.code}, message="${res.message}")`
    )
  }
  if (opts.messageIncludes && !String(res.message ?? '').includes(opts.messageIncludes)) {
    throw new Error(`expect message includes "${opts.messageIncludes}", got: "${res.message}"`)
  }
  if (opts.code !== undefined && res.code !== opts.code) {
    throw new Error(`expect code=${opts.code}, got ${res.code}`)
  }
}

export function expectSuccess(res) {
  if (res.code !== 0) {
    throw new Error(`expect success (code=0), got code=${res.code} errorType=${res.errorType} message="${res.message}"`)
  }
  return res.data
}
