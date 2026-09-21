#!/usr/bin/env bun
/**
 * allocation.deletePaymentAllocation 冒烟（按回款逐笔分配，spai 模型）
 *
 * 验证：
 *   1. 删除后 sale_payment_item_allocations 行 is_void=true（软删除）；有效行 0、作废行 1（保留历史）
 *   2. sale_order_payments.allocation_status 回 '待分配'（CAS '已分配'→'待分配'）
 *   3. sale_orders.allocation_status 汇总位回 '待分配'
 *   4. 重复删除（已是 '待分配'）被状态机拒（INVALID_STATE: STATE_TRANSITION_BLOCKED）
 *
 * 新模型 fixture：先造待分配回款 + spai，savePayment 置 '已分配'，再 deletePaymentAllocation。
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

async function createPaymentWithSpai({ saleOrderId, items, amount }) {
  const payRows = await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, status, source_end,
       operator_employee_id, paid_at, allocation_status, created_at
     )
     VALUES ($1, '首次支付'::payment_change_type, $2, '线下'::payment_method,
             '已支付'::payment_flow_status, 'staff'::payment_source_end,
             $3, NOW(), '待分配'::allocation_status, NOW())
     RETURNING id`,
    [saleOrderId, amount, TEST_MANAGER_EMP_ID]
  )
  const paymentId = payRows[0].id
  for (const it of items) {
    await pgQuery(
      `INSERT INTO sale_payment_item_receipts
         (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
       VALUES ($1, $2, $3, $4, $5::sales_category, NOW())`,
      [paymentId, saleOrderId, it.saleItemId, it.amount, it.salesCategory]
    )
  }
  return paymentId
}

async function main() {
  rec(`[smoke-alloc-delete] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const orderId = `${NS}_ALC_DEL`
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    productType: '疗程卡', quantity: 1, totalAmount: 500,
    status: '已支付', salesCategory: '他销自耗',
  })
  await pgQuery(`UPDATE sale_orders SET allocation_status = '待分配', received = total_amount WHERE sale_order_id = $1`, [orderId])
  const items = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderId])
  const itemId = items[0].sale_item_id
  const paymentId = await createPaymentWithSpai({
    saleOrderId: orderId, amount: 500,
    items: [{ saleItemId: itemId, amount: 500, salesCategory: '他销自耗' }],
  })

  // 先保存一组分配（置回款为 '已分配'，delete 前置态）
  const saveResult = await invokeStaffApi('allocation.savePayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: paymentId,
    allocations: [
      { saleItemId: itemId, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: 1.0 },
    ],
  })
  if (saveResult.code !== 0) {
    console.error(`pre-save 失败: ${saveResult.message}`)
    return
  }
  rec(`  ✓ pre-save 1 行分配（paymentId=${paymentId}）`)

  const errors = []

  // ─── 删除 ───
  const delResult = await invokeStaffApi('allocation.deletePaymentAllocation', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: paymentId,
  })
  if (delResult.code !== 0) {
    errors.push(`deletePaymentAllocation 应成功，实际 code=${delResult.code} msg=${delResult.message}`)
  } else {
    rec(`  ✓ deletePaymentAllocation OK`)
  }

  // 软删除：原行 is_void=true，新查应 0 行有效
  // 分配行落在 sale_payment_item_allocations，经 sale_payment_item_receipt_id 关联回款，
  // 表里没有 sale_payment_id 列 —— 查 sale_allocations 会永远得 0 行（那是订单维度的旧模型表）。
  const validAllocs = await pgQuery(
    `SELECT a.employee_id
       FROM sale_payment_item_allocations a
       JOIN sale_payment_item_receipts r ON r.id = a.sale_payment_item_receipt_id
      WHERE r.sale_payment_id = $1 AND a.is_void = false`,
    [paymentId]
  )
  if (validAllocs.length !== 0) errors.push(`is_void=false 应=0 行，实际=${validAllocs.length}`)

  const voidedAllocs = await pgQuery(
    `SELECT a.employee_id, a.voided_at
       FROM sale_payment_item_allocations a
       JOIN sale_payment_item_receipts r ON r.id = a.sale_payment_item_receipt_id
      WHERE r.sale_payment_id = $1 AND a.is_void = true`,
    [paymentId]
  )
  if (voidedAllocs.length !== 1) errors.push(`is_void=true 应=1 行（保留历史），实际=${voidedAllocs.length}`)
  else if (!voidedAllocs[0].voided_at) errors.push(`voided_at 应非 NULL`)

  // sale_order_payments.allocation_status 回 '待分配'
  const payAfter = await pgQuery(`SELECT allocation_status FROM sale_order_payments WHERE id = $1`, [paymentId])
  if (payAfter[0].allocation_status !== '待分配') {
    errors.push(`sale_order_payments.allocation_status 应回 '待分配'，实际='${payAfter[0].allocation_status}'`)
  }

  // sale_orders 汇总位回 '待分配'
  const orderAfter = await pgQuery(`SELECT allocation_status FROM sale_orders WHERE sale_order_id = $1`, [orderId])
  if (orderAfter[0].allocation_status !== '待分配') {
    errors.push(`sale_orders.allocation_status 汇总位应回 '待分配'，实际='${orderAfter[0].allocation_status}'`)
  }

  // ─── 状态机守卫：已是 '待分配' 的回款不可再删（CAS 仅 '已分配'→'待分配'）───
  const doubleDelResult = await invokeStaffApi('allocation.deletePaymentAllocation', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: paymentId,
  })
  if (doubleDelResult.code === 0) {
    errors.push(`'待分配' 回款重复删除应被状态机拒，实际成功`)
  } else if (!String(doubleDelResult.message || '').includes('STATE_TRANSITION_BLOCKED')) {
    errors.push(`重复删除拒应含 'STATE_TRANSITION_BLOCKED'，实际 ${doubleDelResult.message}`)
  } else {
    rec(`  ✓ '待分配' 回款重复删除被状态机拒`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — deletePaymentAllocation 软删除 + 状态回滚 + CAS 状态机守卫正确`)
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
