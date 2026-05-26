/**
 * 全局 setup
 *
 * 1. 注入 ALLOW_TEST_OPENID=true → 让云函数 auth 中间件接受 _testOpenid
 * 2. 注入 PG_CONNECTION_STRING（运行业务 SQL 的连接，与 admin / 云函数生产同库）
 * 3. 关闭分享礼优惠券模板硬依赖 / 任何外部 wxacode 副作用
 * 4. 强制开启积分发放 feature flag
 * 5. 暴露 require/path helpers，供 invoke.mjs / fixtures.mjs 复用
 *
 * 用法（每个 smoke 脚本顶部）：
 *   import './setup.mjs'  // 必须最先执行，且在任何 require 云函数之前
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

// ─── 必须在 require 任何云函数 / pg 之前注入 ───
process.env.ALLOW_TEST_OPENID = 'true'
process.env.POINTS_ACCRUAL_ENABLED = process.env.POINTS_ACCRUAL_ENABLED || 'true'
process.env.PG_CONNECTION_STRING =
  process.env.PG_CONNECTION_STRING ||
  process.env.DATABASE_URL ||
  'postgresql://fengyu:fengyu123@47.113.202.7:5434/fengyu'
process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING

// 命名空间常量 — 所有 fixture 数据必须以此为前缀，方便清理
// 短前缀（受限于 sale_order_id / employee_id / sale_item_id 均为 varchar(30)）。
// admin 端独占 'TE2A'（= TEST_E2E_Admin），与 staff e2e-cloudfn 的 'TE2L2_' 物理隔离，
// 避免两端并发跑同一 5434 库时 cleanup 的 LIKE 前缀互删在途夹具（非确定性假红）。
export const NS = 'TE2A' // = TEST_E2E_Admin 缩写（与 staff TE2L2_ 隔离）

// 测试店 store_id / org_node_id（与 NS 解耦的稳定 id，跨多次运行幂等）
//
// 注意：org_nodes.id 在 DB schema 上是 text；但 staffApi/utils/scope.js
// expandScopeStoreIds 用 ANY($1::uuid[]) 比较 org_node_id，
// 即使元素是合法 uuid 字面值，PG 也报 'operator does not exist: text = uuid'。
// 测试侧通过 invoke.mjs 的 TEST_PATCH-STAFFAPI-SCOPE-UUID-CAST 将 ::uuid[] 改为
// ::text[] 来绕过；因此 fixture 这边继续使用可读的命名空间前缀字符串。
export const TEST_STORE_ID = `${NS}_STORE`
export const TEST_STORE_ORG_ID = `${NS}_STORE_ORG`
export const TEST_HQ_ORG_ID = `${NS}_HQ_ORG`
export const TEST_MARKET_ORG_ID = `${NS}_MARKET_ORG`

// 公共 employee/openid/user 模板（test 内可覆盖）
export const TEST_MANAGER_EMP_ID = `${NS}_MGR`
export const TEST_MANAGER_OPENID = `${NS}_MGR_OPENID`
// 199 段 + 末尾 88001/88002，与真实顾客 / WorkFine 同步号码不冲突；
// 且与 staff e2e 占用的 19999099001~020 段隔离（cleanup 也按 phone 删，号段必须分开）。
export const TEST_MANAGER_PHONE = '19999088001'
export const TEST_CLIENT_USER_ID = `${NS}_CLI`
export const TEST_CLIENT_OPENID = `${NS}_CLI_OPENID`
export const TEST_CLIENT_PHONE = '19999088002'

// 共享 pg 池（懒初始化）
import pgPkg from 'pg'
const { Pool } = pgPkg

let _pool = null
export function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.PG_CONNECTION_STRING,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  }
  return _pool
}

export async function pgQuery(sql, params = []) {
  const client = await getPool().connect()
  try {
    const res = await client.query(sql, params)
    return res.rows
  } finally {
    client.release()
  }
}

export async function closePool() {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}
