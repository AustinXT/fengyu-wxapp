#!/usr/bin/env bun
/**
 * HMAC HTTP 桥矩阵：完整覆盖 clientApi/index.js handleHttpEntry 7 条分支。
 *
 * 守卫语义（参考 fengyu-client/cloudfunctions/clientApi/index.js line 162-232）：
 *   - 仅 POST + JSON body
 *   - 必须带 x-fengyu-signature = HMAC-SHA256(rawBody, CLIENT_SECRET)
 *   - body.timestamp 在 ±5min 内
 *   - body.action 在 HTTP_ACTION_ALLOWLIST（目前仅 'auth.uploadStaffAvatar'）
 *
 * 校验通过的 caseHappyHmac 只断言 HMAC 守卫通过 → 即使路由内部业务校验失败，
 * 错误类型也不应是 UNAUTHORIZED（签名/时间戳类）或带"HMAC/签名/时间戳"字样的 PERMISSION_DENIED。
 */
import './setup.mjs'
import { closePool } from './setup.mjs'
import { callHttpBridge } from './helpers/invoke-http-bridge.mjs'

async function caseHappyHmac() {
  // 正确签名 + 当前时间戳 + allowlist action；payload 是空对象 → uploadStaffAvatar
  // 业务校验会失败（缺 base64/employeeId），但 HMAC 守卫应已通过，错误类型不应是 UNAUTHORIZED。
  const res = await callHttpBridge({
    action: 'auth.uploadStaffAvatar',
    payload: { fileID: 'cloud://test', employeeId: 'TE2X_MGR' },
  })
  if (res.statusCode !== 200) throw new Error(`expect statusCode=200, got ${res.statusCode}`)
  // 业务侧报 INVALID_PARAMS (缺 base64) 是预期 — HMAC 已过；只断言守卫层未拒
  if (res.body?.errorType === 'UNAUTHORIZED') {
    throw new Error(`HMAC guard should have passed but got UNAUTHORIZED: ${res.body?.message}`)
  }
  if (res.body?.errorType === 'PERMISSION_DENIED' && String(res.body?.message || '').includes('HTTP')) {
    throw new Error(`HMAC guard should have passed but got PERMISSION_DENIED about HTTP: ${res.body?.message}`)
  }
}

async function caseGetRejected() {
  const res = await callHttpBridge({
    action: 'auth.uploadStaffAvatar',
    payload: {},
    method: 'GET',
  })
  if (res.body?.code !== -1) throw new Error(`expect code=-1 for GET, got ${res.body?.code} (${res.body?.message})`)
  if (!String(res.body?.message || '').includes('Method')) {
    throw new Error(`expect message contains "Method", got: ${res.body?.message}`)
  }
}

async function caseMissingSig() {
  const res = await callHttpBridge({
    action: 'auth.uploadStaffAvatar',
    payload: {},
    omitSig: true,
  })
  if (res.body?.code !== -401) throw new Error(`expect code=-401, got ${res.body?.code}`)
  if (res.body?.errorType !== 'UNAUTHORIZED') {
    throw new Error(`expect errorType=UNAUTHORIZED, got ${res.body?.errorType}`)
  }
  if (!String(res.body?.message || '').includes('签名')) {
    throw new Error(`expect message contains "签名", got: ${res.body?.message}`)
  }
}

async function caseWrongSig() {
  const res = await callHttpBridge({
    action: 'auth.uploadStaffAvatar',
    payload: {},
    badSig: true,
  })
  if (res.body?.code !== -401) throw new Error(`expect code=-401, got ${res.body?.code}`)
  if (res.body?.errorType !== 'UNAUTHORIZED') {
    throw new Error(`expect errorType=UNAUTHORIZED, got ${res.body?.errorType}`)
  }
}

async function caseStaleTimestamp() {
  const res = await callHttpBridge({
    action: 'auth.uploadStaffAvatar',
    payload: {},
    timestamp: Date.now() - 10 * 60 * 1000, // 10 min ago
  })
  if (res.body?.code !== -401) throw new Error(`expect code=-401, got ${res.body?.code}`)
  if (res.body?.errorType !== 'UNAUTHORIZED') {
    throw new Error(`expect errorType=UNAUTHORIZED, got ${res.body?.errorType}`)
  }
  if (!String(res.body?.message || '').includes('时间戳')) {
    throw new Error(`expect message contains "时间戳", got: ${res.body?.message}`)
  }
}

async function caseNonAllowlistAction() {
  const res = await callHttpBridge({
    action: 'order.create',
    payload: {},
  })
  if (res.body?.code !== -403) throw new Error(`expect code=-403, got ${res.body?.code}`)
  if (res.body?.errorType !== 'PERMISSION_DENIED') {
    throw new Error(`expect errorType=PERMISSION_DENIED, got ${res.body?.errorType}`)
  }
  if (!String(res.body?.message || '').includes('不暴露 HTTP')) {
    throw new Error(`expect message contains "不暴露 HTTP", got: ${res.body?.message}`)
  }
}

async function caseBadJson() {
  const res = await callHttpBridge({
    action: 'auth.uploadStaffAvatar', // 不使用
    payload: {},
    rawBodyOverride: '{not json',
  })
  if (res.body?.code !== -400) throw new Error(`expect code=-400, got ${res.body?.code}`)
  if (res.body?.errorType !== 'INVALID_PARAMS') {
    throw new Error(`expect errorType=INVALID_PARAMS, got ${res.body?.errorType}`)
  }
  if (!String(res.body?.message || '').includes('JSON')) {
    throw new Error(`expect message contains "JSON", got: ${res.body?.message}`)
  }
}

const CASES = [
  ['HMAC happy: 正确签名+时间戳+allowlist → 业务侧错而非守卫错', caseHappyHmac],
  ['GET 方法被拒 → code=-1 Method not allowed', caseGetRejected],
  ['缺 x-fengyu-signature 头 → -401 UNAUTHORIZED "签名"', caseMissingSig],
  ['签名内容篡改（长度一致）→ -401 UNAUTHORIZED', caseWrongSig],
  ['timestamp 10min 前 → -401 UNAUTHORIZED "时间戳"', caseStaleTimestamp],
  ['action 不在 allowlist (order.create) → -403 "不暴露 HTTP"', caseNonAllowlistAction],
  ['body 非合法 JSON → -400 INVALID_PARAMS "JSON"', caseBadJson],
]

let pass = 0, fail = 0
console.log(`[cross-end/hmac-bridge] start | ${CASES.length} cases | ${new Date().toISOString()}`)
try {
  for (const [name, fn] of CASES) {
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
  await closePool()
}
console.log(`[cross-end/hmac-bridge] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
