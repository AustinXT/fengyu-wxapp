#!/usr/bin/env bun
/**
 * service.start + complete 生命周期冒烟（fixture 直造服务单，独立于 service.create）
 *
 * service.create 路径由 smoke-service-create.mjs 独立守护。
 * 此处用 createTestServiceOrder fixture 直造 PG 记录，跳过业务校验以便测 start/complete 状态机。
 *
 * 验证（状态机插入「待客户确认」步骤后，migration 0053）：
 *   1. service.start: 待服务 → 服务中，记 started_at
 *   2. 服务中状态再调 start 应拒
 *   3. service.complete: 服务中 → 待客户确认，仅记 staff_completed_at，不扣次数（副作用推迟）
 *   4. service.confirm: 待客户确认 → 已完成，原子扣减 remaining_sessions + 记 completed_at
 *   5. service.confirm 幂等（再调一次仍 PASS，不重复扣减）
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

  // ─── 2. service.complete（服务中 → 待客户确认，不扣次数）───
  const completeRes = await invokeStaffApi('service.complete', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId,
  })
  if (completeRes.code !== 0) {
    errors.push(`service.complete 应成功，实际 code=${completeRes.code} msg=${completeRes.message}`)
  } else {
    rec(`  ✓ service.complete OK（→ 待客户确认）`)
  }

  const pendingRow = await pgQuery(
    `SELECT status, completed_at, staff_completed_at FROM service_orders WHERE service_order_id = $1`, [serviceOrderId]
  )
  if (pendingRow[0].status !== '待客户确认') errors.push(`complete 后 status 应='待客户确认'，实际='${pendingRow[0].status}'`)
  if (pendingRow[0].completed_at) errors.push(`complete 后 completed_at 应仍为 NULL（副作用推迟到 confirm）`)
  if (!pendingRow[0].staff_completed_at) errors.push(`complete 后 staff_completed_at 应非 NULL`)

  // complete 不扣次数，remaining 仍=5
  const remainAfterComplete = await pgQuery(`SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1`, [saleItemId])
  if (Number(remainAfterComplete[0].remaining_sessions) !== 5) {
    errors.push(`complete 后 remaining_sessions 应仍=5（未扣），实际=${remainAfterComplete[0].remaining_sessions}`)
  } else {
    rec(`  ✓ complete 未扣次数（仍=5）`)
  }

  // ─── 3. service.confirm（待客户确认 → 已完成，扣次数）───
  const confirmRes = await invokeStaffApi('service.confirm', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId,
  })
  if (confirmRes.code !== 0) {
    errors.push(`service.confirm 应成功，实际 code=${confirmRes.code} msg=${confirmRes.message}`)
  } else {
    rec(`  ✓ service.confirm OK（→ 已完成）`)
  }

  const completedRow = await pgQuery(
    `SELECT status, completed_at FROM service_orders WHERE service_order_id = $1`, [serviceOrderId]
  )
  if (completedRow[0].status !== '已完成') errors.push(`confirm 后 status 应='已完成'，实际='${completedRow[0].status}'`)
  if (!completedRow[0].completed_at) errors.push(`confirm 后 completed_at 应非 NULL`)

  // remaining_sessions 5 → 4
  const remainAfter = await pgQuery(`SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1`, [saleItemId])
  if (Number(remainAfter[0].remaining_sessions) !== 4) {
    errors.push(`confirm 后 remaining_sessions 应=4，实际=${remainAfter[0].remaining_sessions}`)
  } else {
    rec(`  ✓ remaining_sessions 原子扣减 5 → 4`)
  }

  // ─── 4. 幂等：再次 confirm ───
  const idempotentRes = await invokeStaffApi('service.confirm', {
    _testOpenid: TEST_MANAGER_OPENID, serviceOrderId,
  })
  if (idempotentRes.code !== 0) errors.push(`confirm 幂等再调应 PASS，实际 code=${idempotentRes.code}`)
  else rec(`  ✓ confirm 幂等 (${idempotentRes.data.message})`)

  const remainStillAfter = await pgQuery(`SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1`, [saleItemId])
  if (Number(remainStillAfter[0].remaining_sessions) !== 4) {
    errors.push(`幂等 confirm 后 remaining_sessions 应仍=4，实际=${remainStillAfter[0].remaining_sessions}`)
  }

  // ─── 5. service.list — 按 status 过滤 + service.counts 2 桶 + service.detail ───
  // 此服务单当前 status='已完成'，按状态过滤校验：
  //   list(status='已完成') 应含本单；list(status='待服务') 不含；list(status='服务中') 不含
  for (const [filter, shouldContain] of [['已完成', true], ['待服务', false], ['服务中', false]]) {
    const lr = await invokeStaffApi('service.list', {
      _testOpenid: TEST_MANAGER_OPENID,
      status: filter,
      page: 1,
      pageSize: 50,
    })
    if (lr.code !== 0) {
      errors.push(`service.list(status='${filter}') 应成功，实际 code=${lr.code} msg=${lr.message}`)
      continue
    }
    // service.list 顶层就是数组（routes/service.js:779 ctx.result = serviceOrders.map(...)）
    const rows = Array.isArray(lr.data) ? lr.data : []
    const ids = rows.map(x => x.serviceOrderId || x.id)
    const contains = ids.includes(serviceOrderId)
    if (contains !== shouldContain) {
      errors.push(`service.list(status='${filter}') ${shouldContain ? '应' : '不该'}含 ${serviceOrderId}，实际 ids=${JSON.stringify(ids.slice(0, 5))}…`)
    } else {
      rec(`  ✓ service.list(status='${filter}'): ${shouldContain ? '含' : '不含'} ${serviceOrderId}`)
    }
  }

  // service.counts 仅 2 桶（pending/processing，不含已完成 — routes/service.js:1016-1030）
  const cr = await invokeStaffApi('service.counts', { _testOpenid: TEST_MANAGER_OPENID })
  if (cr.code !== 0) {
    errors.push(`service.counts 应成功，实际 code=${cr.code} msg=${cr.message}`)
  } else {
    if (typeof cr.data?.pending !== 'number') errors.push(`counts.pending 应是 number，实际=${typeof cr.data?.pending}`)
    if (typeof cr.data?.processing !== 'number') errors.push(`counts.processing 应是 number，实际=${typeof cr.data?.processing}`)
    rec(`  ✓ service.counts: pending=${cr.data?.pending} processing=${cr.data?.processing}`)
  }

  // service.detail — 按 id 拉本单，断 status/items/staffName 完整
  const dr = await invokeStaffApi('service.detail', { _testOpenid: TEST_MANAGER_OPENID, id: serviceOrderId })
  if (dr.code !== 0) {
    errors.push(`service.detail 应成功，实际 code=${dr.code} msg=${dr.message}`)
  } else {
    if (dr.data?.status !== '已完成') errors.push(`detail.status 应='已完成'，实际='${dr.data?.status}'`)
    if (!dr.data?.staffName) errors.push(`detail.staffName 应非空（JOIN staff_wechat_users）`)
    if (!Array.isArray(dr.data?.items) || dr.data.items.length !== 1) {
      errors.push(`detail.items 应=1 行，实际=${dr.data?.items?.length}`)
    }
    rec(`  ✓ service.detail: status/staffName/items 齐全`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — start + complete + confirm 生命周期 + 幂等 + list/counts/detail 读链路`)
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
