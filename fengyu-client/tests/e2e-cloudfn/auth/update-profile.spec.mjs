#!/usr/bin/env bun
/**
 * clientApi.auth.updateProfile 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/auth.js → updateProfile
 *
 * 用例：
 *   1. 仅 name: {name:'张三'} → client_wechat_users.name='张三'
 *   2. 仅 avatarUrl: {avatarUrl:'cloud://xxx/abc.jpg'} → avatar_url 写入
 *   3. 都传：name + avatarUrl 都更新
 *   4. 都不传：{} → INVALID_PARAMS: 至少提供 name 或 avatarUrl
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import {
  ensureTestStore,
  cleanupTestData,
} from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

const TEST_OPENID = `${NS}_UP_OPENID`

async function seedUser() {
  const userId = `${NS}_UP_USR`
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, name = NULL, avatar_url = NULL`,
    [userId, TEST_OPENID]
  )
  return userId
}

async function caseNameOnly() {
  await ensureTestStore()
  await seedUser()
  const res = await invokeAs(TEST_OPENID, 'auth.updateProfile', { name: '张三' })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.name !== '张三') throw new Error(`response name mismatch: ${res.data.name}`)
  const rows = await pgQuery(
    'SELECT name, avatar_url FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (rows[0]?.name !== '张三') throw new Error(`PG name mismatch: ${rows[0]?.name}`)
  if (rows[0]?.avatar_url !== null) {
    throw new Error(`expect avatar_url unchanged null, got ${rows[0]?.avatar_url}`)
  }
}

async function caseAvatarOnly() {
  await ensureTestStore()
  await seedUser()
  const url = 'cloud://e2e-mock.test/avatars/abc.jpg'
  const res = await invokeAs(TEST_OPENID, 'auth.updateProfile', { avatarUrl: url })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.avatarUrl !== url) throw new Error(`response avatarUrl mismatch: ${res.data.avatarUrl}`)
  const rows = await pgQuery(
    'SELECT name, avatar_url FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (rows[0]?.avatar_url !== url) throw new Error(`PG avatar_url mismatch: ${rows[0]?.avatar_url}`)
  if (rows[0]?.name !== null) throw new Error(`expect name unchanged null, got ${rows[0]?.name}`)
}

async function caseBoth() {
  await ensureTestStore()
  await seedUser()
  const url = 'cloud://e2e-mock.test/avatars/both.jpg'
  const res = await invokeAs(TEST_OPENID, 'auth.updateProfile', {
    name: '李四',
    avatarUrl: url,
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const rows = await pgQuery(
    'SELECT name, avatar_url FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (rows[0]?.name !== '李四') throw new Error(`PG name mismatch: ${rows[0]?.name}`)
  if (rows[0]?.avatar_url !== url) throw new Error(`PG avatar_url mismatch: ${rows[0]?.avatar_url}`)
}

async function caseNeitherProvided() {
  await ensureTestStore()
  await seedUser()
  const res = await invokeAs(TEST_OPENID, 'auth.updateProfile', {})
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '至少提供 name 或 avatarUrl' })
}

const CASES = [
  ['name only → PG name updated', caseNameOnly],
  ['avatarUrl only → PG avatar_url updated', caseAvatarOnly],
  ['both name + avatarUrl → both updated', caseBoth],
  ['neither provided → INVALID_PARAMS', caseNeitherProvided],
]

let pass = 0, fail = 0
console.log(`[update-profile.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
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

console.log(`[update-profile.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
