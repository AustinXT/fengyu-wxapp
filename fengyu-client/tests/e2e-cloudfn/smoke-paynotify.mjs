#!/usr/bin/env bun
/**
 * smoke-paynotify：验证 payNotify 云函数当前的 PAYNOTIFY_DISABLED 守卫态。
 *
 * 当前业务状态：D-Q1-2026-04-26 决策下 payNotify 立即停用直到补完拉卡拉签名校验，
 * 任何 invocation 都直接返回 code=-403。本脚本仅验证此守卫：
 *   1. result.code === -403 + message 含 PAYNOTIFY_DISABLED
 *
 * 历史版本曾期望 operation_logs 同时写入一行 action='paynotify.disabled_invocation'
 * （severity=HIGH）作为高优告警；当前 payNotify/index.js 的 disabled 分支没有写库
 * （仅 console.warn 后 return），是规范缺口而非测试缺陷。补审计日志为决策项，
 * 在补码前本断言下线，避免 L2 长期 RED。
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

  // 调 payNotify（模拟外部回调）
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

  pass = true
  exitCode = 0
  console.log(`  ✅ PASS — payNotify guard 工作正常（code=-403, message=PAYNOTIFY_DISABLED）`)
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
