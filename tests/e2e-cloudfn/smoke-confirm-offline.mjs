#!/usr/bin/env bun
/**
 * P0-15-01b 核心冒烟：staffApi 店长 confirmOffline → 积分发放 SQL 无错
 *
 * 验证链：
 *   1. 准备：店长 + 顾客 + 待确认收款销售单（300 元，对应应得 3 积分）
 *   2. 调用 staffApi.order.confirmOffline（_testOpenid 走测试模式）
 *   3. 断言：
 *      - result.code === 0
 *      - point_transactions 增 1 行 (type='消费赠送', amount=3, ref_order_id=订单)
 *      - client_wechat_users.points_balance += 3
 *      - operation_logs WHERE action='points.settleFailed' AND target_id=订单 应为 0
 *        （这是 P0-15-01b 的核心：积分结算 SQL 不能报错）
 *
 * 失败时输出 diff + result + 相关日志便于定位。
 */
import './setup.mjs'
import {
  NS,
  TEST_STORE_ID, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID,
  TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient, createTestSaleOrder,
  cleanupTestData,
} from './helpers/fixtures.mjs'
import { snapshot, diff, fmtDiff } from './helpers/pg-snapshot.mjs'

const ORDER_ID = `${NS}_OCO` // OrderConfirmOffline，受 sale_order_id varchar(30) 限制
const TOTAL_AMOUNT = 300 // → expected 积分 = floor(300/100) = 3

let pass = false
let exitCode = 1
let details = []

function rec(line) {
  details.push(line)
  console.log(line)
}

async function main() {
  rec(`[smoke-confirm-offline] start | ${new Date().toISOString()}`)

  // ─── 1. 清理 + 建 fixture ───
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // 店长（manager）
  await createTestClient({ pointsBalance: 0 })
  await createTestSaleOrder({
    saleOrderId: ORDER_ID,
    clientUserId: TEST_CLIENT_USER_ID,
    totalAmount: TOTAL_AMOUNT,
    status: '待确认收款',
    paymentMethod: '线下',
  })
  rec(`  ✓ fixtures ready: store=${TEST_STORE_ID} manager=${TEST_MANAGER_EMP_ID} order=${ORDER_ID} (¥${TOTAL_AMOUNT})`)

  // ─── 2. snapshot before ───
  const snapSpec = {
    point_transactions: {
      where: 'ref_order_id = $1 OR user_id = $2',
      params: [ORDER_ID, TEST_CLIENT_USER_ID],
    },
    client_wechat_users: {
      where: 'user_id = $1',
      params: [TEST_CLIENT_USER_ID],
    },
    operation_logs: {
      where: `action = 'points.settleFailed' AND target_id = $1`,
      params: [ORDER_ID],
    },
    sale_orders: { where: 'sale_order_id = $1', params: [ORDER_ID] },
    sale_order_payments: { where: 'sale_order_id = $1', params: [ORDER_ID] },
  }
  const before = await snapshot(snapSpec)
  rec(`  ✓ snapshot before: points_balance=${before.client_wechat_users[0]?.points_balance}`)

  // ─── 3. invoke staffApi.order.confirmOffline ───
  const result = await invokeStaffApi('order.confirmOffline', {
    saleOrderId: ORDER_ID,
    _testOpenid: TEST_MANAGER_OPENID,
  })
  rec(`  result: ${JSON.stringify(result)}`)

  if (result.code !== 0) {
    rec(`  ✗ FAIL: 期望 code=0, 实际 ${result.code} (${result.message})`)
    return
  }

  // ─── 4. snapshot after + diff ───
  const after = await snapshot(snapSpec)
  const d = diff(before, after)
  rec(`  diff:\n${fmtDiff(d)}`)

  // ─── 5. 关键断言 ───
  const errors = []

  // 5.1 settleFailed log 必须为 0
  const settleFailedRows = after.operation_logs
  if (settleFailedRows.length !== 0) {
    errors.push(
      `[CORE] operation_logs[action=points.settleFailed,target=${ORDER_ID}] 应为 0 行，实际 ${settleFailedRows.length}` +
      `\n      详情: ${JSON.stringify(settleFailedRows.map((r) => r.detail))}`
    )
  }

  // 5.2 point_transactions 增 1 行
  const ptDiff = d.point_transactions
  if (ptDiff.added !== 1) {
    errors.push(`point_transactions 应增 1 行（消费赠送/3），实际 +${ptDiff.added}`)
  } else {
    const newPt = ptDiff.addedRows[0]
    if (newPt.ref_order_id !== ORDER_ID) errors.push(`point_transactions.ref_order_id 应=${ORDER_ID}, 实际=${newPt.ref_order_id}`)
    if (newPt.user_id !== TEST_CLIENT_USER_ID) errors.push(`point_transactions.user_id 应=${TEST_CLIENT_USER_ID}, 实际=${newPt.user_id}`)
    if (newPt.type !== '消费赠送') errors.push(`point_transactions.type 应='消费赠送', 实际='${newPt.type}'`)
    if (Number(newPt.amount) !== 3) errors.push(`point_transactions.amount 应=3（floor(300/100)）, 实际=${newPt.amount}`)
  }

  // 5.3 client_wechat_users.points_balance += 3
  const balBefore = Number(before.client_wechat_users[0]?.points_balance ?? 0)
  const balAfter = Number(after.client_wechat_users[0]?.points_balance ?? 0)
  if (balAfter - balBefore !== 3) {
    errors.push(`points_balance 应 +3，实际 ${balBefore} → ${balAfter}（delta=${balAfter - balBefore}）`)
  }

  // 5.4 订单状态 → '已支付'
  const ordAfter = after.sale_orders[0]
  if (ordAfter?.status !== '已支付') {
    errors.push(`sale_orders.status 应='已支付'，实际='${ordAfter?.status}'`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 积分发放正确（+3），settleFailed 日志为 0，订单转 '已支付'`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-confirm-offline] EXCEPTION:', e)
  if (e?.stack) console.error(e.stack)
} finally {
  // 清理 — 即使失败也清，避免污染
  try {
    await cleanupTestData(NS)
  } catch (e) {
    console.error('[smoke-confirm-offline] cleanup error:', e.message)
  }
  await closePool()
  console.log(`[smoke-confirm-offline] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
