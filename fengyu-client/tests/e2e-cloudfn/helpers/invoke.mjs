/**
 * 本地 require 云函数入口 + mock wx-server-sdk，然后构造 event 调用 main()。
 *
 * 设计要点：
 * - 通过 Node `Module._resolveFilename` patch 把 'wx-server-sdk' 短路到本地
 *   `wx-server-sdk-mock.js`，让云函数 require('wx-server-sdk') 直接拿到 mock。
 *   OPENID 由调用方通过 payload._testOpenid 注入，云函数 auth 中间件在
 *   ALLOW_TEST_OPENID=true 时尊重该字段（setup.mjs 已注入该环境变量）。
 * - 云函数自己的 PG 连接池读 process.env.PG_CONNECTION_STRING，setup.mjs 已注入。
 * - 第一次 require 后缓存在 require.cache，多次调用共享同一模块实例，与真实
 *   云函数容器（warm start）一致；模块内 AUTH_CACHE 等也跨调用共享。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from '../setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WX_MOCK_PATH = path.join(__dirname, 'wx-server-sdk-mock.js')

// ─── 安装 wx-server-sdk 短路（必须在任何云函数 require 之前完成） ───
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

// ─── 路径常量 ───
export const STAFF_API_DIR = path.join(REPO_ROOT, 'fengyu-staff', 'cloudfunctions', 'staffApi')
export const CLIENT_API_DIR = path.join(REPO_ROOT, 'fengyu-client', 'cloudfunctions', 'clientApi')
export const PAY_NOTIFY_DIR = path.join(REPO_ROOT, 'fengyu-client', 'cloudfunctions', 'payNotify')

// ─── 懒加载云函数 main() ───
let _staffMain = null
let _clientMain = null
let _payNotifyMain = null

// 历史背景：曾对 staffApi 生产 SQL 中两处 PG 16 严格模式不可执行的写法做过
// driver 入口正则替换（uuid[] cast、allocation_status CASE 返回 text）。
// 这两处 bug 已在源码里修复——故意不再保留 SQL patch 基础设施，避免未来真有
// SQL 漂移被静默掩盖。修复记录见本目录 README "已知生产 bug（已修复）" 节。
function loadStaffApi() {
  if (!_staffMain) {
    const r = createRequire(path.join(STAFF_API_DIR, 'package.json'))
    _staffMain = r(path.join(STAFF_API_DIR, 'index.js')).main
  }
  return _staffMain
}

function loadClientApi() {
  if (!_clientMain) {
    const r = createRequire(path.join(CLIENT_API_DIR, 'package.json'))
    _clientMain = r(path.join(CLIENT_API_DIR, 'index.js')).main
  }
  return _clientMain
}

function loadPayNotify() {
  if (!_payNotifyMain) {
    const r = createRequire(path.join(PAY_NOTIFY_DIR, 'package.json'))
    _payNotifyMain = r(path.join(PAY_NOTIFY_DIR, 'index.js')).main
  }
  return _payNotifyMain
}

/**
 * 调用 staffApi
 * @param {string} action - 如 'order.confirmOffline'
 * @param {object} payload - 必含 _testOpenid 字段以走测试模式 auth
 */
export async function invokeStaffApi(action, payload = {}) {
  const main = loadStaffApi()
  return await main({ action, payload }, {})
}

/**
 * 调用 clientApi
 */
export async function invokeClientApi(action, payload = {}, eventExtras = {}) {
  const main = loadClientApi()
  // eventExtras 注入 event 顶层（如 phoneData：模拟微信平台 CloudID 已解密结果，
  // 供 bindPhone 走 CloudID 路径而非已默认关闭的 phoneNumber 直传旁路）
  return await main({ action, payload, ...eventExtras }, {})
}

/**
 * 调用 payNotify（入口 event 形态：{ orderNo, transactionId?, payAmount?, paymentMethod? }）
 *
 * 注意：当前 payNotify 处于 PAYNOTIFY_DISABLED=true 守卫态，无论 event 传什么都
 * 立即返回 { code: -403, message: 'PERMISSION_DENIED: PAYNOTIFY_DISABLED' }
 * 并写一条 operation_logs(action='paynotify.disabled_invocation') 告警。
 * 解除守卫的前置条件见 cloudfunctions/payNotify/index.js 顶部注释。
 */
export async function invokePayNotify(event = {}) {
  const main = loadPayNotify()
  return await main(event, {})
}
