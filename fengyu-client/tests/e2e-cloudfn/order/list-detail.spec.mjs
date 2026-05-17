#!/usr/bin/env bun
/**
 * clientApi.order.{list,detail}
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js
 *   - list   (line 891) → 仅按 client_user_id；status 过滤；page+pageSize 分页（fetchLimit=pageSize+1）
 *                          response: { orders, hasMore }; orders 按 created_at DESC
 *   - detail (line 985) → 必须 client_user_id 匹配（query WHERE 强制）；返回 { order, items, payments }
 *
 * 重要发现：
 *   - 跨用户 detail 不走 PERMISSION_DENIED 分支，而是直接 WHERE 不命中
 *     → 报 INVALID_PARAMS: 订单不存在（无法区分"不存在"vs"不属于我"）
 *   - list 不会"挂"过期的旧单：page=1 会先 closeExpiredOrdersByUser，可能改变状态
 *     ⇒ 用近实时 sale_order_datetime=NOW() 的单子规避
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
  TEST_CLIENT2_OPENID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import {
  createTestPendingSaleOrder, createTestClient2, cleanupClientExtras,
  forceUpdateOrderStatus,
} from '../helpers/client-fixtures.mjs'

/**
 * 创建 N 个销售单。最后一个保留 '待支付'，前 N-1 个用 forceUpdateOrderStatus 标记成
 * '已支付'，避开 uq_sale_orders_client_pending 唯一约束（同一顾客同时只能有 1 个待支付单）。
 */
async function createN(n, prefix) {
  const ids = []
  for (let i = 0; i < n; i++) {
    const orderNo = `${NS}_LD_${prefix}_${i}`.slice(0, 30)
    await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 100 + i })
    // 除最后一条外，把状态推进到 '已支付'，避开 partial-uniq
    if (i < n - 1) {
      await forceUpdateOrderStatus(orderNo, '已支付')
    }
    ids.push(orderNo)
    // 制造 created_at 微差，确保倒序可见
    await new Promise(r => setTimeout(r, 10))
  }
  return ids
}

async function caseListAll() {
  await createTestClient()
  const ids = await createN(3, 'A')
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const orders = res.data?.orders || []
  // 至少含有这 3 条（命名空间隔离）
  const mine = orders.filter(o => ids.includes(o.sale_order_id))
  if (mine.length !== 3) throw new Error(`expect 3 matched, got ${mine.length} of ${orders.length}`)
  // 倒序：最后插入的应排最前
  const myIdsInResp = mine.map(o => o.sale_order_id)
  // 由 created_at DESC 排序，最后插入的 ids[2] 应在最前
  if (myIdsInResp[0] !== ids[2]) {
    throw new Error(`expect newest=${ids[2]} first, got: ${myIdsInResp.join(',')}`)
  }
}

async function caseListStatusFilter() {
  await createTestClient()
  const ids = await createN(3, 'B')
  // createN 已把 ids[0], ids[1] 改成 '已支付'，ids[2] 是 '待支付'
  // 把 ids[0] 改回 '待支付' 不能（uq 冲突），改用 '已关闭' 等其他状态以制造 status mix
  // 改 ids[1] → '已关闭'，让 ids[2]='待支付' 单独
  await pgQuery(`UPDATE sale_orders SET status = '已关闭' WHERE sale_order_id = $1`, [ids[1]])
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.list', { status: '待支付' })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const orders = res.data?.orders || []
  const mine = orders.filter(o => ids.includes(o.sale_order_id))
  // 期待 1 条 '待支付'（仅 ids[2]；ids[0]='已支付'、ids[1]='已关闭'）
  if (mine.length !== 1) throw new Error(`expect 1 待支付, got ${mine.length}`)
  for (const o of mine) {
    if (o.status !== '待支付') throw new Error(`expect status=待支付, got ${o.status}`)
  }
}

async function caseListPagination() {
  await createTestClient()
  // createN 会把前 N-1 改成 '已支付'；3 条总数足够分页测试
  await createN(3, 'C')
  // page=1 pageSize=2
  const r1 = await invokeAs(TEST_CLIENT_OPENID, 'order.list', { page: 1, pageSize: 2 })
  if (r1.code !== 0) throw new Error(`p1 code=${r1.code}: ${r1.message}`)
  const p1 = r1.data?.orders || []
  if (p1.length !== 2) throw new Error(`page1 expect 2 rows, got ${p1.length}`)
  if (r1.data.hasMore !== true) throw new Error(`page1 expect hasMore=true`)
  // page=2 pageSize=2 → 1 行
  const r2 = await invokeAs(TEST_CLIENT_OPENID, 'order.list', { page: 2, pageSize: 2 })
  if (r2.code !== 0) throw new Error(`p2 code=${r2.code}: ${r2.message}`)
  const p2 = r2.data?.orders || []
  if (p2.length !== 1) throw new Error(`page2 expect 1 row, got ${p2.length}`)
  if (r2.data.hasMore !== false) throw new Error(`page2 expect hasMore=false`)
}

async function caseDetailHappy() {
  await createTestClient()
  const orderNo = `${NS}_LD_DT1`.slice(0, 30)
  await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 222 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.detail', { saleOrderId: orderNo })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data?.order?.sale_order_id !== orderNo) {
    throw new Error(`order.sale_order_id mismatch: ${res.data?.order?.sale_order_id}`)
  }
  if (!Array.isArray(res.data?.items) || res.data.items.length !== 1) {
    throw new Error(`expect items.length=1, got ${res.data?.items?.length}`)
  }
  if (!Array.isArray(res.data?.payments)) {
    throw new Error(`expect payments array (can be empty), got: ${typeof res.data?.payments}`)
  }
}

async function caseDetailCrossUserDenied() {
  await createTestClient()       // 顾客 A
  await createTestClient2()      // 顾客 B
  const orderNo = `${NS}_LD_XU1`.slice(0, 30)
  // 默认 createTestPendingSaleOrder 把单子绑到顾客 A
  await createTestPendingSaleOrder({ saleOrderId: orderNo, totalAmount: 50 })
  // 顾客 B 调 detail → 路由 WHERE 不命中，报 INVALID_PARAMS: 订单不存在
  const res = await invokeAs(TEST_CLIENT2_OPENID, 'order.detail', { saleOrderId: orderNo })
  // 注：detail 用 WHERE client_user_id 不命中而非显式 PERMISSION_DENIED
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '订单不存在' })
}

const CASES = [
  ['list returns all 3 pending orders in created_at DESC', caseListAll],
  ['list filtered by status returns only matching', caseListStatusFilter],
  ['list paginates with hasMore flag', caseListPagination],
  ['detail returns { order, items, payments }', caseDetailHappy],
  ['detail cross-user denied (WHERE not matched)', caseDetailCrossUserDenied],
]

let pass = 0, fail = 0
console.log(`[order/list-detail.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[order/list-detail.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
