#!/usr/bin/env bun
/**
 * allocation.savePayment 冒烟（按回款逐笔分配，spai 模型）
 *
 * 验证：
 *   1. 超额分池（同 saleItemId+roleType 池 Σ > spai 可分配额）被拒
 *   2. 非法 ratio（0.15，非整十）被拒
 *   3. 同 (saleItemId, employeeId, roleType) 重复被拒
 *   4. 正常保存（70% + 30% = 100%）→ sale_order_payments.allocation_status='已分配'
 *   5. PG 落库：sale_allocations 2 行（is_void=false），total_amount=base×ratio，
 *      commission_rate/commission_amount 非 NULL 且 = total×rate（提成固化快照）
 *   6. sale_orders.allocation_status 汇总位='已分配'
 *
 * 新模型 fixture：造一笔已支付回款（sale_order_payments.allocation_status='待分配'）
 *   + sale_payment_allocatable_items 行（可分配基数 amount），savePayment 以 salePaymentId 为粒度。
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, ensureTestCommissionMatrix,
  createTestStaff, createTestClient,
  createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

/**
 * 造一笔已支付回款（待分配）+ 每项一行 sale_payment_allocatable_items（可分配基数）。
 * 返回 salePaymentId（sale_order_payments.id）。
 */
async function createPaymentWithSpai({ saleOrderId, items, amount, paidAt = null }) {
  const payRows = await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, status, source_end,
       operator_employee_id, paid_at, allocation_status, created_at
     )
     VALUES ($1, '首次支付'::payment_change_type, $2, '线下'::payment_method,
             '已支付'::payment_flow_status, 'staff'::payment_source_end,
             $3, COALESCE($4, NOW()), '待分配'::allocation_status, NOW())
     RETURNING id`,
    [saleOrderId, amount, TEST_MANAGER_EMP_ID, paidAt]
  )
  const paymentId = payRows[0].id
  for (const it of items) {
    await pgQuery(
      `INSERT INTO sale_payment_allocatable_items
         (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
       VALUES ($1, $2, $3, $4, $5::sales_category, NOW())`,
      [paymentId, saleOrderId, it.saleItemId, it.amount, it.salesCategory]
    )
  }
  return paymentId
}

async function main() {
  rec(`[smoke-alloc-save] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await ensureTestCommissionMatrix() // 注入提成矩阵 → commission_rate 非 0，强化提成快照断言
  await createTestStaff() // manager + 美容师 skill
  // 第二位员工（美容师）
  await createTestStaff({
    employeeId: `${NS}_BEAU2`,
    openid: `${NS}_BEAU2_OPENID`,
    phone: '19999098004',
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
  const items = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderId])
  const itemId = items[0].sale_item_id
  const paymentId = await createPaymentWithSpai({
    saleOrderId: orderId,
    amount: 1000,
    items: [{ saleItemId: itemId, amount: 1000, salesCategory: '他销自耗' }],
  })
  rec(`  ✓ fixture: order=${orderId} item=${itemId} paymentId=${paymentId}`)

  const errors = []

  // ─── 1. 超额分池被拒（50% + 60% = 110% > 可分配额 1000）───
  const overflowResult = await invokeStaffApi('allocation.savePayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: paymentId,
    allocations: [
      { saleItemId: itemId, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: 0.5 },
      { saleItemId: itemId, employeeId: `${NS}_BEAU2`, roleType: '美容师', allocationRatio: 0.6 },
    ],
  })
  if (overflowResult.code === 0) {
    errors.push(`超额（110%）应拒，实际成功`)
  } else if (!String(overflowResult.message || '').includes('合计超过')) {
    errors.push(`超额拒应含 '合计超过'，实际 ${overflowResult.message}`)
  } else {
    rec(`  ✓ 超额池被拒（${overflowResult.message}）`)
  }

  // ─── 2. 非法 ratio（0.15）被拒 ───
  const invalidRatioResult = await invokeStaffApi('allocation.savePayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: paymentId,
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
  const dupResult = await invokeStaffApi('allocation.savePayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: paymentId,
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
  const okResult = await invokeStaffApi('allocation.savePayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    salePaymentId: paymentId,
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

  // ─── 5. PG 校验（按 salePaymentId 精确查本笔回款分配）───
  const allocs = await pgQuery(
    `SELECT employee_id, role_type, allocation_ratio, total_amount, commission_rate, commission_amount, is_void
     FROM sale_allocations WHERE sale_payment_id = $1 AND is_void = false ORDER BY employee_id`,
    [paymentId]
  )
  if (allocs.length !== 2) errors.push(`sale_allocations 应=2 行（有效），实际=${allocs.length}`)
  else {
    const sum = allocs.reduce((s, a) => s + Number(a.total_amount), 0)
    if (Math.abs(sum - 1000) > 0.01) errors.push(`分配金额合计应=1000（spai 基数），实际=${sum}`)
    // §3.15 销售提成固化快照：保存时写入 commission_rate / commission_amount（非 NULL，矩阵已注入故非 0）
    for (const a of allocs) {
      if (a.commission_amount == null) errors.push(`commission_amount 不应为 NULL（emp=${a.employee_id}）`)
      if (Number(a.commission_rate || 0) <= 0) errors.push(`commission_rate 应>0（矩阵已注入），实际=${a.commission_rate}（emp=${a.employee_id}）`)
      const expected = Math.round(Number(a.total_amount) * Number(a.commission_rate || 0) * 100) / 100
      if (Math.abs(Number(a.commission_amount) - expected) > 0.01) {
        errors.push(`commission_amount 应=份额×费率=${expected}，实际=${a.commission_amount}（rate=${a.commission_rate}）`)
      }
    }
  }

  // ─── 6. 状态位（回款级 + 订单级汇总）───
  const payAfter = await pgQuery(
    `SELECT allocation_status FROM sale_order_payments WHERE id = $1`, [paymentId]
  )
  if (payAfter[0].allocation_status !== '已分配') {
    errors.push(`sale_order_payments.allocation_status 应='已分配'，实际='${payAfter[0].allocation_status}'`)
  }
  const orderAfter = await pgQuery(
    `SELECT allocation_status FROM sale_orders WHERE sale_order_id = $1`, [orderId]
  )
  if (orderAfter[0].allocation_status !== '已分配') {
    errors.push(`sale_orders.allocation_status 汇总位应='已分配'，实际='${orderAfter[0].allocation_status}'`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — savePayment 4 项守卫（超额/非整十/重复/正常）+ PG 落库正确`)
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
