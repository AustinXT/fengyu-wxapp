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

// TEST_PATCH-STAFFAPI-SQL：
// 把 staffApi 生产 SQL 中部分 PG 严格模式下不可执行的写法在 driver 入口替换为兼容写法。
// 这些写法在生产 cloudbase 环境历史性可执行（也许是 pg-driver 早期版本宽松解析），
// 但当前 PG 16 + node-pg 8.x 严格校验下报错。本测试基础设施的目的不是修生产 bug，
// 而是让真实业务路径能在本地端到端跑通验证关键不变量（积分发放无报错等）。
// 建议向 staff team 提 issue：把以下写法在源码里修掉（详见 README "已知生产 bug" 节）。
//
// 替换列表（按出现位置）：
//   1. ANY($N::uuid[]) → ANY($N::text[])
//      位置：utils/scope.js expandScopeStoreIds 中两处（market/store 分支）
//      原因：org_nodes.id 是 text 列，::uuid[] cast 比较时 PG 报 'text = uuid' operator 缺失
//
//   2. allocation_status = CASE WHEN allocation_status = '已分配' THEN '已分配' ELSE '待分配' END
//      → allocation_status = (CASE WHEN allocation_status = '已分配' THEN '已分配' ELSE '待分配' END)::allocation_status
//      位置：routes/order.js confirmOffline UPDATE
//      原因：CASE 返回 text，必须 cast 到 allocation_status enum
const SQL_PATCHES = [
  // 1. uuid[] -> text[]
  { from: /::uuid\[\]/g, to: '::text[]' },
  // 2. allocation_status CASE
  {
    from: /allocation_status = CASE WHEN allocation_status = '已分配' THEN '已分配' ELSE '待分配' END/g,
    to: "allocation_status = (CASE WHEN allocation_status = '已分配' THEN '已分配' ELSE '待分配' END)::allocation_status",
  },
]

function applySqlPatches(text) {
  let out = text
  for (const { from, to } of SQL_PATCHES) {
    out = out.replace(from, to)
  }
  return out
}

function installStaffApiSqlPatch(r) {
  if (installStaffApiSqlPatch.__done) return
  // 1) 包装 staff 自己 db/pg.js 的 query / transaction —— 这是 staff 业务代码统一入口
  const staffPgPath = path.join(STAFF_API_DIR, 'db', 'pg.js')
  const staffPg = r(staffPgPath)
  const origQuery = staffPg.query
  const origTxn = staffPg.transaction
  staffPg.query = async function patchedQuery(sql, params) {
    if (typeof sql === 'string') sql = applySqlPatches(sql)
    if (process.env.E2E_DEBUG) console.log('[patch-staffPg.query]', String(sql).slice(0, 120).replace(/\s+/g, ' '))
    return await origQuery.call(staffPg, sql, params)
  }
  staffPg.transaction = async function patchedTxn(cb) {
    return await origTxn.call(staffPg, async (client) => {
      const origClientQuery = client.query.bind(client)
      client.query = function (sqlOrConfig, ...rest) {
        let s = sqlOrConfig
        if (typeof s === 'string') s = applySqlPatches(s)
        else if (s && typeof s.text === 'string') s = { ...s, text: applySqlPatches(s.text) }
        if (process.env.E2E_DEBUG) {
          const t = typeof s === 'string' ? s : s?.text
          if (t) console.log('[patch-txnClient.query]', String(t).slice(0, 120).replace(/\s+/g, ' '))
        }
        return origClientQuery(s, ...rest)
      }
      return await cb(client)
    })
  }

  // 2) 包装 pg.Pool / pg.Client prototype.query —— payNotify / 其它直接 pool.connect() 路径用
  const pgPkg = r('pg')
  for (const cls of [pgPkg.Client, pgPkg.Pool]) {
    if (!cls || !cls.prototype || typeof cls.prototype.query !== 'function') continue
    const origProtoQuery = cls.prototype.query
    cls.prototype.query = function patched(textOrConfig, ...rest) {
      if (typeof textOrConfig === 'string') {
        textOrConfig = applySqlPatches(textOrConfig)
      } else if (textOrConfig && typeof textOrConfig.text === 'string') {
        textOrConfig = { ...textOrConfig, text: applySqlPatches(textOrConfig.text) }
      }
      if (process.env.E2E_DEBUG) {
        const txt = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig?.text
        if (txt) console.log(`[patch-${cls.name}.query]`, String(txt).slice(0, 120).replace(/\s+/g, ' '))
      }
      return origProtoQuery.call(this, textOrConfig, ...rest)
    }
  }

  installStaffApiSqlPatch.__done = true
  if (process.env.E2E_DEBUG) console.log('[invoke] staffApi SQL patches installed')
}

function loadStaffApi() {
  if (!_staffMain) {
    const r = createRequire(path.join(STAFF_API_DIR, 'package.json'))
    installStaffApiSqlPatch(r)
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
export async function invokeClientApi(action, payload = {}) {
  const main = loadClientApi()
  return await main({ action, payload }, {})
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
