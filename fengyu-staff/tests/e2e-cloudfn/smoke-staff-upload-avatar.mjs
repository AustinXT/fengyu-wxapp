#!/usr/bin/env bun
/**
 * staff.uploadAvatar 全分支
 *
 * 路由源：fengyu-staff/cloudfunctions/staffApi/routes/staff.js → uploadAvatar
 * Mock：./helpers/wx-server-sdk-mock.js
 *   - new cloud.Cloud({resourceEnv: <client envId>, identityless: true}) 实例的 uploadFile
 *     会返回 fileID = `cloud://<resourceEnv>.bucket/${cloudPath}`
 *     便于断言"真的跨 env 写到了 client envId 域"
 *
 * 用例（与 client auth.uploadAvatar 对齐 + 跨 env 断言）：
 *   1. happy: base64 非空 + ext='jpg' → fileID 落在 CLIENT_ENV_ID 域 + PG avatar_url 写入
 *   2. 不支持的 ext='gif' → INVALID_PARAMS: 不支持的图片格式
 *   3. 缺 base64: {} → INVALID_PARAMS: 缺少 base64 参数
 *   4. 空 base64: base64='' → INVALID_PARAMS: 缺少 base64 参数（!base64 falsy 检查在 size 之前）
 *   5. 大于 2MB：3MB base64 → INVALID_PARAMS: 图片大小超过 2MB
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_OPENID, TEST_MANAGER_EMP_ID, pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, cleanupTestData,
} from './helpers/fixtures.mjs'

// 与 routes/staff.js 中的 CLIENT_ENV_ID 默认值保持同步（routes/staff.js 读 process.env.CLIENT_ENV_ID 覆盖）
const EXPECTED_CLIENT_ENV_ID = process.env.CLIENT_ENV_ID || 'cloud1-3gpht4b01ff88838'

// 一张最小 4 字节有效 JPG 的 base64（避免空 buffer 触发 size=0 守卫）
const TINY_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

let pass = 0; let fail = 0
function rec(line) { console.log(line) }
function failCase(name, msg) { rec(`  ❌ ${name}\n     ${msg}`); fail++ }
function passCase(name) { rec(`  ✅ ${name}`); pass++ }

async function resetAvatar() {
  await pgQuery(
    `UPDATE staff_wechat_users SET avatar_url = NULL WHERE employee_id = $1`,
    [TEST_MANAGER_EMP_ID]
  )
}

async function caseHappy() {
  await resetAvatar()
  const r = await invokeStaffApi('staff.uploadAvatar', {
    _testOpenid: TEST_MANAGER_OPENID,
    base64: TINY_BASE64,
    ext: 'jpg',
  })
  if (r.code !== 0) return failCase('happy', `code=${r.code} msg=${r.message}`)
  const fileID = r.data?.fileID
  // 关键断言：跨 env upload 真把 fileID 写到了 client envId 域
  const expectedPrefix = `cloud://${EXPECTED_CLIENT_ENV_ID}.`
  if (!fileID || !fileID.startsWith(expectedPrefix)) {
    return failCase('happy', `fileID 应以 "${expectedPrefix}" 开头（验证跨 env upload 写入 client env），实际=${fileID}`)
  }
  if (!fileID.endsWith('.jpg')) {
    return failCase('happy', `fileID 应以 .jpg 结尾，实际=${fileID}`)
  }
  if (!fileID.includes(`/avatars/staff/${TEST_MANAGER_EMP_ID}/`)) {
    return failCase('happy', `fileID 应含 /avatars/staff/${TEST_MANAGER_EMP_ID}/ 路径，实际=${fileID}`)
  }
  // PG 行已写
  const rows = await pgQuery(
    `SELECT avatar_url FROM staff_wechat_users WHERE employee_id = $1`,
    [TEST_MANAGER_EMP_ID]
  )
  if (rows[0]?.avatar_url !== fileID) {
    return failCase('happy', `PG avatar_url mismatch: ${rows[0]?.avatar_url} vs ${fileID}`)
  }
  passCase(`happy — fileID 跨 env 写入 ${EXPECTED_CLIENT_ENV_ID} + PG 同步`)
}

async function caseUnsupportedExt() {
  await resetAvatar()
  const r = await invokeStaffApi('staff.uploadAvatar', {
    _testOpenid: TEST_MANAGER_OPENID,
    base64: TINY_BASE64,
    ext: 'gif',
  })
  if (r.code === 0) return failCase('ext=gif', `应失败，实际 code=0`)
  if (r.errorType !== 'INVALID_PARAMS' || !String(r.message || '').includes('不支持的图片格式')) {
    return failCase('ext=gif', `应 INVALID_PARAMS/'不支持的图片格式'，实际 errorType=${r.errorType} msg=${r.message}`)
  }
  passCase('ext=gif → INVALID_PARAMS')
}

async function caseMissingBase64() {
  await resetAvatar()
  const r = await invokeStaffApi('staff.uploadAvatar', { _testOpenid: TEST_MANAGER_OPENID })
  if (r.code === 0) return failCase('no base64', `应失败，实际 code=0`)
  if (r.errorType !== 'INVALID_PARAMS' || !String(r.message || '').includes('缺少 base64')) {
    return failCase('no base64', `应 INVALID_PARAMS/'缺少 base64'，实际 errorType=${r.errorType} msg=${r.message}`)
  }
  passCase('no base64 → INVALID_PARAMS')
}

async function caseEmptyBase64() {
  await resetAvatar()
  const r = await invokeStaffApi('staff.uploadAvatar', {
    _testOpenid: TEST_MANAGER_OPENID,
    base64: '',
  })
  if (r.code === 0) return failCase('empty base64', `应失败，实际 code=0`)
  // !base64 falsy 检查在 size=0 之前 → 走"缺少 base64"分支
  if (r.errorType !== 'INVALID_PARAMS' || !String(r.message || '').includes('缺少 base64')) {
    return failCase('empty base64', `应 INVALID_PARAMS/'缺少 base64'，实际 errorType=${r.errorType} msg=${r.message}`)
  }
  passCase('empty base64 → INVALID_PARAMS (caught by falsy first)')
}

async function caseOversize() {
  await resetAvatar()
  // 3 MiB base64 字符串 → 解码约 2.25 MiB，超过 2 MiB 守卫
  const big = 'A'.repeat(3 * 1024 * 1024)
  const r = await invokeStaffApi('staff.uploadAvatar', {
    _testOpenid: TEST_MANAGER_OPENID,
    base64: big,
    ext: 'jpg',
  })
  if (r.code === 0) return failCase('>2MB', `应失败，实际 code=0`)
  if (r.errorType !== 'INVALID_PARAMS' || !String(r.message || '').includes('图片大小超过 2MB')) {
    return failCase('>2MB', `应 INVALID_PARAMS/'图片大小超过 2MB'，实际 errorType=${r.errorType} msg=${r.message}`)
  }
  passCase('>2MB → INVALID_PARAMS')
}

const CASES = [
  ['happy: base64 + ext=jpg → fileID 跨 env + PG avatar_url', caseHappy],
  ['ext=gif → INVALID_PARAMS (unsupported)', caseUnsupportedExt],
  ['no base64 → INVALID_PARAMS', caseMissingBase64],
  ['empty base64 → INVALID_PARAMS (caught by falsy check first)', caseEmptyBase64],
  ['> 2MB → INVALID_PARAMS', caseOversize],
]

async function main() {
  rec(`[smoke-staff-upload-avatar] start | ${CASES.length} cases | ${new Date().toISOString()}`)
  rec(`  CLIENT_ENV_ID expected: ${EXPECTED_CLIENT_ENV_ID}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // TEST_MANAGER_EMP_ID + TEST_MANAGER_OPENID

  for (const [name, fn] of CASES) {
    try {
      await fn()
    } catch (e) {
      failCase(name, e.message)
      if (process.env.E2E_DEBUG) console.log(e.stack)
    }
  }
}

try { await main() } catch (e) { console.error('EXCEPTION:', e.message) }
finally {
  await cleanupTestData(NS)
  await closePool()
  const exitCode = fail === 0 ? 0 : 1
  console.log(`[smoke-staff-upload-avatar] end | ${pass} passed / ${fail} failed | exit=${exitCode}`)
  process.exit(exitCode)
}
