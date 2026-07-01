#!/usr/bin/env bun
/**
 * clientApi.order.create
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js (line 160 create)
 *
 * 重要发现/差异：
 *   - 路由要求 storeId + items + paymentMethod 三个参数全必填；缺一即 INVALID_PARAMS: 参数不完整
 *   - "已有待支付订单" → INVALID_PARAMS: 您已有待支付订单… (不是替换语义)
 *   - 过期清理阈值是 10 分钟（不是 30），且仅清理 NOW()-10min 之前的 '待支付'，新单照常创建
 *   - SKU is_enabled=false 不会被 create 拒绝：路由查询 product_skus 时未过滤 is_enabled
 *     → 仍能下单。本 spec 用"不存在的 sku_id"代替来触发 INVALID_PARAMS
 *   - 体验卡 SKU (is_experience=true) 路由不拒绝；下单后 is_experience 字段透传到 sale_items
 *   - 订单号格式 FY-XSD-WX-{YYMMDD}{4位}，日期来自 now.toISOString().slice(2,10)
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
  TEST_SKU_NORMAL_ID, TEST_SKU_EXPERIENCE_ID, TEST_PRODUCT_ID,
  TEST_CLIENT_PHONE, TEST_MANAGER_EMP_ID, getPool,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import { ensureTestStore, createTestClient, createTestStaff, cleanupTestData } from '../helpers/fixtures.mjs'
import {
  ensureTestCategories, createTestSku, createTestProduct,
  cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'

// 不带 phone 的 openid（PHONE_REQUIRED 测试用）
const NOPHONE_USER_ID = `${NS}_CLI_NOP`
const NOPHONE_OPENID = `${NS}_CLI_NOP_OPENID`

async function ensureNoPhoneClient() {
  // 先确保 test store 存在（bound_store_id FK 依赖 stores 表）
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, NULL, $3, '女', $4, '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = NULL,
           bound_store_id = EXCLUDED.bound_store_id`,
    [NOPHONE_USER_ID, NOPHONE_OPENID, `${NS}_无手机`, TEST_STORE_ID]
  )
}

const ORDER_NO_RE = /^FY-XSD-WX-\d{6}\d{4}$/

async function caseHappySingleSku() {
  await createTestClient()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '120.00' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const orderNo = res.data?.saleOrderId || res.data?.orderNo
  if (!ORDER_NO_RE.test(orderNo)) throw new Error(`orderNo format mismatch: ${orderNo}`)
  if (res.data.status !== '待支付') throw new Error(`expect status=待支付, got ${res.data.status}`)
  // PG 校验
  const rows = await pgQuery(
    `SELECT status, total_amount, sale_order_id FROM sale_orders
     WHERE sale_order_id = $1 AND client_user_id = $2`,
    [orderNo, TEST_CLIENT_USER_ID]
  )
  if (rows.length !== 1) throw new Error(`expect 1 sale_orders row, got ${rows.length}`)
  if (rows[0].status !== '待支付') throw new Error(`PG status mismatch: ${rows[0].status}`)
  if (Number(rows[0].total_amount) !== 120) throw new Error(`total_amount mismatch: ${rows[0].total_amount}`)
  const items = await pgQuery(
    `SELECT sale_item_id, quantity FROM sale_items WHERE sale_order_id = $1`,
    [orderNo]
  )
  if (items.length !== 1) throw new Error(`expect 1 sale_items row, got ${items.length}`)
}

async function caseMultiSkuQuantity() {
  await createTestClient()
  // 两个不同 SKU：100 元 x1，50 元 x2 = 200
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '100.00' })
  const sku2 = `${NS}_SKU_N2`
  const product2 = `${NS}_PROD_2`
  await createTestSku({ skuId: sku2, productId: product2, price: '50.00' })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [
      { skuId: TEST_SKU_NORMAL_ID, quantity: 1 },
      { skuId: sku2, quantity: 2 },
    ],
    paymentMethod: '微信',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const orderNo = res.data.saleOrderId
  const items = await pgQuery(
    `SELECT sku_id, quantity, sale_amount FROM sale_items WHERE sale_order_id = $1 ORDER BY sku_id`,
    [orderNo]
  )
  if (items.length !== 2) throw new Error(`expect 2 sale_items rows, got ${items.length}`)
  const sumAmount = items.reduce((s, r) => s + Number(r.sale_amount), 0)
  if (sumAmount !== 200) throw new Error(`sum sale_amount mismatch: ${sumAmount}`)
  const orderRow = await pgQuery(`SELECT total_amount FROM sale_orders WHERE sale_order_id = $1`, [orderNo])
  if (Number(orderRow[0].total_amount) !== 200) throw new Error(`total_amount=${orderRow[0].total_amount}`)
}

async function caseInvalidSkuRejected() {
  await createTestClient()
  // 不传 skuId / 传不存在 sku → 路由 INVALID_PARAMS: SKU xxx 不存在
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: `${NS}_NOEXIST_SKU`, quantity: 1 }],
    paymentMethod: '微信',
  })
  expectError(res, 'INVALID_PARAMS')
}

async function caseMissingItems() {
  await createTestClient()
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [],
    paymentMethod: '微信',
  })
  expectError(res, 'INVALID_PARAMS')
}

async function casePhoneRequired() {
  await ensureNoPhoneClient()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  const res = await invokeAs(NOPHONE_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  expectError(res, 'PHONE_REQUIRED')
}

async function caseCloseExpiredThenCreate() {
  await createTestClient()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '88.00' })
  // 先手工插入一个 sale_order_datetime 在 NOW()-15min 的 '待支付' 旧单
  const expiredOrderNo = `FY-XSD-WX-${NS.slice(0,6)}OLD1`.slice(0, 30)
  // 简化：用合法格式但日期年份不重要，关键是 sale_order_datetime
  const oldOrderNo = `FY-XSD-WX-2510109999` // 占位 ID，长度合规
  await pgQuery(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, client_user_id, client_phone, customer_name,
       total_amount, prepaid_card_amount, payable_amount, received,
       payment_method, allocation_status
     ) VALUES ($1, '待支付'::order_status, '销售单'::sale_order_type, $2, $3,
               NOW() - INTERVAL '15 minutes', $4, '19999099002', $5,
               99, 0, 99, 0,
               '微信'::payment_method, '待分配'::allocation_status)
     ON CONFLICT (sale_order_id) DO UPDATE SET sale_order_datetime = EXCLUDED.sale_order_datetime, status = '待支付'`,
    [oldOrderNo, `${NS}_市场`, TEST_STORE_ID, TEST_CLIENT_USER_ID, `${NS}_顾客`]
  )
  // 触发 create → closeExpiredOrdersByUser 会先把旧单置 '已关闭'，然后新单创建
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  // 旧单状态应为 '已关闭'
  const oldRow = await pgQuery(`SELECT status FROM sale_orders WHERE sale_order_id = $1`, [oldOrderNo])
  if (oldRow[0].status !== '已关闭') {
    throw new Error(`expect old order='已关闭', got: ${oldRow[0].status}`)
  }
  // 清理插入的占位旧单（这条不带 NS 前缀，cleanupTestData LIKE 不到）
  await pgQuery(`DELETE FROM sale_items WHERE sale_order_id = $1`, [oldOrderNo])
  await pgQuery(`DELETE FROM sale_orders WHERE sale_order_id = $1`, [oldOrderNo])
}

async function caseSequentialOrderNoIncrement() {
  await createTestClient()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '50.00' })
  const r1 = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (r1.code !== 0) throw new Error(`order1 fail: ${r1.message}`)
  const orderNo1 = r1.data.saleOrderId
  // 取消第一单（路由 cancel 把状态置 '已关闭'）让第二单可以建
  const cnl = await invokeAs(TEST_CLIENT_OPENID, 'order.cancel', { saleOrderId: orderNo1 })
  if (cnl.code !== 0) throw new Error(`cancel order1 fail: ${cnl.message}`)
  const r2 = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (r2.code !== 0) throw new Error(`order2 fail: ${r2.message}`)
  const orderNo2 = r2.data.saleOrderId
  // 同一日期，序号 +1
  const dateA = orderNo1.slice(11, 17)
  const dateB = orderNo2.slice(11, 17)
  const seqA = parseInt(orderNo1.slice(-4), 10)
  const seqB = parseInt(orderNo2.slice(-4), 10)
  if (dateA !== dateB) {
    // 跨天直接通过（罕见，午夜跑测试时可能命中）
    return
  }
  if (seqB !== seqA + 1) {
    throw new Error(`expect seq+1: ${orderNo1} → ${orderNo2}`)
  }
}

async function caseExperienceSkuAllowed() {
  await createTestClient()
  await createTestSku({
    skuId: TEST_SKU_EXPERIENCE_ID, productId: `${NS}_PROD_EXP`,
    productType: '疗程卡', price: '30.00', isExperience: true,
  })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_EXPERIENCE_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  // 路由未拒绝体验卡，allow
  if (res.code !== 0) throw new Error(`expect code=0 (experience SKU allowed by route), got ${res.code}: ${res.message}`)
  const items = await pgQuery(
    `SELECT is_experience FROM sale_items WHERE sale_order_id = $1`,
    [res.data.saleOrderId]
  )
  if (items[0].is_experience !== true) throw new Error(`expect is_experience=true snapshot`)
}

/**
 * 创建员工开单的"待支付"销售单（opened_by 非空）
 * 用于验证 uq_sale_orders_client_pending 放开后，员工单不再阻塞顾客自助下单。
 * datetimeExpr 可回拨 sale_order_datetime（验证 #27 守卫：员工单不被懒清理）。
 */
async function createStaffOpenedPending({ saleOrderId, totalAmount = 300, datetimeExpr = 'NOW()' }) {
  const pool = getPool()
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    await conn.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, allocation_status, opened_by
       )
       VALUES ($1, '待支付'::order_status, '销售单'::sale_order_type, $2, $3,
               ${datetimeExpr}, $4, $5, $6,
               $7, 0, $7, 0,
               '微信'::payment_method, '待分配'::allocation_status, $8)`,
      [saleOrderId, `${NS}_市场`, TEST_STORE_ID,
       TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, `${NS}_顾客`,
       totalAmount, TEST_MANAGER_EMP_ID]
    )
    await conn.query('COMMIT')
  } catch (e) {
    await conn.query('ROLLBACK')
    throw e
  } finally {
    conn.release()
  }
}

async function caseStaffPendingDoesNotBlockSelfOrder() {
  await createTestClient()
  await createTestStaff()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '120.00' })
  // 先手工插入一笔员工开单（opened_by 非空）的待支付单
  const staffOrderNo = `${NS}_SO_STAFF`.slice(0, 30)
  await createStaffOpenedPending({ saleOrderId: staffOrderNo, totalAmount: 300 })
  // uq 放开后：顾客仍可自助下单（opened_by NULL），应成功
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (res.code !== 0) throw new Error(`expect code=0 (self order allowed alongside staff pending), got ${res.code}: ${res.message}`)
  if (res.data.status !== '待支付') throw new Error(`expect status=待支付, got ${res.data.status}`)
  // 新建的自助单 opened_by 必须为 NULL（顾客自助下单，无 opened_by）
  const selfRow = await pgQuery(`SELECT opened_by FROM sale_orders WHERE sale_order_id = $1`, [res.data.saleOrderId])
  if (selfRow[0].opened_by !== null) {
    throw new Error(`self order opened_by should be NULL, got: ${selfRow[0].opened_by}`)
  }
  // 员工单仍存在且仍为待支付
  const staffRow = await pgQuery(`SELECT status, opened_by FROM sale_orders WHERE sale_order_id = $1`, [staffOrderNo])
  if (staffRow[0].status !== '待支付') throw new Error(`staff order status mismatch: ${staffRow[0].status}`)
  if (!staffRow[0].opened_by) throw new Error(`staff order opened_by should be non-null`)
}

async function caseExpiredStaffOrderSurvivesSelfOrder() {
  await createTestClient()
  await createTestStaff()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '120.00' })
  // 员工单 sale_order_datetime 回拨到 11 分钟前（>10min 自助下单超时阈值）
  const staffOrderNo = `${NS}_SO_STAFF_OLD`.slice(0, 30)
  await createStaffOpenedPending({
    saleOrderId: staffOrderNo,
    totalAmount: 300,
    datetimeExpr: "NOW() - INTERVAL '11 minutes'",
  })
  // 顾客自助下单 → order.create 先跑 closeExpiredOrdersByUser，但员工单（opened_by 非空）
  // 受 #27 守卫豁免懒清理，应存活；自助单正常创建。
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  // 员工单仍存活（不被 closeExpiredOrdersByUser 清理），仍为待支付
  const staffRow = await pgQuery(`SELECT status, opened_by FROM sale_orders WHERE sale_order_id = $1`, [staffOrderNo])
  if (staffRow[0].status !== '待支付') {
    throw new Error(`expired staff order should survive (#27 opened_by guard), got status: ${staffRow[0].status}`)
  }
  if (!staffRow[0].opened_by) throw new Error(`staff order opened_by should be non-null`)
}

async function caseSelfOrderStillUnique() {
  await createTestClient()
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID, price: '50.00' })
  // 第一笔自助单（opened_by NULL）成功
  const r1 = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (r1.code !== 0) throw new Error(`first self order should succeed, got ${r1.code}: ${r1.message}`)
  // 第二笔自助单 → 仍受 uq + 业务守卫拦截（INVALID_PARAMS）
  const r2 = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  expectError(r2, 'INVALID_PARAMS')
}

const CASES = [
  ['happy single SKU → status=待支付 + order_no format', caseHappySingleSku],
  ['multi SKU + quantity > 1 → 2 sale_items + total summed', caseMultiSkuQuantity],
  ['invalid (non-existent) SKU → INVALID_PARAMS', caseInvalidSkuRejected],
  ['empty items → INVALID_PARAMS', caseMissingItems],
  ['no phone bound → PHONE_REQUIRED', casePhoneRequired],
  ['create closes expired pending order then creates new', caseCloseExpiredThenCreate],
  ['two sequential creates → same-day seq +1', caseSequentialOrderNoIncrement],
  ['experience SKU is accepted (route does not reject)', caseExperienceSkuAllowed],
  ['staff-opened pending order does not block self order (uq opened_by dimension)', caseStaffPendingDoesNotBlockSelfOrder],
  ['expired staff order (>10min) survives closeExpiredOrdersByUser (#27 opened_by guard)', caseExpiredStaffOrderSurvivesSelfOrder],
  ['self pending order still unique → second self order INVALID_PARAMS', caseSelfOrderStillUnique],
]

let pass = 0, fail = 0
console.log(`[order/create.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[order/create.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
