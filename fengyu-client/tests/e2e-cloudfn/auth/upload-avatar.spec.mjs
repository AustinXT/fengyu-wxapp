#!/usr/bin/env bun
/**
 * clientApi.auth.uploadAvatar 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/auth.js → uploadAvatar
 * Mock：./helpers/wx-server-sdk-mock.js → uploadFile 返回
 *       fileID = 'cloud://e2e-mock.test/{cloudPath}'
 *
 * 用例：
 *   1. happy: base64 非空 + ext='jpg' → 返回 fileID + 写入 avatar_url
 *   2. 不支持的 ext='gif' → INVALID_PARAMS: 不支持的图片格式
 *   3. 缺 base64: {} → INVALID_PARAMS: 缺少 base64 参数
 *   4. 空 base64: base64='' → INVALID_PARAMS: 缺少 base64 参数（非字符串/falsy 在 size check 之前）
 *   5. 大于 2MB：构造 buffer > 2MB 的 base64 → INVALID_PARAMS: 图片大小超过 2MB
 *
 * 注：'A'.repeat(3*1024*1024) 作为 base64 解码后约 2.25MB（base64 4字符 → 3字节），
 *     可触发 > 2MB 守卫。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import {
  ensureTestStore,
  cleanupTestData,
} from '../helpers/fixtures.mjs'
import { cleanupClientExtras } from '../helpers/client-fixtures.mjs'

const TEST_OPENID = `${NS}_UA_OPENID`

async function seedUser() {
  const userId = `${NS}_UA_USR`
  await pgQuery(
    `INSERT INTO client_wechat_users (user_id, openid)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, avatar_url = NULL`,
    [userId, TEST_OPENID]
  )
  return userId
}

// 一张最小有效 JPG 的 base64（4 字节，避免空 buffer）；尺寸只为通过 size 守卫
const TINY_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

async function caseHappy() {
  await ensureTestStore()
  await seedUser()
  const res = await invokeAs(TEST_OPENID, 'auth.uploadAvatar', {
    base64: TINY_BASE64,
    ext: 'jpg',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!res.data.fileID || !res.data.fileID.startsWith(`cloud://e2e-mock.test/avatars/${TEST_OPENID}/`)) {
    throw new Error(`unexpected fileID: ${res.data.fileID}`)
  }
  if (!res.data.fileID.endsWith('.jpg')) {
    throw new Error(`expect .jpg ext, got ${res.data.fileID}`)
  }
  const rows = await pgQuery(
    'SELECT avatar_url FROM client_wechat_users WHERE openid = $1',
    [TEST_OPENID]
  )
  if (rows[0]?.avatar_url !== res.data.fileID) {
    throw new Error(`PG avatar_url mismatch: ${rows[0]?.avatar_url} vs ${res.data.fileID}`)
  }
}

async function caseUnsupportedExt() {
  await ensureTestStore()
  await seedUser()
  const res = await invokeAs(TEST_OPENID, 'auth.uploadAvatar', {
    base64: TINY_BASE64,
    ext: 'gif',
  })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '不支持的图片格式' })
}

async function caseMissingBase64() {
  await ensureTestStore()
  await seedUser()
  const res = await invokeAs(TEST_OPENID, 'auth.uploadAvatar', {})
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '缺少 base64' })
}

async function caseEmptyBase64() {
  await ensureTestStore()
  await seedUser()
  const res = await invokeAs(TEST_OPENID, 'auth.uploadAvatar', { base64: '' })
  // 路由先检查 !base64 → falsy → 抛"缺少 base64 参数"
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '缺少 base64' })
}

async function caseOversize() {
  await ensureTestStore()
  await seedUser()
  // 3 MiB 的 base64 字符串 → 解码约 2.25 MiB，超过 2 MiB 守卫
  const big = 'A'.repeat(3 * 1024 * 1024)
  const res = await invokeAs(TEST_OPENID, 'auth.uploadAvatar', {
    base64: big,
    ext: 'jpg',
  })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '图片大小超过 2MB' })
}

const CASES = [
  ['happy: base64 + ext=jpg → fileID + PG avatar_url', caseHappy],
  ['ext=gif → INVALID_PARAMS (unsupported)', caseUnsupportedExt],
  ['no base64 → INVALID_PARAMS', caseMissingBase64],
  ['empty base64 → INVALID_PARAMS (caught by falsy check first)', caseEmptyBase64],
  ['> 2MB → INVALID_PARAMS', caseOversize],
]

let pass = 0, fail = 0
console.log(`[upload-avatar.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[upload-avatar.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
