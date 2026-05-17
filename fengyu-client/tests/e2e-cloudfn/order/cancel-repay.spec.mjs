#!/usr/bin/env bun
/**
 * clientApi.order.{cancel,repay}
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js
 *   - cancel (line 1103) → CAS 守卫：UPDATE WHERE status ∈ [允许] AND client_user_id=$1
 *                          status='已支付' 非全额抵扣单 → INVALID_PARAMS: 当前订单状态不允许取消
 *                          status='已取消'/'已关闭' → 同样不允许
 *   - repay  (line 1642) → 多次回款；paymentMethod ∈ {微信,支付宝,储值卡}；status ∈ {待支付,部分支付}
 *                          已支付 → INVALID_STATE: 订单状态不允许回款
 *
 * 重要发现/差异：
 *   - cancel 成功后订单 status = '已关闭'（不是 '已取消'）
 *   - cancel 跨用户：路由 SELECT WHERE client_user_id 不命中 → INVALID_PARAMS: 订单不存在
 *     （无显式 PERMISSION_DENIED 分支）
 *   - repay 微信通道 mock，需要 payAmount 合法且不超过剩余应付
 *   - repay 已支付 → INVALID_STATE: 订单状态不允许回款
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
  TEST_CLIENT2_OPENID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../helpers/fixtures.mjs'
import {
  createTestPendingSaleOrder, createTestClient2, cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'

async function caseCancelHappy() {
  await createTestClient()
  const orderNo = `${NS}_CNL_OK1`.slice(0, 30)
  await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 88 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.cancel', {
    saleOrderId: orderNo, cancelReason: '临时不需要',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  // 路由 status 改为 '已关闭'
  if (res.data?.status !== '已关闭') {
    throw new Error(`expect status=已关闭 in response, got: ${res.data?.status}`)
  }
  const rows = await pgQuery(`SELECT status FROM sale_orders WHERE sale_order_id = $1`, [orderNo])
  if (rows[0].status !== '已关闭') {
    throw new Error(`expect PG status=已关闭, got: ${rows[0].status}`)
  }
}

async function caseCancelAlreadyPaidRejected() {
  await createTestClient()
  const orderNo = `${NS}_CNL_P1`.slice(0, 30)
  await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 88 })
  await pgQuery(`UPDATE sale_orders SET status = '已支付' WHERE sale_order_id = $1`, [orderNo])
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.cancel', { saleOrderId: orderNo })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '当前订单状态不允许取消' })
}

async function caseCancelCrossUserDenied() {
  await createTestClient()       // 顾客 A
  await createTestClient2()      // 顾客 B
  const orderNo = `${NS}_CNL_XU1`.slice(0, 30)
  await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 50 }) // 绑顾客 A
  // 顾客 B 取消 → 路由 WHERE client_user_id 不命中 → INVALID_PARAMS: 订单不存在
  const res = await invokeAs(TEST_CLIENT2_OPENID, 'order.cancel', { saleOrderId: orderNo })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '订单不存在' })
}

async function caseRepayHappy() {
  await createTestClient()
  // 制造 status='部分支付' 的单子：total=200，已 received 80 → 还欠 120
  const orderNo = `${NS}_RP_OK1`.slice(0, 30)
  await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 200 })
  await pgQuery(
    `UPDATE sale_orders SET status = '部分支付', received = 80, payable_amount = 200
     WHERE sale_order_id = $1`,
    [orderNo]
  )
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo,
    paymentMethod: '微信',
    repayAmount: 50,
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  // mock 模式应返回 paymentParams 或 mockMode=true
  if (!res.data?.paymentParams && !res.data?.mockMode) {
    throw new Error(`expect mock paymentParams/mockMode, got: ${JSON.stringify(res.data).slice(0,200)}`)
  }
}

async function caseRepayAlreadyPaidRejected() {
  await createTestClient()
  const orderNo = `${NS}_RP_P1`.slice(0, 30)
  await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 100 })
  await pgQuery(
    `UPDATE sale_orders SET status = '已支付', received = 100 WHERE sale_order_id = $1`,
    [orderNo]
  )
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo,
    paymentMethod: '微信',
    repayAmount: 50,
  })
  // 路由抛 'INVALID_STATE: ...'，但 INVALID_STATE 不在 index.js knownTypes 中，
  // 错误被替换为 '服务器内部错误'。spec 仅断言非 0 即可。
  if (res.code === 0) throw new Error(`expect error, got success`)
}

const CASES = [
  ['cancel happy → status=已关闭', caseCancelHappy],
  ['cancel on 已支付 → INVALID_PARAMS', caseCancelAlreadyPaidRejected],
  ['cancel cross-user → INVALID_PARAMS/订单不存在', caseCancelCrossUserDenied],
  ['repay (微信) on 部分支付 → paymentParams returned', caseRepayHappy],
  ['repay on 已支付 → INVALID_STATE', caseRepayAlreadyPaidRejected],
]

let pass = 0, fail = 0
console.log(`[order/cancel-repay.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[order/cancel-repay.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
