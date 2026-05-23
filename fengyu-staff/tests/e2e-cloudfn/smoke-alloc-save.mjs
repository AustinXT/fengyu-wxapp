#!/usr/bin/env bun
/**
 * allocation.save 冒烟
 *
 * 验证：
 *   1. 已支付 + 待分配 订单可保存提成分配
 *   2. 多员工 per-item × per-role_type 分池，比例合计不超 100% × received
 *   3. 保存后 sale_orders.allocation_status='已分配'
 *   4. sale_allocations 写入正确（is_void=false, total_amount=received×ratio）
 *   5. 超额分配（>100% pool）被拒
 *   6. 同 saleItemId+employeeId+roleType 重复被拒
 *   7. invalid ratio（如 0.15）被拒
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
  rec(`[smoke-alloc-save] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // manager + 美容师 skill
  // 第二位员工（美容师）
  await createTestStaff({
    employeeId: `${NS}_BEAU2`,
    openid: `${NS}_BEAU2_OPENID`,
    phone: '19999099004',
    name: `${NS}_美容师2`,
    isManager: false,
    positionName: '美容师',
    skills: ['美容师'],
  })
  await createTestClient()

  const orderId = `${NS}_ALC_SAVE`
  await createTestSaleOrder({
    saleOrderId: orderId,
    clientUserId: TEST_CLIENT_USER_ID,
    productName: `${NS}_测试单品`,
    productType: '疗程卡',
    quantity: 1,
    totalAmount: 1000,
    status: '已支付',
    salesCategory: '他销自耗',
  })
  await pgQuery(
    `UPDATE sale_orders SET allocation_status = '待分配', received = total_amount WHERE sale_order_id = $1`,
    [orderId]
  )
  const items = await pgQuery(`SELECT sale_item_id, received FROM sale_items WHERE sale_order_id = $1`, [orderId])
  const itemId = items[0].sale_item_id
  const received = Number(items[0].received)
  rec(`  ✓ fixture: order=${orderId} item=${itemId} received=${received}`)

  const errors = []

  // ─── 1. 超额分池被拒（50% + 60% = 110%）───
  const overflowResult = await invokeStaffApi('allocation.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderId,
    allocations: [
      { saleItemId: itemId, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: 0.5 },
      { saleItemId: itemId, employeeId: `${NS}_BEAU2`, roleType: '美容师', allocationRatio: 0.6 },
    ],
  })
  if (overflowResult.code === 0) {
    errors.push(`超额（110%）应拒，实际成功`)
  } else if (!String(overflowResult.message || '').includes('合计超过')) {
    errors.push(`超额拒应含 '合计超过商品金额'，实际 ${overflowResult.message}`)
  } else {
    rec(`  ✓ 超额池被拒（${overflowResult.message}）`)
  }

  // ─── 2. 非法 ratio（0.15）被拒 ───
  const invalidRatioResult = await invokeStaffApi('allocation.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderId,
    allocations: [
      { saleItemId: itemId, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: 0.15 },
    ],
  })
  if (invalidRatioResult.code === 0) {
    errors.push(`非整十比例（0.15）应拒，实际成功`)
  } else if (!String(invalidRatioResult.message || '').includes('整十')) {
    errors.push(`非整十拒应含 '整十百分比'，实际 ${invalidRatioResult.message}`)
  } else {
    rec(`  ✓ 非整十比例被拒`)
  }

  // ─── 3. 重复 (saleItemId, employeeId, roleType) 被拒 ───
  const dupResult = await invokeStaffApi('allocation.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderId,
    allocations: [
      { saleItemId: itemId, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: 0.5 },
      { saleItemId: itemId, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: 0.3 },
    ],
  })
  if (dupResult.code === 0) {
    errors.push(`重复 (item,emp,role) 应拒，实际成功`)
  } else if (!String(dupResult.message || '').includes('重复')) {
    errors.push(`重复拒应含 '重复'，实际 ${dupResult.message}`)
  } else {
    rec(`  ✓ 重复 (item,emp,role) 被拒`)
  }

  // ─── 4. 正常保存（70% + 30% = 100%）───
  const okResult = await invokeStaffApi('allocation.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderId,
    allocations: [
      { saleItemId: itemId, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: 0.7 },
      { saleItemId: itemId, employeeId: `${NS}_BEAU2`, roleType: '美容师', allocationRatio: 0.3 },
    ],
  })
  if (okResult.code !== 0) {
    errors.push(`正常保存应成功，实际 code=${okResult.code} msg=${okResult.message}`)
  } else {
    rec(`  ✓ 正常保存 allocationCount=${okResult.data.allocationCount}`)
    if (okResult.data.allocationCount !== 2) errors.push(`allocationCount 应=2，实际=${okResult.data.allocationCount}`)
  }

  // ─── 5. PG 校验 ───
  const allocs = await pgQuery(
    `SELECT employee_id, role_type, allocation_ratio, total_amount, is_void
     FROM sale_allocations WHERE sale_item_id = $1 AND is_void = false ORDER BY employee_id`,
    [itemId]
  )
  if (allocs.length !== 2) errors.push(`sale_allocations 应=2 行（有效），实际=${allocs.length}`)
  else {
    const sum = allocs.reduce((s, a) => s + Number(a.total_amount), 0)
    if (Math.abs(sum - 1000) > 0.01) errors.push(`分配金额合计应=1000（received），实际=${sum}`)
  }

  const orderAfter = await pgQuery(
    `SELECT allocation_status FROM sale_orders WHERE sale_order_id = $1`, [orderId]
  )
  if (orderAfter[0].allocation_status !== '已分配') {
    errors.push(`allocation_status 应='已分配'，实际='${orderAfter[0].allocation_status}'`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — save 4 项守卫（超额/非整十/重复/正常）+ PG 落库正确`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-alloc-save] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-alloc-save] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
