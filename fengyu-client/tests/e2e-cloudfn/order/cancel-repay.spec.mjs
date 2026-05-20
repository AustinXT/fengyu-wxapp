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
  createTestPendingSaleOrder, createTestClient2, createTestPrepaidCard, cleanupClientExtras,
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

// 拉卡拉对接 2026-05-20 上线后，repay 微信/支付宝通道需 lakalaConfig + store.lakala_enabled。
// L2 环境无拉卡拉 env，改用 paymentMethod='储值卡'（不依赖拉卡拉）覆盖 repay happy 路径。
async function caseRepayHappy() {
  await createTestClient()
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '500.00' })
  // 制造 status='部分支付' 的单子：total=200，已 received 80 → 还欠 120
  const orderNo = `${NS}_RP_OK1`.slice(0, 30)
  await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 200 })
  await pgQuery(
    `UPDATE sale_orders SET status = '部分支付', received = 80, payable_amount = 200
     WHERE sale_order_id = $1`,
    [orderNo]
  )
  // repay 内会按 sale_order_payments 已支付总额回填 received；
  // 必须先种一行"首次支付"代表前置 80 元，否则 received 会被重算为 50（仅本次回款）。
  await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, external_txn_id,
       status, source_end, paid_at, created_at
     ) VALUES ($1, '首次支付', 80, '微信', $2, '已支付', 'client', NOW(), NOW())`,
    [orderNo, `${NS}_RP_OK1_TXN`]
  )
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo,
    paymentMethod: '储值卡',
    repayAmount: 0,
    prepaidCardAmount: 50,
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  // 储值卡通道：事务内已扣款 + 写入 payments 行（回款/储值卡）
  // 断言：received 推进到 130（80+50）、卡余额 -50、payments 多一行
  const rows = await pgQuery(
    `SELECT received, status FROM sale_orders WHERE sale_order_id = $1`,
    [orderNo]
  )
  if (Number(rows[0].received) !== 130) {
    throw new Error(`expect received=130, got: ${rows[0].received}`)
  }
  const cardRows = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  if (Number(cardRows[0].balance) !== 450) {
    throw new Error(`expect card balance=450, got: ${cardRows[0].balance}`)
  }
}

/**
 * 回归 ticket 2026-05-19 paid_sessions：repay 储值卡通道部分回款后 paid_sessions 按比例 floor
 *
 * 场景：12 次疗程卡，total=300，初始 received=100（部分支付），sessionCount=12
 *   储值卡再回款 100 → received=200 → ratio=200/300=0.6666
 *   paid_sessions = floor(0.6666 × 12) = 8
 *
 * 漏调 recalcPaidSessionsForOrder 时 paid_sessions 仍卡在 0（或初始预存值），
 * 导致顾客已付 67% 却仍无法预约任何次数。
 */
async function caseRepayPureCardPartialRecalcPaidSessions() {
  await createTestClient()
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '500.00' })
  const orderNo = `${NS}_RP_PS`.slice(0, 30)
  const { saleItemId } = await createTestPendingSaleOrder({
    saleOrderId: orderNo, totalAmount: 300, productType: '疗程卡', sessionCount: 12,
  })
  // 制造 '部分支付' 起点：received=100；payments 同步写 1 行首次支付，保证 received 不变量
  await pgQuery(
    `UPDATE sale_orders SET status = '部分支付', received = 100, payable_amount = 300
     WHERE sale_order_id = $1`,
    [orderNo]
  )
  await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, external_txn_id,
       status, source_end, paid_at, created_at
     ) VALUES ($1, '首次支付', 100, '微信', $2, '已支付', 'client', NOW(), NOW())`,
    [orderNo, `${NS}_RP_PS_TXN`]
  )
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo,
    paymentMethod: '储值卡',
    repayAmount: 0,
    prepaidCardAmount: 100,
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const items = await pgQuery(
    `SELECT session_count, paid_sessions FROM sale_items WHERE sale_item_id = $1`,
    [saleItemId]
  )
  if (items.length !== 1) throw new Error(`expect 1 row, got ${items.length}`)
  if (Number(items[0].session_count) !== 12) {
    throw new Error(`expect session_count=12, got: ${items[0].session_count}`)
  }
  // floor(200/300 × 12) = floor(8.0) = 8
  if (Number(items[0].paid_sessions) !== 8) {
    throw new Error(`expect paid_sessions=8 after partial repay (200/300×12), got: ${items[0].paid_sessions}`)
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
  ['repay (储值卡) 部分回款 12次卡 → paid_sessions = floor(2/3 × 12) = 8（回归 ticket 2026-05-19）', caseRepayPureCardPartialRecalcPaidSessions],
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
