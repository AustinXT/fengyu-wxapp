#!/usr/bin/env bun
/**
 * 分配结果 3 天冻结 冒烟（仅约束员工端店长；admin 后台不受限，不在本测试范围）
 *
 * 验证两条写路径在超过冻结窗口（FREEZE_DAYS=3）后被拒、窗口内放行：
 *   A. allocation.save —— 锚点 sale_orders.paid_at
 *        A1. paid_at = 4 天前 → 拒（INVALID_STATE: ALLOCATION_FROZEN）
 *        A2. paid_at = 1 天前 → 放行（正常保存）
 *   B. serviceCommission.save —— 锚点 service_orders.completed_at
 *        B1. completed_at = 4 天前 → 拒（ALLOCATION_FROZEN，gate 在清空分支之前）
 *        B2. completed_at = 1 天前 → 放行（清空提成成功）
 *
 * 冻结闸门位于状态校验之后、业务校验之前，故拒绝路径无需构造合法分配明细。
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
  rec(`[smoke-allocation-freeze] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const errors = []

  // ───────────────────────────────────────────────────────────────
  // A. allocation.save — paid_at 锚点
  // ───────────────────────────────────────────────────────────────
  const saleOrderId = `${NS}_FRZ_SALE`
  await createTestSaleOrder({
    saleOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    productName: `${NS}_冻结测试单`,
    productType: '疗程卡',
    quantity: 1,
    totalAmount: 1000,
    status: '已支付',
    salesCategory: '他销自耗',
  })
  await pgQuery(
    `UPDATE sale_orders SET allocation_status = '待分配', received = total_amount WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  await pgQuery(`UPDATE sale_items SET received = sale_amount WHERE sale_order_id = $1`, [saleOrderId])
  const saleItems = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [saleOrderId])
  const saleItemId = saleItems[0].sale_item_id

  const saleAlloc = [
    { saleItemId, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: 1.0 },
  ]

  // A1. paid_at 4 天前 → 冻结拒绝
  await pgQuery(`UPDATE sale_orders SET paid_at = NOW() - INTERVAL '4 days' WHERE sale_order_id = $1`, [saleOrderId])
  const a1 = await invokeStaffApi('allocation.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId,
    allocations: saleAlloc,
  })
  if (a1.code === 0) {
    errors.push('A1: paid_at 超 3 天应拒，实际成功')
  } else if (!String(a1.message || '').includes('冻结')) {
    errors.push(`A1: 拒绝消息应含 '冻结'，实际 code=${a1.code} msg=${a1.message}`)
  } else {
    rec(`  ✓ A1 超期销售单分配被拒（${a1.message}）`)
  }

  // A2. paid_at 1 天前 → 放行
  await pgQuery(`UPDATE sale_orders SET paid_at = NOW() - INTERVAL '1 day' WHERE sale_order_id = $1`, [saleOrderId])
  const a2 = await invokeStaffApi('allocation.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId,
    allocations: saleAlloc,
  })
  if (a2.code !== 0) {
    errors.push(`A2: paid_at 1 天前应放行，实际 code=${a2.code} msg=${a2.message}`)
  } else {
    rec(`  ✓ A2 窗口内销售单分配放行 allocationCount=${a2.data?.allocationCount}`)
  }

  // ───────────────────────────────────────────────────────────────
  // B. serviceCommission.save — completed_at 锚点
  // ───────────────────────────────────────────────────────────────
  const serviceOrderId = `${NS}_FRZ_SVC`
  await createTestServiceOrder({
    serviceOrderId,
    status: '服务中',
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{
      saleItemId,
      employeeId: TEST_MANAGER_EMP_ID,
      sessionUsed: 1,
      unitRealPrice: 100,
      salesCategory: '他销自耗',
    }],
  })
  // 翻到已完成 + 待分配（提成手动分配前置态）
  await pgQuery(
    `UPDATE service_orders SET status = '已完成', commission_status = '待分配' WHERE service_order_id = $1`,
    [serviceOrderId]
  )

  // B1. completed_at 4 天前 → 冻结拒绝（送空数组亦应在 gate 处被拦）
  await pgQuery(`UPDATE service_orders SET completed_at = NOW() - INTERVAL '4 days' WHERE service_order_id = $1`, [serviceOrderId])
  const b1 = await invokeStaffApi('serviceCommission.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    serviceOrderId,
    commissions: [],
  })
  if (b1.code === 0) {
    errors.push('B1: completed_at 超 3 天应拒，实际成功')
  } else if (!String(b1.message || '').includes('冻结')) {
    errors.push(`B1: 拒绝消息应含 '冻结'，实际 code=${b1.code} msg=${b1.message}`)
  } else {
    rec(`  ✓ B1 超期服务单提成被拒（${b1.message}）`)
  }

  // B2. completed_at 1 天前 → 放行（清空提成成功）
  await pgQuery(`UPDATE service_orders SET completed_at = NOW() - INTERVAL '1 day' WHERE service_order_id = $1`, [serviceOrderId])
  const b2 = await invokeStaffApi('serviceCommission.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    serviceOrderId,
    commissions: [],
  })
  if (b2.code !== 0) {
    errors.push(`B2: completed_at 1 天前应放行，实际 code=${b2.code} msg=${b2.message}`)
  } else {
    rec(`  ✓ B2 窗口内服务单提成放行（${b2.message || 'ok'}）`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec('  ✅ PASS — 销售单(paid_at)/服务单(completed_at) 3 天冻结闸门 双向正确')
}

try {
  await main()
} catch (e) {
  console.error('[smoke-allocation-freeze] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-allocation-freeze] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
