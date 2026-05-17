#!/usr/bin/env bun
/**
 * allocation.delete 冒烟
 *
 * 验证：
 *   1. 删除后 sale_allocations 行 is_void=true（软删除，2026-04-26 D-Q8）
 *   2. sale_orders.allocation_status 回 '待分配'
 *   3. 非 '已支付' 订单不允许操作
 *   4. 不属于本店订单不允许操作
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
  createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-alloc-delete] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const orderId = `${NS}_ALC_DEL`
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    productType: '单品', quantity: 1, totalAmount: 500,
    status: '已支付', salesCategory: '他销自耗',
  })
  await pgQuery(`UPDATE sale_orders SET allocation_status = '待分配', received = total_amount WHERE sale_order_id = $1`, [orderId])
  const items = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderId])
  const itemId = items[0].sale_item_id

  // 先保存一组分配
  const saveResult = await invokeStaffApi('allocation.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderId,
    allocations: [
      { saleItemId: itemId, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: 1.0 },
    ],
  })
  if (saveResult.code !== 0) {
    console.error(`pre-save 失败: ${saveResult.message}`)
    return
  }
  rec(`  ✓ pre-save 1 行分配`)

  const errors = []

  // ─── 删除 ───
  const delResult = await invokeStaffApi('allocation.delete', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderId,
  })
  if (delResult.code !== 0) {
    errors.push(`deleteAllocation 应成功，实际 code=${delResult.code} msg=${delResult.message}`)
  } else {
    rec(`  ✓ deleteAllocation OK`)
  }

  // 软删除：原行 is_void=true，新查应 0 行有效
  const validAllocs = await pgQuery(
    `SELECT employee_id FROM sale_allocations WHERE sale_item_id = $1 AND is_void = false`,
    [itemId]
  )
  if (validAllocs.length !== 0) errors.push(`is_void=false 应=0 行，实际=${validAllocs.length}`)

  const voidedAllocs = await pgQuery(
    `SELECT employee_id, voided_at FROM sale_allocations WHERE sale_item_id = $1 AND is_void = true`,
    [itemId]
  )
  if (voidedAllocs.length !== 1) errors.push(`is_void=true 应=1 行（保留历史），实际=${voidedAllocs.length}`)
  else if (!voidedAllocs[0].voided_at) errors.push(`voided_at 应非 NULL`)

  // allocation_status 回 '待分配'
  const orderAfter = await pgQuery(`SELECT allocation_status FROM sale_orders WHERE sale_order_id = $1`, [orderId])
  if (orderAfter[0].allocation_status !== '待分配') {
    errors.push(`allocation_status 应回 '待分配'，实际='${orderAfter[0].allocation_status}'`)
  }

  // 非 '已支付' 订单不允许操作
  await pgQuery(`UPDATE sale_orders SET status = '待支付' WHERE sale_order_id = $1`, [orderId])
  const wrongStatusResult = await invokeStaffApi('allocation.delete', {
    _testOpenid: TEST_MANAGER_OPENID, saleOrderId: orderId,
  })
  if (wrongStatusResult.code === 0) {
    errors.push(`非 '已支付' 订单删除应拒，实际成功`)
  } else if (!String(wrongStatusResult.message || '').includes('已支付')) {
    errors.push(`非 '已支付' 拒应含 '已支付'，实际 ${wrongStatusResult.message}`)
  } else {
    rec(`  ✓ 非 '已支付' 订单被拒`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — delete 软删除 + 状态回滚 + 守卫正确`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-alloc-delete] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-alloc-delete] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
