#!/usr/bin/env bun
/** 工作台分配角标 = 销售待分配全部回款 + 服务待分配全部已完成服务单。 */
import './setup.mjs'
import {
  NS, TEST_CLIENT_USER_ID, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID,
  TEST_STORES_MULTI, pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  cleanupTestData, ensureTestStore, createTestOrg, createTestStaff,
  createTestClient, createTestSaleOrder, createTestServiceOrder,
} from './helpers/fixtures.mjs'

const orderId = `${NS}_BADGE_SO`
const staffOpenid = `${NS}_BADGE_EMP_OPENID`

async function createPayment(receiptAmount) {
  const rows = await pgQuery(
    `INSERT INTO sale_order_payments
       (sale_order_id, change_type, amount, payment_method, status, source_end,
        operator_employee_id, paid_at, allocation_status, created_at)
     VALUES ($1, '回款'::payment_change_type, 1, '线下'::payment_method,
             '已支付'::payment_flow_status, 'staff'::payment_source_end,
             $2, NOW(), '待分配'::allocation_status, NOW())
     RETURNING id`,
    [orderId, TEST_MANAGER_EMP_ID],
  )
  const id = rows[0].id
  await pgQuery(
    `INSERT INTO sale_payment_item_receipts
       (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
     VALUES ($1, $2, $3, $4, '他销自耗'::sales_category, NOW())`,
    [id, orderId, `${orderId}_ITEM_1`, receiptAmount],
  )
  return id
}

async function invoke(action, openid = TEST_MANAGER_OPENID, payload = {}) {
  const result = await invokeStaffApi(action, { _testOpenid: openid, ...payload })
  if (result.code !== 0) throw new Error(`${action} code=${result.code} ${result.message}`)
  return result.data
}

async function assertBadge(expected) {
  const data = await invoke('staff.todoList')
  if (data.pendingAllocationCount !== expected) {
    throw new Error(`角标应为 ${expected}，实际 ${data.pendingAllocationCount}`)
  }
}

async function main() {
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestOrg({ markets: ['A'], stores: ['A1'] })
  await createTestStaff()
  await createTestStaff({
    employeeId: `${NS}_BADGE_EMP`, openid: staffOpenid,
    phone: '19999098005', name: `${NS}_普通员工`, isManager: false,
    positionName: '美容师', skills: ['美容师'],
  })
  await createTestClient()
  await createTestSaleOrder({
    saleOrderId: orderId, clientUserId: TEST_CLIENT_USER_ID,
    productType: '家居产品', totalAmount: 21, status: '已支付',
    salesCategory: '他销自耗',
  })
  await pgQuery('UPDATE sale_orders SET received = 21 WHERE sale_order_id = $1', [orderId])

  const paymentIds = []
  for (let i = 0; i < 21; i++) paymentIds.push(await createPayment(1))
  await createPayment(0) // 有收据但无可分配金额，不应让角标虚高

  const pendingServiceId = `${NS}_BADGE_SVC_NULL`
  await createTestServiceOrder({ serviceOrderId: pendingServiceId, status: '已完成' })
  await createTestServiceOrder({ serviceOrderId: `${NS}_BADGE_SVC_PENDING`, status: '已完成' })
  await pgQuery(
    "UPDATE service_orders SET commission_status = '待分配', completed_at = NOW() WHERE service_order_id = $1",
    [`${NS}_BADGE_SVC_PENDING`],
  )
  await createTestServiceOrder({ serviceOrderId: `${NS}_BADGE_SVC_DONE`, status: '已完成' })
  await pgQuery(
    "UPDATE service_orders SET commission_status = '已分配', completed_at = NOW() WHERE service_order_id = $1",
    [`${NS}_BADGE_SVC_DONE`],
  )
  await createTestServiceOrder({ serviceOrderId: `${NS}_BADGE_SVC_ACTIVE`, status: '待服务' })
  await createTestServiceOrder({
    serviceOrderId: `${NS}_BADGE_SVC_OTHER`, status: '已完成',
    storeId: TEST_STORES_MULTI.A1.storeId,
  })

  const salePage1 = await invoke('allocation.pendingPayments', TEST_MANAGER_OPENID, { page: 1, pageSize: 20 })
  const salePage2 = await invoke('allocation.pendingPayments', TEST_MANAGER_OPENID, { page: 2, pageSize: 20 })
  const servicePage = await invoke('serviceCommission.pendingList')
  if (salePage1.payments.length !== 20 || salePage2.payments.length !== 1 || servicePage.orders.length !== 2) {
    throw new Error(`列表数量错误：销售 ${salePage1.payments.length}+${salePage2.payments.length}，服务 ${servicePage.orders.length}`)
  }
  if (!servicePage.orders.some(order => order.service_order_id === pendingServiceId)) {
    throw new Error('commission_status=NULL 的已完成服务单未进入待分配列表')
  }
  await assertBadge(23)

  await pgQuery("UPDATE sale_order_payments SET allocation_status = '已分配' WHERE id = $1", [paymentIds[0]])
  await assertBadge(22)
  await pgQuery("UPDATE sale_order_payments SET allocation_status = '待分配' WHERE id = $1", [paymentIds[0]])
  await assertBadge(23)
  await pgQuery("UPDATE service_orders SET commission_status = '已分配' WHERE service_order_id = $1", [pendingServiceId])
  await assertBadge(22)
  await pgQuery("UPDATE service_orders SET commission_status = '待分配' WHERE service_order_id = $1", [pendingServiceId])
  await assertBadge(23)

  const staffTodo = await invoke('staff.todoList', staffOpenid)
  if ('pendingAllocationCount' in staffTodo) throw new Error('普通员工不应看到分配角标')
  console.log('✅ PASS — 销售 21 笔（跨分页）+ 服务 2 单；不可分配/已分配/未完成/跨店排除；状态变更后同步')
}

let passed = false
try {
  await main()
  passed = true
} catch (error) {
  console.error('❌ FAIL —', error)
} finally {
  try { await cleanupTestData(NS) } catch (error) { console.error('清理失败：', error); passed = false }
  await closePool()
  process.exit(passed ? 0 : 1)
}
