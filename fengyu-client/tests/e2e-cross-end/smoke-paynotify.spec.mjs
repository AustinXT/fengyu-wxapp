#!/usr/bin/env bun
/**
 * payNotify 跨端守卫验证（PAYNOTIFY_DISABLED 态）。
 *
 * 复用 fengyu-client/tests/e2e-cloudfn/smoke-paynotify.mjs 的同语义检查：
 *   1. invocation 返回 code=-403 + message 含 PAYNOTIFY_DISABLED
 *   2. operation_logs 新增一行 action='paynotify.disabled_invocation' severity=HIGH
 *
 * TODO(payNotify-unlock): 拉卡拉 V3 签名校验完成后改为真业务断言：
 *   - settlePointsSafe → client.points.history 见积分流水
 *   - grantShareGift → client.coupon.list 见分享礼券
 *   - recalcPaidSessionsForOrder → client.service.list 见 paid_sessions 推进
 * 当前仅守卫 PAYNOTIFY_DISABLED 不被意外解除。
 */
import './setup.mjs'
import { NS, closePool, pgQuery } from './setup.mjs'
import { createRequire } from 'node:module'
import path from 'node:path'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT } from './setup.mjs'

// 安装 wx-server-sdk mock（与其他 spec 共用幂等标志位）
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WX_MOCK_PATH = path.join(
  REPO_ROOT, 'fengyu-client', 'tests', 'e2e-cloudfn', 'helpers', 'wx-server-sdk-mock.js'
)
if (!Module.__wxMockInstalled) {
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function patched(request, parent, ...rest) {
    if (request === 'wx-server-sdk') return WX_MOCK_PATH
    return origResolve.call(this, request, parent, ...rest)
  }
  Module.__wxMockInstalled = true
}

const PAY_NOTIFY_DIR = path.join(REPO_ROOT, 'fengyu-client', 'cloudfunctions', 'payNotify')
const r = createRequire(path.join(PAY_NOTIFY_DIR, 'package.json'))
const payNotifyMain = r(path.join(PAY_NOTIFY_DIR, 'index.js')).main

let exitCode = 1
let pass = false
const FAKE_TXN_ID = `${NS}_PNTXN_${Date.now()}`

async function main() {
  console.log(`[cross-end/smoke-paynotify] start | ${new Date().toISOString()}`)

  const beforeRows = await pgQuery(
    `SELECT count(*)::int AS c FROM operation_logs
     WHERE action = 'paynotify.disabled_invocation' AND target_id = 'EXTERNAL'
       AND created_at > NOW() - INTERVAL '5 minutes'`
  )
  const beforeCount = Number(beforeRows[0].c)

  const result = await payNotifyMain({
    orderNo: `${NS}_PN_ORDER`,
    transactionId: FAKE_TXN_ID,
    payAmount: 100,
    paymentMethod: '微信',
  }, {})
  console.log(`  result: ${JSON.stringify(result)}`)

  if (result.code !== -403 || !String(result.message || '').includes('PAYNOTIFY_DISABLED')) {
    console.log(`  ✗ FAIL: 期望 code=-403 + message 含 PAYNOTIFY_DISABLED`)
    return
  }

  const afterRows = await pgQuery(
    `SELECT count(*)::int AS c FROM operation_logs
     WHERE action = 'paynotify.disabled_invocation' AND target_id = 'EXTERNAL'
       AND created_at > NOW() - INTERVAL '5 minutes'`
  )
  const delta = Number(afterRows[0].c) - beforeCount
  if (delta !== 1) {
    console.log(`  ✗ FAIL: 期望 operation_logs 新增 1 行，实际 ${delta}`)
    return
  }

  const recent = await pgQuery(
    `SELECT detail FROM operation_logs
       WHERE action = 'paynotify.disabled_invocation' AND target_id = 'EXTERNAL'
       ORDER BY id DESC LIMIT 1`
  )
  if (recent[0]?.detail?.severity !== 'HIGH') {
    console.log(`  ✗ FAIL: detail.severity 应=HIGH，实际=${recent[0]?.detail?.severity}`)
    return
  }

  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — payNotify guard 工作正常`)
}

try {
  await main()
} catch (e) {
  console.error('[cross-end/smoke-paynotify] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try {
    await pgQuery(
      `DELETE FROM operation_logs
        WHERE action = 'paynotify.disabled_invocation'
          AND target_id = 'EXTERNAL'
          AND (detail->>'event_keys')::text LIKE $1`,
      [`%${NS}_PN_ORDER%`]
    ).catch(() => null)
  } catch (e) {
    console.error('[cross-end/smoke-paynotify] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[cross-end/smoke-paynotify] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
