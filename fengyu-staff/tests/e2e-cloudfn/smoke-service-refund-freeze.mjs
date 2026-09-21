#!/usr/bin/env bun
/**
 * 在途退款冻结疗程卡 冒烟（Fix A + reject 恢复）
 *
 * 验证：
 *   1. 已支付 疗程卡：未退款时 customer.paidOrders 列出该卡、service.create 可开单
 *   2. createRefund（待审批）后：
 *        a. service.create 被拒（INVALID_STATE: REFUND_IN_PROGRESS）
 *        b. customer.paidOrders 不再列出该卡（整单冻结）
 *   3. rejectRefund 后：customer.paidOrders 重新列出该卡、service.create 恢复成功
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, cleanupTestData, createPaidPayment,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function paidOrdersHasItem(saleItemId) {
  const res = await invokeStaffApi('customer.paidOrders', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  if (res.code !== 0) throw new Error(`paidOrders 失败 code=${res.code} msg=${res.message}`)
  return JSON.stringify(res.data).includes(saleItemId)
}

async function main() {
  rec(`[smoke-service-refund-freeze] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const orderId = `${NS}_FRZ`
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    productName: `${NS}_疗程卡5次`, productType: '疗程卡',
    quantity: 1, sessionCount: 5, totalAmount: 500,
    status: '已支付', salesCategory: '他销自耗',
  })
  await pgQuery(`UPDATE sale_orders SET received = total_amount WHERE sale_order_id = $1`, [orderId])
  // 行级 received / paid_sessions 决定卡包可见性（paid_sessions 是"已退卡消失"的唯一机制）；
  // 款项 + 逐笔受领是退款残值映射的来源。两者缺一，用例会以"卡不显示"或"无法映射"的面目失败。
  await pgQuery(`UPDATE sale_items SET received = 500, paid_sessions = 5 WHERE sale_order_id = $1`, [orderId])
  await createPaidPayment(orderId, { amount: 500, items: [{ saleItemId: `${orderId}_ITEM_1`, amount: 500 }] })
  // 注：createTestSaleOrder 已按单次价语义建 item（疗程卡 unit_real_price = 500/5 = 100）；
  // 退款封顶(0da8122f)按 unit_real_price × 退款次数 算 → 退满 5 次 = 100×5 = 500 = 已收，恰好通过。
  const items = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderId])
  const saleItemId = items[0].sale_item_id
  rec(`  fixture: ${orderId} / ${saleItemId}`)

  const errors = []

  // ─── 1. 退款前：paidOrders 列出该卡 ───
  if (!(await paidOrdersHasItem(saleItemId))) {
    errors.push('退款前 paidOrders 应列出该卡')
  } else {
    rec('  ✓ 退款前 paidOrders 列出该卡')
  }

  // ─── 2. createRefund → 待审批 ───
  const ref = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderId,
    items: [{ saleItemId, refundQuantity: 5 }],
    refundReason: 'e2e_freeze',
  })
  if (ref.code !== 0) {
    errors.push(`createRefund 应成功，实际 code=${ref.code} msg=${ref.message}`)
  }
  const paymentId = ref.data?.paymentId

  // 2a. service.create 被拒
  const blocked = await invokeStaffApi('service.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ saleItemId, sessionUsed: 1, employeeId: TEST_MANAGER_EMP_ID, serviceDuration: 60 }],
  })
  if (blocked.code === 0) {
    errors.push('退款审批中 service.create 应被拒，实际成功')
  } else if (!String(blocked.message || '').includes('退款审批中')) {
    errors.push(`拒绝消息应含 '退款审批中'，实际 ${blocked.message}`)
  } else {
    rec(`  ✓ 退款审批中 service.create 被拒（${blocked.message}）`)
  }

  // 2b. paidOrders 不再列出该卡
  if (await paidOrdersHasItem(saleItemId)) {
    errors.push('退款审批中 paidOrders 不应再列出该卡')
  } else {
    rec('  ✓ 退款审批中 paidOrders 已排除该卡')
  }

  // ─── 3. rejectRefund → 恢复 ───
  const rej = await invokeStaffApi('order.rejectRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    paymentId,
    auditRemark: 'e2e_reject',
  })
  if (rej.code !== 0) {
    errors.push(`rejectRefund 应成功，实际 code=${rej.code} msg=${rej.message}`)
  }

  if (!(await paidOrdersHasItem(saleItemId))) {
    errors.push('驳回退款后 paidOrders 应重新列出该卡')
  } else {
    rec('  ✓ 驳回后 paidOrders 重新列出该卡')
  }

  const ok = await invokeStaffApi('service.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ saleItemId, sessionUsed: 1, employeeId: TEST_MANAGER_EMP_ID, serviceDuration: 60 }],
  })
  if (ok.code !== 0) {
    errors.push(`驳回后 service.create 应恢复成功，实际 code=${ok.code} msg=${ok.message}`)
  } else {
    rec('  ✓ 驳回后 service.create 恢复成功')
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec('  ✅ PASS — 在途退款冻结 + 驳回恢复 正确')
}

try {
  await main()
} catch (e) {
  console.error('[smoke-service-refund-freeze] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-service-refund-freeze] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
