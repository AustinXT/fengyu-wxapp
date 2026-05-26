#!/usr/bin/env bun
/**
 * 跨端契约：admin /legacy-orders 导入的历史订单（legacy_source='workfine', status='未审核'）
 * 在 client.order.list / order.detail 的可见性。
 *
 * 关于 admin 端：
 *   - admin Server Action approveLegacyOrder 需要 Next.js Server Action context，无法直 import；
 *     fengyu-admin/tests/e2e-actions/_admin-preload.mjs 用 bun --preload 注入 mock。
 *   - 本 spec 选 pseudo path：用 pgQuery 直接 INSERT 模拟 admin import-workfine-legacy 写入。
 *
 * 实际 schema 契约（db/schema/order.ts:96-105）：
 *   - legacy_source        text NULL → 'workfine' 标记历史订单
 *   - status               '未审核' 初始态，admin approve 后转 '已支付'
 *   - legacy_customer_id   text WorkFine 顾客编号
 *   - legacy_raw_snapshot  jsonb 原始 4 字段快照
 *
 * client.order.list 行为契约（routes/order.js line 911-960）：
 *   - 强制 WHERE o.client_user_id = $userId
 *   - 无 status 过滤时返回所有状态（含 '未审核'/'待支付'/'已支付'/'已关闭' 等）
 *   - 无 legacy_source 过滤
 *
 * 该 spec 验证：
 *   - case A: legacy with client_user_id=NULL（admin 未匹配）→ 在 client.list 不可见（按 user_id 过滤）
 *   - case B: 普通订单（status='已支付'）→ 在 client.list 可见（对照组）
 *   - case C: legacy with client_user_id=TEST_CLIENT_USER_ID 已 matched，status='未审核' →
 *             实际会出现在 client.list（无 status='未审核' 过滤）— 这是当前合同；
 *             如未来收紧需在 routes/order.js 加 status NOT '未审核' 过滤
 *
 * 该 spec 把当前合同写死，未来改宽/改严即失败。
 */
import './setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE,
  TEST_STORE_ID,
} from './setup.mjs'
import { invokeAs, expectError } from './helpers/invoke-client.mjs'
import {
  ensureCrossEndStore, createCrossClient, cleanupCrossEnd,
} from './helpers/fixtures-cross.mjs'

/**
 * 模拟 admin /legacy-orders 端 import-workfine-legacy.js 写入历史订单
 */
async function adminLikeImportLegacy({
  saleOrderId,
  clientUserId = null,
  status = '未审核',
  totalAmount = '500.00',
} = {}) {
  await pgQuery(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, client_user_id, client_phone, customer_name,
       total_amount, prepaid_card_amount, payable_amount, received,
       payment_method, allocation_status,
       legacy_source, legacy_customer_id, legacy_raw_snapshot
     )
     VALUES ($1, $2::order_status, '销售单'::sale_order_type, $3, $4,
             NOW() - INTERVAL '1 year', $5, $6, $7,
             $8::numeric, 0, 0, $8::numeric,
             '线下'::payment_method, '待分配'::allocation_status,
             'workfine', 'WF_TEST_123',
             $9::jsonb)`,
    [
      saleOrderId, status, `${NS}_市场`, TEST_STORE_ID,
      clientUserId, TEST_CLIENT_PHONE, `${NS}_顾客历史`,
      totalAmount,
      JSON.stringify({
        legacy_order_no: saleOrderId, phone: TEST_CLIENT_PHONE,
        store_name: 'legacy_store', amount: totalAmount,
        sale_date: '2025-05-01', customer_id: 'WF_TEST_123', customer_name: '历史顾客',
      }),
    ]
  )
}

/** 插入对照组：普通已支付订单 */
async function insertNormalPaidOrder({ saleOrderId, totalAmount = '88.00' } = {}) {
  await pgQuery(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, client_user_id, client_phone, customer_name,
       total_amount, prepaid_card_amount, payable_amount, received,
       payment_method, allocation_status
     )
     VALUES ($1, '已支付'::order_status, '销售单'::sale_order_type, $2, $3,
             NOW(), $4, $5, $6,
             $7::numeric, 0, 0, $7::numeric,
             '微信'::payment_method, '待分配'::allocation_status)`,
    [saleOrderId, `${NS}_市场`, TEST_STORE_ID,
     TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, `${NS}_顾客`, totalAmount]
  )
}

async function caseLegacyUnmatchedNotVisibleInList() {
  await ensureCrossEndStore()
  await createCrossClient({ balance: 0 })
  const legacyId = `${NS}_LGCY_UN`.slice(0, 30)
  const normalId = `${NS}_NORM_OK`.slice(0, 30)
  // 未匹配历史订单（client_user_id=NULL）
  await adminLikeImportLegacy({ saleOrderId: legacyId, clientUserId: null })
  // 对照组：普通订单
  await insertNormalPaidOrder({ saleOrderId: normalId })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.list', {})
  if (res.code !== 0) throw new Error(`order.list failed: ${res.message}`)
  const orders = res.data?.orders || res.data?.list || res.data || []
  const ids = orders.map((o) => o.saleOrderId || o.sale_order_id || o.orderNo)
  if (!ids.includes(normalId)) throw new Error(`expect ${normalId} in list, got: ${JSON.stringify(ids)}`)
  if (ids.includes(legacyId)) {
    throw new Error(`expect unmatched legacy ${legacyId} NOT in list (client_user_id=NULL), got: ${JSON.stringify(ids)}`)
  }
}

async function caseLegacyUnmatchedDetailNotFound() {
  await ensureCrossEndStore()
  await createCrossClient({ balance: 0 })
  const legacyId = `${NS}_LGCY_DT`.slice(0, 30)
  await adminLikeImportLegacy({ saleOrderId: legacyId, clientUserId: null })

  // client.order.detail 路由对未找到/不可见订单返回 INVALID_PARAMS（routes/order.js:1024）
  // — 不是 NOT_FOUND，因为路由实现把"订单不存在"和"client_user_id 不匹配"合并报 INVALID_PARAMS
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.detail', { saleOrderId: legacyId })
  expectError(res, 'INVALID_PARAMS', { messageIncludes: '订单' })
}

async function caseLegacyMatchedContractCurrentlyVisible() {
  // 文档化当前合同：legacy 订单一旦 admin 匹配上 client_user_id 后，会出现在 client.list。
  // 这是当前 routes/order.js 实现没有 legacy_source 排除的事实，不是 bug 也不是预期；
  // 未来如要改宽 → 直接改本 case 的断言极性。
  await ensureCrossEndStore()
  await createCrossClient({ balance: 0 })
  const legacyId = `${NS}_LGCY_MT`.slice(0, 30)
  await adminLikeImportLegacy({
    saleOrderId: legacyId,
    clientUserId: TEST_CLIENT_USER_ID,
    status: '未审核',
  })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.list', {})
  if (res.code !== 0) throw new Error(`order.list failed: ${res.message}`)
  const orders = res.data?.orders || res.data?.list || res.data || []
  const ids = orders.map((o) => o.saleOrderId || o.sale_order_id || o.orderNo)
  // 当前合同：matched legacy 可见
  if (!ids.includes(legacyId)) {
    throw new Error(
      `当前合同：matched legacy (client_user_id 已绑) 应出现在 client.list 中。\n` +
      `若该断言失败，说明 routes/order.js 加了 legacy_source 过滤 — 请更新本 spec。\n` +
      `got: ${JSON.stringify(ids)}`
    )
  }
  // 该订单 status='未审核'
  const order = orders.find((o) => (o.saleOrderId || o.sale_order_id || o.orderNo) === legacyId)
  if (order && order.status && order.status !== '未审核') {
    throw new Error(`expect matched legacy status='未审核', got: ${order.status}`)
  }
}

const CASES = [
  ['未匹配 legacy (client_user_id=NULL) 在 client.list 不可见', caseLegacyUnmatchedNotVisibleInList],
  ['未匹配 legacy 调 order.detail → INVALID_PARAMS 不存在', caseLegacyUnmatchedDetailNotFound],
  ['已匹配 legacy (admin 已 link) 当前合同在 client.list 可见', caseLegacyMatchedContractCurrentlyVisible],
]

let pass = 0, fail = 0
console.log(`[cross-end/legacy-orders-visibility] start | ${CASES.length} cases | ${new Date().toISOString()}`)
try {
  for (const [name, fn] of CASES) {
    await cleanupCrossEnd(NS)
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
  await cleanupCrossEnd(NS)
  await closePool()
}
console.log(`[cross-end/legacy-orders-visibility] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
