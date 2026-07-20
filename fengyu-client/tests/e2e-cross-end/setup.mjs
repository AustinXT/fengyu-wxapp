/**
 * cross-end (TE2X = TEST_E2E_CROSS) 跨端测试层 setup
 *
 * 与 fengyu-client/tests/e2e-cloudfn/setup.mjs 结构一致，但用独立 NS=TE2X，
 * 防止与 L2 (TE2L2) 数据污染、便于并发跑。
 *
 * 注入：
 *   1. ALLOW_TEST_OPENID=true → client+staff 两端 auth 中间件接 _testOpenid
 *   2. PG_CONNECTION_STRING（5433/fengyu_wxapp 主库）
 *   3. CLIENT_SECRET（HMAC 桥 spec 用，与 clientApi.handleHttpEntry 校验保持一致）
 *
 * 必须最先 import（任何 require 云函数 / pg 之前）。
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
  'postgresql://fengyu:fengyu123@47.113.202.7:5433/fengyu_wxapp'
process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING
// HMAC 桥测试默认密钥（与 invoke-http-bridge.mjs 默认一致）
process.env.CLIENT_SECRET = process.env.CLIENT_SECRET || 'test_client_secret_for_hmac_bridge'

// 命名空间 — 与 L2 (TE2L2) 互不重叠
export const NS = 'TE2X'

// ─── 公共 id 常量（与 L2 setup 同样语义，前缀换 TE2X） ───
export const TEST_STORE_ID = `${NS}_STORE`
export const TEST_STORE_ORG_ID = `${NS}_STORE_ORG`
export const TEST_HQ_ORG_ID = `${NS}_HQ_ORG`
export const TEST_MARKET_ORG_ID = `${NS}_MARKET_ORG`

export const TEST_MANAGER_EMP_ID = `${NS}_MGR`
export const TEST_MANAGER_OPENID = `${NS}_MGR_OPENID`
// 19999-09003x 段，与 L2 (19999099001..020) 错开避免手机号唯一约束冲突
export const TEST_MANAGER_PHONE = '19999091001'
export const TEST_CLIENT_USER_ID = `${NS}_CLI`
export const TEST_CLIENT_OPENID = `${NS}_CLI_OPENID`
export const TEST_CLIENT_PHONE = '19999091002'

// 商品/SKU/储值卡常量
export const TEST_MALL_CATEGORY_ID = `${NS}_MALL_CAT`
export const TEST_PRODUCT_CATEGORY_ID = `${NS}_PROD_CAT`
export const TEST_PRODUCT_ID = `${NS}_PROD`
export const TEST_SKU_NORMAL_ID = `${NS}_SKU_N`
export const TEST_PREPAID_CARD_ID = `${NS}_CARD`

// 优惠券
export const TEST_COUPON_TEMPLATE_ID = `${NS}_CTPL`
export const TEST_COUPON_ID = `${NS}_CPN`

// ─── 共享 pg 池 ───
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
