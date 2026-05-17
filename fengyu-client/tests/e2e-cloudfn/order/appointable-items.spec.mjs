#!/usr/bin/env bun
/**
 * clientApi.order.appointableItems
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js (line 1216)
 *   - 无入参：返回当前 userId 的所有可预约 sale_items（grouped by order）
 *   - 过滤：WHERE o.client_user_id=$1 AND o.status='已支付' AND si.product_type IN ('疗程卡','单品')
 *           AND si.remaining_sessions > 0 AND (si.expire_date IS NULL OR si.expire_date > CURRENT_DATE)
 *   - includeInactive=true 时不过滤 remaining/expire
 *   - response: { orders: [{ saleOrderId, items: [...] }] }
 *
 * 重要发现/差异：
 *   - 路由不接受 saleOrderId 入参；返回的是当前用户**所有**已支付订单的可预约项
 *   - 实际 schema 字段是 sale_items.remaining_sessions（NOT remaining_count）
 *     ⇒ helper createTestPendingSaleOrder 中传 remaining_count 是 bug；
 *       本 spec 不传该参数，下单后直接 UPDATE remaining_sessions
 *   - 单品 (product_type='单品') 也属可预约范围；本 spec 的"单品 vs 疗程卡"区分
 *     测的是 product_type='家居产品'（不在 IN 列表内）
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import {
  createTestPendingSaleOrder, cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'

/**
 * 创建一个 '已支付' + 疗程卡 sale_items（带 remaining_sessions） 的订单
 */
async function newPaidCourseOrder({
  orderNo,
  sessionCount = 5,
  remainingSessions = 5,
  productType = '疗程卡',
  totalAmount = 500,
} = {}) {
  await createTestPendingSaleOrder({
    saleOrderId: orderNo, totalAmount, productType, sessionCount,
    // 不传 remainingCount——helper 列名是 remaining_count 与 schema remaining_sessions 不一致
  })
  // 改状态为 '已支付'
  await pgQuery(
    `UPDATE sale_orders SET status = '已支付', received = $1, paid_at = NOW()
     WHERE sale_order_id = $2`,
    [totalAmount, orderNo]
  )
  // 直接写 remaining_sessions（schema 实际列名）
  await pgQuery(
    `UPDATE sale_items SET session_count = $1, remaining_sessions = $2
     WHERE sale_order_id = $3`,
    [sessionCount, remainingSessions, orderNo]
  )
}

async function caseHappyHasRemaining() {
  await createTestClient()
  const orderNo = `${NS}_AP_OK1`.slice(0, 30)
  await newPaidCourseOrder({ orderNo, sessionCount: 5, remainingSessions: 5 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.appointableItems', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const orders = res.data?.orders || []
  const hit = orders.find(o => o.saleOrderId === orderNo)
  if (!hit) {
    throw new Error(`expect orderNo=${orderNo} in result, got: ${orders.map(o => o.saleOrderId).join(',')}`)
  }
  if (!Array.isArray(hit.items) || hit.items.length !== 1) {
    throw new Error(`expect 1 item, got ${hit.items?.length}`)
  }
  const item = hit.items[0]
  if (item.remainingSessions !== 5) throw new Error(`remainingSessions=${item.remainingSessions}`)
  if (item.productType !== '疗程卡') throw new Error(`productType=${item.productType}`)
}

async function caseZeroRemainingExcluded() {
  await createTestClient()
  const orderNo = `${NS}_AP_ZER1`.slice(0, 30)
  await newPaidCourseOrder({ orderNo, sessionCount: 5, remainingSessions: 0 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.appointableItems', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const orders = res.data?.orders || []
  const hit = orders.find(o => o.saleOrderId === orderNo)
  // 路由 activeFilter: remaining_sessions > 0 → 被排除（默认 includeInactive=false）
  if (hit) {
    throw new Error(`expect no orderNo=${orderNo} (remaining=0), but it appeared`)
  }
}

async function caseNonAppointableProductTypeExcluded() {
  await createTestClient()
  const orderNo = `${NS}_AP_NA1`.slice(0, 30)
  // productType='家居产品' 不在 IN ('疗程卡','单品') 列表，应被排除
  await newPaidCourseOrder({
    orderNo, sessionCount: 1, remainingSessions: 1, productType: '家居产品',
  })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.appointableItems', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const orders = res.data?.orders || []
  const hit = orders.find(o => o.saleOrderId === orderNo)
  if (hit) {
    throw new Error(`expect 家居产品 excluded, but got orderNo=${orderNo}`)
  }
}

async function caseNoSaleOrderIdParam() {
  await createTestClient()
  const orderNo = `${NS}_AP_ALL1`.slice(0, 30)
  await newPaidCourseOrder({ orderNo, sessionCount: 3, remainingSessions: 3 })
  // 路由不要求 saleOrderId；空 payload 仍能返回所有可预约项
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.appointableItems', {})
  if (res.code !== 0) throw new Error(`expect code=0 (saleOrderId not required), got ${res.code}: ${res.message}`)
  const orders = res.data?.orders || []
  if (!orders.find(o => o.saleOrderId === orderNo)) {
    throw new Error(`expect ${orderNo} present`)
  }
}

const CASES = [
  ['happy (paid + remaining>0) returns the order/item', caseHappyHasRemaining],
  ['remaining=0 excluded by default filter', caseZeroRemainingExcluded],
  ['product_type=家居产品 excluded (not in 疗程卡/单品)', caseNonAppointableProductTypeExcluded],
  ['no saleOrderId param → returns all (route does not require it)', caseNoSaleOrderIdParam],
]

let pass = 0, fail = 0
console.log(`[order/appointable-items.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[order/appointable-items.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
