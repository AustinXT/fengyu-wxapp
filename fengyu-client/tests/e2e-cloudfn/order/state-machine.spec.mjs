#!/usr/bin/env bun
/**
 * clientApi.order 状态机矩阵 — cancel / repay 允许/拒绝转移
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js
 *   - cancel (line 1126)
 *       允许：['待支付']；isPrepaidFull && status='已支付' 额外允许
 *       拒绝错误码：INVALID_PARAMS（"当前订单状态不允许取消"）— 注意不是 INVALID_STATE
 *       并发 CAS 失败：CONFLICT
 *   - repay (line 1690)
 *       允许：['待支付', '部分支付']
 *       拒绝错误码：INVALID_STATE（"订单状态不允许回款"）
 *       remaining≤0 时：INVALID_STATE（"订单无欠款"）
 *
 * 关键发现：cancel 和 repay 用不同前缀，断言时按实现而非按"理想"。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs, expectError } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../helpers/fixtures.mjs'
import {
  createTestPendingSaleOrder,
  forceUpdateOrderStatus,
  cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'

async function seedOrder({ saleOrderId, status, totalAmount = 200, prepaidCardAmount = 0, received = null }) {
  await createTestPendingSaleOrder({ saleOrderId, totalAmount })
  // createTestPendingSaleOrder 默认 '待支付' / received=0；后置 UPDATE 覆盖
  await pgQuery(
    `UPDATE sale_orders
     SET status = $1::order_status,
         prepaid_card_amount = $2,
         payable_amount = $3,
         received = COALESCE($4, received)
     WHERE sale_order_id = $5`,
    [status, prepaidCardAmount, Math.max(0, totalAmount - prepaidCardAmount), received, saleOrderId]
  )
}

async function caseCancelHappyPendingToClosed() {
  await createTestClient()
  const orderNo = `${NS}_SM_PND`.slice(0, 30)
  await seedOrder({ saleOrderId: orderNo, status: '待支付' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.cancel', { saleOrderId: orderNo })
  if (res.code !== 0) throw new Error(`expect success, got ${res.code} ${res.message}`)
  const rows = await pgQuery(
    `SELECT status FROM sale_orders WHERE sale_order_id = $1`, [orderNo]
  )
  if (rows[0].status !== '已关闭') {
    throw new Error(`expect status=已关闭, got ${rows[0].status}`)
  }
}

async function caseCancelAlreadyPaidRejected() {
  await createTestClient()
  const orderNo = `${NS}_SM_PAID`.slice(0, 30)
  // 已支付 + 非全额抵扣 → 不在 cancelable 列表
  await seedOrder({ saleOrderId: orderNo, status: '已支付', totalAmount: 200, prepaidCardAmount: 0, received: 200 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.cancel', { saleOrderId: orderNo })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '不允许取消' })
}

async function caseCancelClosedRejected() {
  await createTestClient()
  const orderNo = `${NS}_SM_CLS`.slice(0, 30)
  await seedOrder({ saleOrderId: orderNo, status: '待支付' })
  await forceUpdateOrderStatus(orderNo, '已关闭')
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.cancel', { saleOrderId: orderNo })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '不允许取消' })
}

async function caseCancelPrepaidFullPaidAllowed() {
  await createTestClient()
  const orderNo = `${NS}_SM_PFP`.slice(0, 30)
  // 全额储值卡抵扣：prepaid=200, payable=0, status=已支付 — 允许 cancel 并回冲
  await seedOrder({
    saleOrderId: orderNo, status: '已支付',
    totalAmount: 200, prepaidCardAmount: 200, received: 200,
  })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.cancel', { saleOrderId: orderNo })
  if (res.code !== 0) {
    throw new Error(`expect prepaid-full paid cancel to succeed, got ${res.code} ${res.message}`)
  }
  const rows = await pgQuery(
    `SELECT status FROM sale_orders WHERE sale_order_id = $1`, [orderNo]
  )
  if (rows[0].status !== '已关闭') {
    throw new Error(`expect status=已关闭, got ${rows[0].status}`)
  }
}

async function caseRepayHappyPartialPaid() {
  await createTestClient()
  const orderNo = `${NS}_SM_RPP`.slice(0, 30)
  // 部分支付：total=200, payable=200, received=50 → remaining=150 → repay 50 应成功
  await seedOrder({
    saleOrderId: orderNo, status: '部分支付',
    totalAmount: 200, prepaidCardAmount: 0, received: 50,
  })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo,
    paymentMethod: '微信',
    repayAmount: 50,
  })
  if (res.code !== 0) throw new Error(`expect repay ok, got ${res.code} ${res.message}`)
}

async function caseRepayPaidRejected() {
  await createTestClient()
  const orderNo = `${NS}_SM_RPD`.slice(0, 30)
  await seedOrder({
    saleOrderId: orderNo, status: '已支付',
    totalAmount: 200, prepaidCardAmount: 0, received: 200,
  })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo,
    paymentMethod: '微信',
    repayAmount: 1,
  })
  expectError(res, 'INVALID_STATE', { messageIncludes: '不允许回款' })
}

async function caseRepayClosedRejected() {
  await createTestClient()
  const orderNo = `${NS}_SM_RCL`.slice(0, 30)
  await seedOrder({ saleOrderId: orderNo, status: '待支付' })
  await forceUpdateOrderStatus(orderNo, '已关闭')
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo,
    paymentMethod: '微信',
    repayAmount: 10,
  })
  expectError(res, 'INVALID_STATE', { messageIncludes: '不允许回款' })
}

async function caseRepayNoDebtRejected() {
  await createTestClient()
  const orderNo = `${NS}_SM_RND`.slice(0, 30)
  // remaining = payable_amount - (received - refunded) = 200 - 200 = 0 → 但 status='部分支付'
  // 模拟"已收齐但状态未来得及推到已支付"的异常态：route 应识别 remaining<=0 并拒绝
  await seedOrder({
    saleOrderId: orderNo, status: '部分支付',
    totalAmount: 200, prepaidCardAmount: 0, received: 200,
  })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo,
    paymentMethod: '微信',
    repayAmount: 1,
  })
  expectError(res, 'INVALID_STATE', { messageIncludes: '无欠款' })
}

async function caseCancelConcurrentCasConflict() {
  // 模拟"他端先把状态推走"的 CAS 失败 — 等价于在 cancel 前 status 被改成 '已关闭'
  // 实际路由：UPDATE ... WHERE status = ANY('待支付')；若 rowCount=0 → CONFLICT
  // 这里通过先 force 改 status，再 cancel；因为 status 已不在允许集合，会在前置应用层校验
  // 就先抛 INVALID_PARAMS，未到 UPDATE。所以纯 CAS 路径无法在不并发的情况下命中。
  //
  // 改换为：先把订单造成"应用层允许但 UPDATE 时已变"的窗口 — 通过 sale_order_type 异常 / payable_amount 异常都不可达。
  // 结论：CONFLICT 路径仅在真实并发下出现，本 case 改为文档化跳过。
  return { __skip: true, reason: 'CONFLICT path needs true concurrent UPDATE — covered by scan-flow stale-version test instead' }
}

const CASES = [
  ['cancel: 待支付 → 已关闭 (happy)', caseCancelHappyPendingToClosed],
  ['cancel: 已支付（非全额抵扣）→ INVALID_PARAMS', caseCancelAlreadyPaidRejected],
  ['cancel: 已关闭 → INVALID_PARAMS', caseCancelClosedRejected],
  ['cancel: 已支付（全额抵扣）→ 已关闭 (允许 + 回冲)', caseCancelPrepaidFullPaidAllowed],
  ['repay: 部分支付 + remaining>0 → ok', caseRepayHappyPartialPaid],
  ['repay: 已支付 → INVALID_STATE', caseRepayPaidRejected],
  ['repay: 已关闭 → INVALID_STATE', caseRepayClosedRejected],
  ['repay: 部分支付 + remaining=0 → INVALID_STATE: 无欠款', caseRepayNoDebtRejected],
  ['cancel: 并发 CAS conflict (文档化跳过)', caseCancelConcurrentCasConflict],
]

let pass = 0, fail = 0, skip = 0
console.log(`[order/state-machine.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      const r = await fn()
      if (r && r.__skip) {
        console.log(`  ⏭  ${name} — ${r.reason}`)
        skip++
      } else {
        console.log(`  ✅ ${name}`)
        pass++
      }
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

console.log(`[order/state-machine.spec] end | ${pass} passed / ${fail} failed / ${skip} skipped`)
process.exit(fail ? 1 : 0)
