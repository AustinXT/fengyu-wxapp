#!/usr/bin/env bun
/** 回款级营业额分配：4 名不同员工同池保存、重新加载与原有校验。 */
import './setup.mjs'
import assert from 'node:assert/strict'
import {
  NS, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool, testPhone,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

const saleOrderId = `${NS}_ALLOC_4`
const employeeIds = [1, 2, 3, 4].map((i) => `${NS}_ALLOC_E${i}`)
let passed = false

try {
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  for (const [index, employeeId] of employeeIds.entries()) {
    await createTestStaff({
      employeeId,
      openid: `${NS}_ALLOC_O${index + 1}`,
      phone: testPhone(index + 3),
      name: `${NS}_分配员工${index + 1}`,
      isManager: false,
      skills: ['养生师'],
    })
  }

  const { saleItemId } = await createTestSaleOrder({
    saleOrderId, clientUserId: TEST_CLIENT_USER_ID,
    productName: `${NS}_四人分配`, totalAmount: 1000,
    status: '已支付', salesCategory: '自销自耗',
  })
  await pgQuery('UPDATE sale_orders SET received = 1000 WHERE sale_order_id = $1', [saleOrderId])
  await pgQuery('UPDATE sale_items SET received = 1000 WHERE sale_item_id = $1', [saleItemId])
  const [{ id: salePaymentId }] = await pgQuery(
    `INSERT INTO sale_order_payments
      (sale_order_id, change_type, amount, payment_method, status, source_end,
       operator_employee_id, paid_at, allocation_status, created_at)
     VALUES ($1, '首次支付'::payment_change_type, 1000, '线下'::payment_method,
       '已支付'::payment_flow_status, 'staff'::payment_source_end,
       $2, NOW(), '待分配'::allocation_status, NOW()) RETURNING id`,
    [saleOrderId, TEST_MANAGER_EMP_ID],
  )
  await pgQuery(
    `INSERT INTO sale_payment_item_receipts
      (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
     VALUES ($1, $2, $3, 1000, '自销自耗'::sales_category, NOW())`,
    [salePaymentId, saleOrderId, saleItemId],
  )

  const allocations = employeeIds.map((employeeId) => ({
    saleItemId, employeeId, roleType: '养生师', allocationRatio: 0.25,
  }))
  const payload = { _testOpenid: TEST_MANAGER_OPENID, salePaymentId, allocations }
  const saved = await invokeStaffApi('allocation.savePayment', payload)
  assert.equal(saved.code, 0, `4 人合法分配应保存：${saved.message}`)
  assert.equal(saved.data?.allocationCount, 4)

  const reloaded = await invokeStaffApi('allocation.suggestPayment', {
    _testOpenid: TEST_MANAGER_OPENID, salePaymentId,
  })
  assert.equal(reloaded.code, 0, `重新加载应成功：${reloaded.message}`)
  const existing = reloaded.data?.existingAllocations || []
  assert.deepEqual(existing.map((row) => row.employee_id).sort(), [...employeeIds].sort())
  assert.deepEqual(existing.map((row) => Number(row.allocation_ratio)), [0.25, 0.25, 0.25, 0.25])
  assert.deepEqual(existing.map((row) => Number(row.total_amount)), [250, 250, 250, 250])

  const invalidCases = [
    ['比例超额', allocations.map((row) => ({ ...row, allocationRatio: 0.3 }))],
    ['重复员工', [{ ...allocations[0] }, { ...allocations[0] }, allocations[1], allocations[2]]],
    ['无效比例', [{ ...allocations[0], allocationRatio: 0 }]],
  ]
  for (const [name, badAllocations] of invalidCases) {
    const response = await invokeStaffApi('allocation.savePayment', {
      _testOpenid: TEST_MANAGER_OPENID, salePaymentId, allocations: badAllocations,
    })
    assert.notEqual(response.code, 0, `${name}应被拒绝`)
  }
  const rows = await pgQuery(
    `SELECT spia.employee_id, spia.allocation_ratio, spia.allocated_amount
       FROM sale_payment_item_allocations spia
       JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
      WHERE spir.sale_payment_id = $1 AND spia.is_void = false`,
    [salePaymentId],
  )
  assert.equal(rows.length, 4, '拒绝的请求不得覆盖已保存分配')
  passed = true
  console.log('PASS — 4 人同池保存、回显及超额/重复/无效比例拦截')
} catch (error) {
  console.error('[smoke-allocation-unlimited] FAIL:', error)
} finally {
  try { await cleanupTestData(NS) } catch (error) { console.error('[cleanup error]', error) }
  await closePool()
  process.exit(passed ? 0 : 1)
}
