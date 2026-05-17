#!/usr/bin/env bun
/**
 * clientApi.service.list / detail 全分支
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/service.js
 *
 * 实测要点：
 *   - service_items.sale_item_id NOT NULL FK → sale_items；故创建测试服务单前必须先有 sale_order + sale_item
 *   - service_orders 必填：market_name / store_id / service_date / assigned_employee_id / client_user_id
 *   - detail 跨用户：路由 SQL 加了 `AND so.client_user_id = $2` 守卫，不属于当前用户时抛
 *     '服务单不存在'，包含 INVALID_PARAMS 前缀（路由抛 'INVALID_PARAMS: 服务单不存在'）
 *
 * 用例：
 *   1. list 空                — 新顾客 → records=[]
 *   2. list happy             — 1 条服务单 + 1 条 service_items → 返回 1 条含 items
 *   3. list 分页              — 3 条 → page=1 pageSize=2 → 返回 2 条
 *   4. detail by id           — 返回 serviceOrder + items（明细包含 product_name 等快照）
 *   5. detail 跨用户          — INVALID_PARAMS: 服务单不存在
 */
import '../setup.mjs'
import {
  NS, closePool,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID,
  TEST_CLIENT2_OPENID, TEST_CLIENT2_USER_ID,
  TEST_STORE_ID, TEST_MANAGER_EMP_ID,
  pgQuery, getPool,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import {
  createTestClient, createTestStaff, ensureTestStore,
  createTestSaleOrder, cleanupTestData,
} from '../helpers/fixtures.mjs'
import { cleanupClientExtras, createTestClient2 } from '../helpers/client-fixtures.mjs'

/**
 * 本地辅助：创建一个测试服务单 + service_items 行
 * 依赖：sale_order + sale_item 已存在（先调 createTestSaleOrder）
 */
async function createTestServiceOrder({
  serviceOrderId,
  saleItemId,
  clientUserId = TEST_CLIENT_USER_ID,
  storeId = TEST_STORE_ID,
  employeeId = TEST_MANAGER_EMP_ID,
  status = '待服务',
} = {}) {
  if (!serviceOrderId) throw new Error('createTestServiceOrder: serviceOrderId required')
  if (!saleItemId) throw new Error('createTestServiceOrder: saleItemId required')

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO service_orders (
         service_order_id, status, service_order_type, market_name, store_id,
         service_date, assigned_employee_id, client_user_id
       )
       VALUES ($1, $2::service_order_status, '售前'::service_order_type, $3, $4,
               CURRENT_DATE, $5, $6)`,
      [serviceOrderId, status, `${NS}_市场`, storeId, employeeId, clientUserId]
    )
    const itemId = `${serviceOrderId}_SI1`
    await client.query(
      `INSERT INTO service_items (
         service_item_id, sale_item_id, service_order_id,
         session_used, employee_id, service_duration
       )
       VALUES ($1, $2, $3, 1, $4, 60)`,
      [itemId, saleItemId, serviceOrderId, employeeId]
    )
    await client.query('COMMIT')
    return { serviceOrderId, serviceItemId: itemId }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

async function caseListEmpty() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!Array.isArray(res.data.records) || res.data.records.length !== 0) {
    throw new Error(`expect empty records, got ${JSON.stringify(res.data.records)}`)
  }
}

async function caseListHappy() {
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  const orderId = `${NS}_ORD_SVC1`
  const { saleItemId } = await createTestSaleOrder({
    saleOrderId: orderId,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  await createTestServiceOrder({
    serviceOrderId: `${NS}_SVC_001`,
    saleItemId,
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.list', {})
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.records.length !== 1) {
    throw new Error(`expect 1 record, got ${res.data.records.length}`)
  }
  const rec = res.data.records[0]
  if (rec.service_order_id !== `${NS}_SVC_001`) {
    throw new Error(`service_order_id mismatch: ${rec.service_order_id}`)
  }
  if (!Array.isArray(rec.items) || rec.items.length !== 1) {
    throw new Error(`expect 1 item, got ${rec.items?.length}`)
  }
}

async function caseListPagination() {
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  for (let i = 0; i < 3; i++) {
    const orderId = `${NS}_ORD_PAGE_${i}`
    const { saleItemId } = await createTestSaleOrder({
      saleOrderId: orderId,
      clientUserId: TEST_CLIENT_USER_ID,
    })
    await createTestServiceOrder({
      serviceOrderId: `${NS}_SVC_PAGE_${i}`,
      saleItemId,
    })
    await new Promise(r => setTimeout(r, 3))
  }
  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.list', { page: 1, pageSize: 2 })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.records.length !== 2) {
    throw new Error(`expect 2 records (pageSize=2), got ${res.data.records.length}`)
  }
}

async function caseDetailById() {
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  const orderId = `${NS}_ORD_DET1`
  const { saleItemId } = await createTestSaleOrder({
    saleOrderId: orderId,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  const svcId = `${NS}_SVC_DET1`
  await createTestServiceOrder({ serviceOrderId: svcId, saleItemId })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.detail', { serviceOrderId: svcId })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (!res.data.serviceOrder) throw new Error(`expect serviceOrder, got ${JSON.stringify(res.data)}`)
  if (res.data.serviceOrder.service_order_id !== svcId) {
    throw new Error(`serviceOrder.service_order_id mismatch: ${res.data.serviceOrder.service_order_id}`)
  }
  if (!Array.isArray(res.data.items) || res.data.items.length !== 1) {
    throw new Error(`expect 1 item, got ${res.data.items?.length}`)
  }
  if (!res.data.items[0].product_name) {
    throw new Error(`expect items[0].product_name from sale_items snapshot`)
  }
}

async function caseDetailCrossUserDenied() {
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  await createTestClient2()
  // 服务单挂在 client2 名下
  const orderId = `${NS}_ORD_CROSS`
  const { saleItemId } = await createTestSaleOrder({
    saleOrderId: orderId,
    clientUserId: TEST_CLIENT2_USER_ID,
  })
  const svcId = `${NS}_SVC_CROSS`
  await createTestServiceOrder({
    serviceOrderId: svcId,
    saleItemId,
    clientUserId: TEST_CLIENT2_USER_ID,
  })

  // client1 尝试看 client2 的服务单
  const res = await invokeAs(TEST_CLIENT_OPENID, 'service.detail', { serviceOrderId: svcId })
  if (res.code === 0) throw new Error(`expect non-zero (cross-user denied), got code=0`)
  if (!/服务单不存在|INVALID_PARAMS/.test(res.message || '')) {
    throw new Error(`expect '服务单不存在' or INVALID_PARAMS, got "${res.message}"`)
  }
}

const CASES = [
  ['list empty → []', caseListEmpty],
  ['list 1 service order → returns with items', caseListHappy],
  ['list pagination → pageSize=2 returns 2 of 3', caseListPagination],
  ['detail by serviceOrderId → serviceOrder + items snapshot', caseDetailById],
  ['detail cross-user → service order not found', caseDetailCrossUserDenied],
]

let pass = 0, fail = 0
console.log(`[service/list-detail.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[service/list-detail.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
