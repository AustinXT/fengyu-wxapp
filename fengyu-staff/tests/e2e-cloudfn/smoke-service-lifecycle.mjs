#!/usr/bin/env bun
/**
 * service.start + complete 生命周期冒烟（fixture 直造服务单，独立于 service.create）
 *
 * service.create 路径由 smoke-service-create.mjs 独立守护。
 * 此处用 createTestServiceOrder fixture 直造 PG 记录，跳过业务校验以便测 start/complete 状态机。
 *
 * 验证：
 *   1. service.start: 待服务 → 服务中，记 started_at
 *   2. 服务中状态再调 start 应拒
 *   3. service.complete: 服务中 → 已完成，原子扣减 remaining_sessions
 *   4. service.complete 幂等（再调一次仍 PASS，不重复扣减）
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
  createTestSaleOrder, createTestServiceOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-service-lifecycle] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  // 已支付 销售单 + 疗程卡 sale_item (剩余 5 次)
  const orderId = `${NS}_SVC_LC`
  await createTestSaleOrder({
    saleOrderId: orderId,
    clientUserId: TEST_CLIENT_USER_ID,
    productType: '疗程卡',
    quantity: 1,
    sessionCount: 5,
    totalAmount: 500,
    status: '已支付',
    salesCategory: '他销自耗',
  })
  const items = await pgQuery(`SELECT sale_item_id, remaining_sessions FROM sale_items WHERE sale_order_id = $1`, [orderId])
  const saleItemId = items[0].sale_item_id
  rec(`  ✓ sale: order=${orderId} item=${saleItemId} remaining=5`)

  // 服务单 fixture (绕过 broken service.create)
  const serviceOrderId = `${NS}_SVC_LC_ORD`
  await createTestServiceOrder({
    serviceOrderId,
    status: '待服务',
    items: [{ saleItemId, sessionUsed: 1, employeeId: TEST_MANAGER_EMP_ID, serviceDuration: 60 }],
  })
  rec(`  ✓ service-order: ${serviceOrderId} (待服务)`)

  const errors = []

  // ─── 1. service.start ───
  const startRes = await invokeStaffApi('service.start', {
    _testOpenid: TEST_MANAGER_OPENID,
    serviceOrderId,
  })
  if (startRes.code !== 0) errors.push(`service.start 应成功，实际 code=${startRes.code} msg=${startRes.message}`)
  else rec(`  ✓ service.start OK`)

  const startedRow = await pgQuery(
    `SELECT status, started_at FROM service_orders WHERE service_order_id = $1`,
    [serviceOrderId]
  )
  if (startedRow[0].status !== '服务中') errors.push(`start 后 PG.status 应='服务中'，实际='${startedRow[0].status}'`)
  if (!startedRow[0].started_at) errors.push(`start 后 started_at 应非 NULL`)

  // 非待服务状态再次 start 应拒
  const startAgain = await invokeStaffApi('service.start', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId,
  })
  if (startAgain.code === 0) errors.push(`服务中状态再调 start 应拒，实际成功`)
  else rec(`  ✓ 服务中再 start 被拒（${startAgain.message}）`)

  // ─── 2. service.complete ───
  const completeRes = await invokeStaffApi('service.complete', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId,
  })
  if (completeRes.code !== 0) {
    errors.push(`service.complete 应成功，实际 code=${completeRes.code} msg=${completeRes.message}`)
  } else {
    rec(`  ✓ service.complete OK`)
  }

  const completedRow = await pgQuery(
    `SELECT status, completed_at FROM service_orders WHERE service_order_id = $1`, [serviceOrderId]
  )
  if (completedRow[0].status !== '已完成') errors.push(`complete 后 status 应='已完成'，实际='${completedRow[0].status}'`)
  if (!completedRow[0].completed_at) errors.push(`complete 后 completed_at 应非 NULL`)

  // remaining_sessions 5 → 4
  const remainAfter = await pgQuery(`SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1`, [saleItemId])
  if (Number(remainAfter[0].remaining_sessions) !== 4) {
    errors.push(`complete 后 remaining_sessions 应=4，实际=${remainAfter[0].remaining_sessions}`)
  } else {
    rec(`  ✓ remaining_sessions 原子扣减 5 → 4`)
  }

  // ─── 3. 幂等：再次 complete ───
  const idempotentRes = await invokeStaffApi('service.complete', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId,
  })
  if (idempotentRes.code !== 0) errors.push(`complete 幂等再调应 PASS，实际 code=${idempotentRes.code}`)
  else rec(`  ✓ complete 幂等 (${idempotentRes.data.message})`)

  const remainStillAfter = await pgQuery(`SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1`, [saleItemId])
  if (Number(remainStillAfter[0].remaining_sessions) !== 4) {
    errors.push(`幂等 complete 后 remaining_sessions 应仍=4，实际=${remainStillAfter[0].remaining_sessions}`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — start + complete 生命周期 + 幂等正确`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-service-lifecycle] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-service-lifecycle] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
