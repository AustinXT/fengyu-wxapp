#!/usr/bin/env bun
/**
 * smoke-paynotify：验证 payNotify 云函数当前的 PAYNOTIFY_DISABLED 守卫态。
 *
 * 当前业务状态：D-Q1-2026-04-26 决策下 payNotify 立即停用直到补完拉卡拉签名校验，
 * 任何 invocation 都直接返回 code=-403 + 写一条 operation_logs(
 * action='paynotify.disabled_invocation') 告警。本脚本验证：
 *   1. result.code === -403 + message 含 PAYNOTIFY_DISABLED
 *   2. operation_logs 新增 1 行（action=paynotify.disabled_invocation）
 *      severity=HIGH（因为 event 含 transactionId 模拟外部调用）
 *
 * 当 PAYNOTIFY_DISABLED 解除后（拉卡拉对接完成），本脚本应同步重写为：
 *   - 准备待支付订单
 *   - 调用 payNotify 模拟微信支付回调（mock V3 签名）
 *   - 断言 settlePointsSafe 正确触发 + settleFailed=0
 *
 * 详细解锁条件见 cloudfunctions/payNotify/index.js 顶部注释。
 */
import './setup.mjs'
import { NS, closePool, pgQuery } from './setup.mjs'
import { invokePayNotify } from './helpers/invoke.mjs'
import { cleanupTestData } from './helpers/fixtures.mjs'

let exitCode = 1
let pass = false
const FAKE_TXN_ID = `${NS}_PNTXN_${Date.now()}`

async function main() {
  console.log(`[smoke-paynotify] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)

  // 记录调用前 disabled_invocation 计数
  const beforeRows = await pgQuery(
    `SELECT count(*)::int AS c FROM operation_logs WHERE action = 'paynotify.disabled_invocation' AND target_id = 'EXTERNAL' AND created_at > NOW() - INTERVAL '5 minutes'`
  )
  const beforeCount = Number(beforeRows[0].c)

  // 调 payNotify（模拟外部回调：含 transactionId 触发 severity=HIGH）
  const result = await invokePayNotify({
    orderNo: `${NS}_PN_ORDER`,
    transactionId: FAKE_TXN_ID,
    payAmount: 100,
    paymentMethod: '微信',
  })
  console.log(`  result: ${JSON.stringify(result)}`)

  if (result.code !== -403 || !result.message?.includes('PAYNOTIFY_DISABLED')) {
    console.log(`  ✗ FAIL: 期望 code=-403 + message 含 PAYNOTIFY_DISABLED`)
    return
  }

  // 验证 operation_logs 新增
  const afterRows = await pgQuery(
    `SELECT count(*)::int AS c FROM operation_logs WHERE action = 'paynotify.disabled_invocation' AND target_id = 'EXTERNAL' AND created_at > NOW() - INTERVAL '5 minutes'`
  )
  const delta = Number(afterRows[0].c) - beforeCount
  console.log(`  operation_logs[paynotify.disabled_invocation,EXTERNAL] delta: ${delta}`)
  if (delta !== 1) {
    console.log(`  ✗ FAIL: 期望 operation_logs 新增 1 行，实际 ${delta}`)
    return
  }

  // 验证日志 detail 中能识别外部调用
  const recent = await pgQuery(
    `SELECT detail FROM operation_logs
       WHERE action = 'paynotify.disabled_invocation' AND target_id = 'EXTERNAL'
       ORDER BY id DESC LIMIT 1`
  )
  const detail = recent[0]?.detail
  if (detail?.severity !== 'HIGH') {
    console.log(`  ✗ FAIL: detail.severity 应=HIGH，实际=${detail?.severity}`)
    return
  }

  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — payNotify guard 工作正常（code=-403, operation_log+1, severity=HIGH）`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-paynotify] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  // 清理写入的 operation_logs 行（防累积）
  try {
    await pgQuery(
      `DELETE FROM operation_logs
        WHERE action = 'paynotify.disabled_invocation'
          AND target_id = 'EXTERNAL'
          AND (detail->>'event_keys')::text LIKE $1`,
      [`%${NS}_PN_ORDER%`],
    ).catch(() => null)
    await cleanupTestData(NS)
  } catch (e) {
    console.error('[smoke-paynotify] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-paynotify] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
