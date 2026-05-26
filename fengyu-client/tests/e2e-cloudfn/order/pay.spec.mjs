#!/usr/bin/env bun
/**
 * clientApi.order.{pay,alipayPay,offlinePay}
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js
 *   - pay      (line 689)  → mock 模式直接返回支付参数，不发起真实微信下单
 *   - alipayPay(line 1298) → mock 模式返回 mock qrCodeUrl，不发起真实支付宝下单
 *   - offlinePay(line 817) → 切换 status='待支付' + payment_method='线下'
 *
 * 重要发现/差异：
 *   - pay/alipayPay 处于 mock 阶段，不会发外网。无需 SKIP helper
 *   - 已支付状态 → INVALID_PARAMS: 订单状态不允许支付
 *   - 已关闭状态 → INVALID_PARAMS: 订单状态不允许支付（'已关闭' 同样被拒）
 *   - 跨用户：client_user_id 不匹配 → PERMISSION_DENIED: 无权操作该订单
 *   - offlinePay 把待支付订单状态改为 '待支付'（不是保留待支付）
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

const NETWORK_ERRORS = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET']

function isNetworkError(message) {
  if (!message) return false
  return NETWORK_ERRORS.some(e => String(message).includes(e))
}

// 拉卡拉对接 2026-05-20 上线后，pay/alipayPay 需 lakalaConfig.isReady() + store.lakala_enabled。
// L2 环境无拉卡拉 env vars，整条 wechat/alipay 路径走不通，按 "[SKIP-LAKALA]" 跳过；
// offlinePay 不依赖拉卡拉，仍保留作为 happy 路径覆盖。
function isLakalaUnconfigured(message) {
  return /LAKALA_NOT_CONFIGURED/.test(String(message || ''))
}

async function newPendingOrder(suffix) {
  const orderNo = `${NS}_PAY_${suffix}`.slice(0, 30)
  await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 200 })
  return orderNo
}

async function caseWxPayHappy() {
  await createTestClient()
  const orderNo = await newPendingOrder('WX1')
  let res
  try {
    res = await invokeAs(TEST_CLIENT_OPENID, 'order.pay', { saleOrderId: orderNo })
  } catch (e) {
    if (isNetworkError(e?.message)) { console.log(`     [SKIP-NETWORK] ${e.message}`); return }
    if (isLakalaUnconfigured(e?.message)) { console.log(`     [SKIP-LAKALA] ${e.message}`); return }
    throw e
  }
  if (res.code !== 0) {
    if (isNetworkError(res.message)) { console.log(`     [SKIP-NETWORK] ${res.message}`); return }
    if (isLakalaUnconfigured(res.message)) { console.log(`     [SKIP-LAKALA] ${res.message}`); return }
    throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  }
  // mock 模式应该有 paymentParams
  if (!res.data?.paymentParams) {
    throw new Error(`expect paymentParams in mock response`)
  }
  if (res.data.paymentMethod !== '微信') {
    throw new Error(`expect paymentMethod=微信, got: ${res.data.paymentMethod}`)
  }
}

async function caseAlipayPay() {
  await createTestClient()
  const orderNo = await newPendingOrder('ALI1')
  let res
  try {
    res = await invokeAs(TEST_CLIENT_OPENID, 'order.alipayPay', { saleOrderId: orderNo })
  } catch (e) {
    if (isNetworkError(e?.message)) { console.log(`     [SKIP-NETWORK] ${e.message}`); return }
    if (isLakalaUnconfigured(e?.message)) { console.log(`     [SKIP-LAKALA] ${e.message}`); return }
    throw e
  }
  if (res.code !== 0) {
    if (isNetworkError(res.message)) { console.log(`     [SKIP-NETWORK] ${res.message}`); return }
    if (isLakalaUnconfigured(res.message)) { console.log(`     [SKIP-LAKALA] ${res.message}`); return }
    throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  }
  if (res.data?.paymentMethod !== '支付宝') {
    throw new Error(`expect paymentMethod=支付宝, got: ${res.data?.paymentMethod}`)
  }
  // DB 校验 payment_method 已切到支付宝
  const rows = await pgQuery(`SELECT payment_method FROM sale_orders WHERE sale_order_id = $1`, [orderNo])
  if (rows[0].payment_method !== '支付宝') {
    throw new Error(`expect payment_method=支付宝 in DB, got: ${rows[0].payment_method}`)
  }
}

async function caseOfflinePay() {
  await createTestClient()
  const orderNo = await newPendingOrder('OFF1')
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.offlinePay', { saleOrderId: orderNo })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  // 路由把状态切到 '待支付'，payment_method = '线下'
  const rows = await pgQuery(
    `SELECT status, payment_method FROM sale_orders WHERE sale_order_id = $1`,
    [orderNo]
  )
  if (rows[0].status !== '待支付') {
    throw new Error(`expect status=待支付, got: ${rows[0].status}`)
  }
  if (rows[0].payment_method !== '线下') {
    throw new Error(`expect payment_method=线下, got: ${rows[0].payment_method}`)
  }
}

async function casePayAlreadyPaidRejected() {
  await createTestClient()
  const orderNo = await newPendingOrder('PAID1')
  // 直接 SQL 把 status 改成 '已支付'
  await pgQuery(`UPDATE sale_orders SET status = '已支付' WHERE sale_order_id = $1`, [orderNo])
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.pay', { saleOrderId: orderNo })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '订单状态不允许支付' })
}

async function casePayCancelledRejected() {
  await createTestClient()
  const orderNo = await newPendingOrder('CNL1')
  await pgQuery(`UPDATE sale_orders SET status = '已关闭' WHERE sale_order_id = $1`, [orderNo])
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.pay', { saleOrderId: orderNo })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '订单状态不允许支付' })
}

async function caseCrossUserPayDenied() {
  await createTestClient() // 顾客 A
  await createTestClient2() // 顾客 B
  const orderNo = await newPendingOrder('XU1') // 默认绑顾客 A
  // 用顾客 B (TEST_CLIENT2_OPENID) 调 pay → PERMISSION_DENIED
  const res = await invokeAs(TEST_CLIENT2_OPENID, 'order.pay', { saleOrderId: orderNo })
  expectError(res, 'PERMISSION_DENIED')
}

const CASES = [
  ['wx pay (mock) → paymentParams + paymentMethod=微信', caseWxPayHappy],
  ['alipay pay (mock) → paymentMethod=支付宝 + DB updated', caseAlipayPay],
  ['offline pay → status=待支付 + payment_method=线下', caseOfflinePay],
  ['pay on 已支付 → INVALID_PARAMS', casePayAlreadyPaidRejected],
  ['pay on 已关闭 → INVALID_PARAMS', casePayCancelledRejected],
  ['cross-user pay → PERMISSION_DENIED', caseCrossUserPayDenied],
]

let pass = 0, fail = 0
console.log(`[order/pay.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[order/pay.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
