#!/usr/bin/env bun
/**
 * clientApi.auth.login 全分支
 *
 * 用例：
 *   1. 新用户登录 → 创建 client_wechat_users 行，isNewUser=true，userId 格式 FYGK-YYYYMMDD-NNNNN
 *   2. 老用户再登录 → isNewUser=false，last_login_at 更新
 *   3. 老用户已绑店 → 返回 boundStoreName / boundMarketName（JOIN stores + org_nodes）
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_CLIENT_OPENID,
  TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import { ensureTestStore, cleanupTestData } from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'
import { pgQuery } from '../setup.mjs'

const TEST_OPENID = `${NS}_LOGIN_OPENID_001`

async function caseNewUser() {
  await ensureTestStore()
  const res = await invokeAs(TEST_OPENID, 'auth.login', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!res.data.isNewUser) throw new Error(`expect isNewUser=true, got ${res.data.isNewUser}`)
  if (!/^FYGK-\d{8}-\d{5}$/.test(res.data.userId)) {
    throw new Error(`userId format mismatch: ${res.data.userId}`)
  }

  // PG 断言
  const rows = await pgQuery(
    'SELECT user_id, phone, bound_store_id FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (rows.length !== 1) throw new Error(`expect 1 row, got ${rows.length}`)
  if (rows[0].user_id !== res.data.userId) throw new Error('user_id mismatch')
  if (rows[0].phone !== null) throw new Error('expect phone null')
  if (rows[0].bound_store_id !== null) throw new Error('expect bound_store_id null')
}

async function caseExistingUser() {
  // 先建顾客（直接插入，避免依赖 caseNewUser 顺序）
  await ensureTestStore()
  const userId = `${NS}_EXIST_USR`
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid, phone)
     VALUES ($1, $2, '13800000099')
     ON CONFLICT (user_id) DO UPDATE SET openid = EXCLUDED.openid, phone = EXCLUDED.phone`,
    [userId, TEST_OPENID]
  )
  const before = await pgQuery(
    'SELECT last_login_at FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  const lastLoginBefore = before[0].last_login_at

  // 等 10ms 确保 last_login_at 必然 > before
  await new Promise(r => setTimeout(r, 10))

  const res = await invokeAs(TEST_OPENID, 'auth.login', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.isNewUser !== false) throw new Error(`expect isNewUser=false, got ${res.data.isNewUser}`)
  if (res.data.userId !== userId) throw new Error(`userId mismatch: ${res.data.userId} vs ${userId}`)
  if (res.data.phone !== '13800000099') throw new Error(`phone mismatch: ${res.data.phone}`)

  const after = await pgQuery(
    'SELECT last_login_at FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (lastLoginBefore && after[0].last_login_at && after[0].last_login_at <= lastLoginBefore) {
    throw new Error(`last_login_at not updated: ${lastLoginBefore} → ${after[0].last_login_at}`)
  }
}

async function caseExistingUserBoundStore() {
  await ensureTestStore()
  const userId = `${NS}_BOUND_USR`
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid, phone, bound_store_id)
     VALUES ($1, $2, '13800000098', $3)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, bound_store_id = EXCLUDED.bound_store_id`,
    [userId, TEST_OPENID, TEST_STORE_ID]
  )
  const res = await invokeAs(TEST_OPENID, 'auth.login', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.boundStoreId !== TEST_STORE_ID) {
    throw new Error(`boundStoreId mismatch: ${res.data.boundStoreId}`)
  }
  if (!res.data.boundStoreName || !res.data.boundStoreName.includes(NS)) {
    throw new Error(`boundStoreName mismatch: ${res.data.boundStoreName}`)
  }
  if (!res.data.boundMarketName || !res.data.boundMarketName.includes(NS)) {
    throw new Error(`boundMarketName mismatch: ${res.data.boundMarketName}`)
  }
}

const CASES = [
  ['new user → create row + isNewUser=true', caseNewUser],
  ['existing user → isNewUser=false + last_login_at refreshed', caseExistingUser],
  ['existing user with bound store → JOIN returns store/market name', caseExistingUserBoundStore],
]

let pass = 0, fail = 0
console.log(`[login.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    // 用例间隔离：清干净再跑
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[login.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
