#!/usr/bin/env bun
/**
 * clientApi.order.queryLakalaStatus 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js#queryLakalaStatus
 *
 * 实测要点：
 *   - 无 lakala_out_order_no 或 resolveLakalaMerchant 返回 null → 早返 lakalaQueried=false（不调外网）
 *   - 跨用户：order.client_user_id 非空且不等于 userId → PERMISSION_DENIED
 *     注意 `&&` 短路：client_user_id=null 时不抛权限（内部单允许任意用户查）
 *   - 订单不存在 → NOT_FOUND
 *   - 缺 saleOrderId/orderNo → INVALID_PARAMS
 *
 * 不覆盖：门店启用 + 有 out_order_no 真发外网（[SKIP-LAKALA] 模式，外网验证由 lakala-sit-smoke.cjs）
 *
 * 用例（6 个）：
 *   1. 订单无 lakala_out_order_no → lakalaQueried=false
 *   2. 门店 lakala_enabled=false + 有 out_order_no → lakalaQueried=false
 *   3. 订单不存在 → NOT_FOUND
 *   4. 跨用户 → PERMISSION_DENIED
 *   5. client_user_id=null 内部单 → 任意用户可查不抛权限（A5 新增）
 *   6. 缺 saleOrderId → INVALID_PARAMS
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID,
  TEST_CLIENT2_OPENID, TEST_CLIENT2_USER_ID,
  TEST_STORE_ID,
  pgQuery,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../helpers/fixtures.mjs'
import {
  cleanupClientExtras, createTestClient2, createTestPendingSaleOrder,
} from '../helpers/client-fixtures.mjs'

/**
 * 调整测试门店的拉卡拉配置。
 * spec 末尾 finally 块统一 reset。
 */
async function setStoreLakala({ enabled = false, merchantNo = null, termNo = null } = {}) {
  await pgQuery(
    `UPDATE stores SET lakala_enabled = $1, lakala_merchant_no = $2, lakala_term_no = $3
     WHERE store_id = $4`,
    [enabled, merchantNo, termNo, TEST_STORE_ID]
  )
}

/**
 * 给已有订单写入 lakala_out_order_no（模拟已发起过拉卡拉支付的订单）
 */
async function setOrderLakalaOutNo(saleOrderId, outOrderNo) {
  await pgQuery(
    `UPDATE sale_orders SET lakala_out_order_no = $1 WHERE sale_order_id = $2`,
    [outOrderNo, saleOrderId]
  )
}

// ─────────────── 用例 ───────────────

async function caseNoOutOrderNo() {
  await createTestClient()
  const orderId = `${NS}_LK_NO`
  await createTestPendingSaleOrder({ saleOrderId: orderId, totalAmount: 200 })
  // 不写 lakala_out_order_no，保留 NULL

  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.queryLakalaStatus', { saleOrderId: orderId })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.lakalaQueried !== false) {
    throw new Error(`expect lakalaQueried=false, got ${JSON.stringify(res.data)}`)
  }
  if (res.data.localStatus !== '待支付') {
    throw new Error(`expect localStatus=待支付, got ${res.data.localStatus}`)
  }
}

async function caseStoreDisabled() {
  await createTestClient()
  await setStoreLakala({ enabled: false, merchantNo: '8888' })

  const orderId = `${NS}_LK_DIS`
  await createTestPendingSaleOrder({ saleOrderId: orderId, totalAmount: 200 })
  await setOrderLakalaOutNo(orderId, `${orderId}_1234567890`)

  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.queryLakalaStatus', { saleOrderId: orderId })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  // resolveLakalaMerchant 因 lakala_enabled=false 返回 null → 早返
  if (res.data.lakalaQueried !== false) {
    throw new Error(`expect lakalaQueried=false (store disabled), got ${JSON.stringify(res.data)}`)
  }
}

async function caseOrderNotFound() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.queryLakalaStatus', {
    saleOrderId: `${NS}_LK_NOTFOUND`,
  })
  if (res.code === 0) throw new Error('expect non-zero (NOT_FOUND)')
  if (!/NOT_FOUND|订单不存在/.test(res.message || '')) {
    throw new Error(`expect NOT_FOUND, got "${res.message}"`)
  }
}

async function caseCrossUserDenied() {
  await createTestClient()
  await createTestClient2()

  const orderId = `${NS}_LK_CR`
  // 订单挂 client2 名下
  await createTestPendingSaleOrder({
    saleOrderId: orderId,
    clientUserId: TEST_CLIENT2_USER_ID,
    totalAmount: 200,
  })

  // client1 用 OPENID 查 client2 的订单
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.queryLakalaStatus', { saleOrderId: orderId })
  if (res.code === 0) throw new Error('expect non-zero (PERMISSION_DENIED)')
  if (!/PERMISSION_DENIED|无权查询/.test(res.message || '')) {
    throw new Error(`expect PERMISSION_DENIED, got "${res.message}"`)
  }
}

async function caseInternalOrderNullClientUserId() {
  await createTestClient()

  // 创建一个 client_user_id=NULL 的内部单
  // 注意：createTestPendingSaleOrder 要求 client_user_id，所以手工 INSERT
  const orderId = `${NS}_LK_INT`
  await pgQuery(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, client_user_id, client_phone, customer_name,
       total_amount, prepaid_card_amount, payable_amount, received,
       payment_method, allocation_status
     )
     VALUES ($1, '待支付'::order_status, '内部单'::sale_order_type, $2, $3,
             NOW(), NULL, NULL, $4,
             100, 0, 100, 0,
             '无'::payment_method, '待分配'::allocation_status)`,
    [orderId, `${NS}_市场`, TEST_STORE_ID, `${NS}_内部`]
  )

  // TEST_CLIENT_OPENID 查这个内部单：order.client_user_id=null 时 && 短路，不抛权限
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.queryLakalaStatus', { saleOrderId: orderId })
  if (res.code !== 0) throw new Error(`expect code=0 (内部单允许任意用户查), got ${res.code}: ${res.message}`)
  if (res.data.lakalaQueried !== false) {
    throw new Error(`expect lakalaQueried=false (无 out_order_no), got ${JSON.stringify(res.data)}`)
  }
}

async function caseMissingParam() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.queryLakalaStatus', {})
  if (res.code === 0) throw new Error('expect non-zero (INVALID_PARAMS)')
  if (!/INVALID_PARAMS|缺少 saleOrderId/.test(res.message || '')) {
    throw new Error(`expect INVALID_PARAMS, got "${res.message}"`)
  }
}

const CASES = [
  ['无 lakala_out_order_no → lakalaQueried=false', caseNoOutOrderNo],
  ['门店 lakala_enabled=false → lakalaQueried=false', caseStoreDisabled],
  ['订单不存在 → NOT_FOUND', caseOrderNotFound],
  ['跨用户 → PERMISSION_DENIED', caseCrossUserDenied],
  ['内部单 client_user_id=null → 任意用户可查', caseInternalOrderNullClientUserId],
  ['缺 saleOrderId → INVALID_PARAMS', caseMissingParam],
]

let pass = 0, fail = 0
console.log(`[order/lakala-status.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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
  // reset 测试店拉卡拉配置（不影响其他 spec）
  try { await setStoreLakala({ enabled: false, merchantNo: null, termNo: null }) } catch { /* noop */ }
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[order/lakala-status.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
