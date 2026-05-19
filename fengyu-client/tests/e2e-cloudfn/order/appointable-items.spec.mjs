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
import { createTestClient, cleanupTestData } from '../helpers/fixtures.mjs'
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

// 跨门店：路由实测仅按 client_user_id 过滤（line 1268-1276），不按 store_id 过滤
//   → 顾客在不同门店有疗程卡，都会被返回。本 case 验证"两单都出现"为 documented behavior。
//   TODO: 若后续业务规则改为"仅返回 bound_store_id"对应订单，需把断言改为 expectExactlyOne 并加上 storeId 过滤。
async function caseAppointableItemsCrossStoreFilter() {
  await createTestClient()  // 顾客 bound_store_id = TEST_STORE_ID

  // 创建第二个 store
  const STORE_X_ID = `${NS}_STORE_X`
  const STORE_X_ORG = `${NS}_STORE_X_ORG`
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '门店',
       (SELECT id FROM org_nodes WHERE id = $3),
       1, true)
     ON CONFLICT (id) DO NOTHING`,
    [STORE_X_ORG, `${NS}_测试店X`, `${NS}_MARKET_ORG`]
  )
  await pgQuery(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false)
     ON CONFLICT (store_id) DO NOTHING`,
    [STORE_X_ID, `${NS}_测试店X`, STORE_X_ORG]
  )

  // 主店一单
  const orderA = `${NS}_AP_XA`.slice(0, 30)
  await newPaidCourseOrder({ orderNo: orderA, sessionCount: 3, remainingSessions: 3 })

  // 副店一单：手工建（newPaidCourseOrder 写死 TEST_STORE_ID 经由 createTestPendingSaleOrder）
  const orderB = `${NS}_AP_XB`.slice(0, 30)
  // 直接 UPDATE orderA 的 store_id 的方式不行，需要一张属副店的单。
  // 重用 newPaidCourseOrder 后 UPDATE store_id 到副店
  await newPaidCourseOrder({ orderNo: orderB, sessionCount: 3, remainingSessions: 3 })
  await pgQuery(
    `UPDATE sale_orders SET store_id = $1 WHERE sale_order_id = $2`,
    [STORE_X_ID, orderB]
  )
  await pgQuery(
    `UPDATE sale_items SET store_id = $1 WHERE sale_order_id = $2`,
    [STORE_X_ID, orderB]
  )

  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.appointableItems', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const orders = res.data?.orders || []
  const hitA = orders.find(o => o.saleOrderId === orderA)
  const hitB = orders.find(o => o.saleOrderId === orderB)
  // documented behavior：两个 store 的订单都返回（路由不按 storeId 过滤）
  if (!hitA) throw new Error(`expect orderA=${orderA} in result (主店)`)
  if (!hitB) throw new Error(`expect orderB=${orderB} in result (副店, documented: route does not filter by storeId)`)
  // 行级 storeId 字段确实反映各自门店
  if (hitA.storeId !== TEST_STORE_ID) throw new Error(`hitA.storeId=${hitA.storeId}`)
  if (hitB.storeId !== STORE_X_ID) throw new Error(`hitB.storeId=${hitB.storeId}`)
}

const CASES = [
  ['happy (paid + remaining>0) returns the order/item', caseHappyHasRemaining],
  ['remaining=0 excluded by default filter', caseZeroRemainingExcluded],
  ['product_type=家居产品 excluded (not in 疗程卡/单品)', caseNonAppointableProductTypeExcluded],
  ['no saleOrderId param → returns all (route does not require it)', caseNoSaleOrderIdParam],
  ['cross-store: 两单都返回（documented: route 不按 storeId 过滤）', caseAppointableItemsCrossStoreFilter],
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
