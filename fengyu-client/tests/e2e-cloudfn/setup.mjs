/**
 * client L2 setup
 *
 * 1. 注入 ALLOW_TEST_OPENID=true → 让云函数 auth 中间件接受 _testOpenid
 * 2. 注入 PG_CONNECTION_STRING（运行业务 SQL 的连接，与 admin / 云函数生产同库）
 * 3. 关闭分享礼优惠券模板硬依赖 / 任何外部 wxacode 副作用
 * 4. 强制开启积分发放 feature flag
 * 5. 暴露 PG 池 + NS / 公共测试 id 常量，供 invoke.mjs / fixtures.mjs / spec 复用
 *
 * 用法（每个 spec 顶部）：
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
// 短前缀（受限于 sale_order_id / employee_id / sale_item_id 均为 varchar(30)），
// 文档/外部说明中仍称作 "TEST_E2E_L2" 命名空间。
export const NS = 'TE2L2' // = TEST_E2E_L2 缩写

// 测试店 store_id / org_node_id（与 NS 解耦的稳定 id，跨多次运行幂等）
export const TEST_STORE_ID = `${NS}_STORE`
export const TEST_STORE_ORG_ID = `${NS}_STORE_ORG`
export const TEST_HQ_ORG_ID = `${NS}_HQ_ORG`
export const TEST_MARKET_ORG_ID = `${NS}_MARKET_ORG`

// 第二测试店（转店目标店）
export const TEST_STORE_ID_2 = `${NS}_STORE2`
export const TEST_STORE_ORG_ID_2 = `${NS}_STORE2_ORG`

// 公共 employee/openid/user 模板（test 内可覆盖）
export const TEST_MANAGER_EMP_ID = `${NS}_MGR`
export const TEST_MANAGER_OPENID = `${NS}_MGR_OPENID`
export const TEST_MANAGER_PHONE = '19999099001'
export const TEST_CLIENT_USER_ID = `${NS}_CLI`
export const TEST_CLIENT_OPENID = `${NS}_CLI_OPENID`
export const TEST_CLIENT_PHONE = '19999099002'

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

// ─── client 专属命名空间常量 ─────────────────────────────
// 商品/SKU 用同一 NS 前缀，方便统一清理
export const TEST_MALL_CATEGORY_ID = `${NS}_MALL_CAT`
export const TEST_PRODUCT_CATEGORY_ID = `${NS}_PROD_CAT`
export const TEST_PRODUCT_ID = `${NS}_PROD`           // 普通商品
export const TEST_SKU_NORMAL_ID = `${NS}_SKU_N`        // 普通单品 SKU
export const TEST_SKU_COURSE_ID = `${NS}_SKU_C`        // 疗程卡 SKU（sessionCount > 1）
export const TEST_SKU_EXPERIENCE_ID = `${NS}_SKU_E`    // 体验卡 SKU（is_experience=true）
export const TEST_SKU_RECHARGE_ID = `${NS}_SKU_R`      // 充值卡 SKU（兼容残留，2026-05-20 充值已剥离 SKU 化）

// 储值卡（一户一账户）
export const TEST_PREPAID_CARD_ID = `${NS}_CARD`

// 优惠券
export const TEST_COUPON_TEMPLATE_ID = `${NS}_CTPL`
export const TEST_COUPON_ID = `${NS}_CPN`

// 第二顾客（用于跨用户访问测试）
export const TEST_CLIENT2_USER_ID = `${NS}_CLI2`
export const TEST_CLIENT2_OPENID = `${NS}_CLI2_OPENID`
export const TEST_CLIENT2_PHONE = '19999099003'
