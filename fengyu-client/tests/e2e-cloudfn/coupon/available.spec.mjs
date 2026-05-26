#!/usr/bin/env bun
/**
 * clientApi.coupon.available
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/coupon.js
 *   - requirePhone
 *   - 入参：{ storeId?, storeName?, items: [{ skuId, quantity, amount }] }
 *   - 过滤：status='未使用' AND expire_at>NOW() AND template.is_active=true
 *   - 适用门店：applicable_store_ids 非空时必须包含 storeId
 *   - 适用分类：applicable_category_ids 非空时按 product_skus.category_id 匹配
 *   - 满减门槛：sum(eligibleItems.amount) ≥ min_spend
 *
 * 每个 case 独立 openid/userId 避开 AUTH_CACHE。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_STORE_ID, TEST_PRODUCT_CATEGORY_ID,
  TEST_PRODUCT_ID, TEST_SKU_NORMAL_ID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import {
  createTestSku, createTestCoupon, createTestCouponTemplate,
  cleanupClientExtras, suffixToPhone,
} from '../helpers/client-fixtures.mjs'
import { ensureTestStore, cleanupTestData } from '../helpers/fixtures.mjs'

async function makeClient(suffix) {
  const userId = `${NS}_CLI_${suffix}`
  const openid = `${NS}_CLI_OPENID_${suffix}`
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, $3, $4, '女', $5, '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone`,
    [userId, openid, suffixToPhone(`coupon-avail:${suffix}`), `${NS}_顾客${suffix}`, TEST_STORE_ID]
  )
  return { userId, openid }
}

const ITEMS_100 = [
  { skuId: TEST_SKU_NORMAL_ID, quantity: 1, amount: 100 },
]

async function caseHappy() {
  const { userId, openid } = await makeClient('A1')
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  await createTestCouponTemplate({
    templateId: `${NS}_CTPL_A1`,
    minSpend: '100.00',
    discountValue: '10.00',
  })
  await createTestCoupon({
    couponId: `${NS}_CPN_A1`, templateId: `${NS}_CTPL_A1`, userId, status: '未使用',
  })
  const res = await invokeAs(openid, 'coupon.available', {
    storeId: TEST_STORE_ID,
    items: ITEMS_100,
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const coupons = res.data?.coupons || []
  if (coupons.length !== 1) throw new Error(`expect 1 coupon, got ${coupons.length}`)
  if (coupons[0].couponId !== `${NS}_CPN_A1`) throw new Error('couponId mismatch')
  if (coupons[0].discount !== 10) throw new Error(`discount mismatch: ${coupons[0].discount}`)
}

async function caseBelowThreshold() {
  const { userId, openid } = await makeClient('A2')
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  await createTestCouponTemplate({
    templateId: `${NS}_CTPL_A2`,
    minSpend: '100.00',
    discountValue: '10.00',
  })
  await createTestCoupon({
    couponId: `${NS}_CPN_A2`, templateId: `${NS}_CTPL_A2`, userId, status: '未使用',
  })
  const res = await invokeAs(openid, 'coupon.available', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1, amount: 50 }],
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const coupons = res.data?.coupons || []
  if (coupons.length !== 0) throw new Error(`expect 0 (below min_spend), got ${coupons.length}`)
}

async function caseStoreScope() {
  const { userId, openid } = await makeClient('A3')
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })

  // Step 1: 券限定到其它门店 → 不返回
  await createTestCouponTemplate({
    templateId: `${NS}_CTPL_A3`,
    minSpend: '100.00',
    discountValue: '10.00',
    applicableStoreIds: [`${NS}_OTHER_STORE`],
  })
  await createTestCoupon({
    couponId: `${NS}_CPN_A3`, templateId: `${NS}_CTPL_A3`, userId, status: '未使用',
  })
  let res = await invokeAs(openid, 'coupon.available', {
    storeId: TEST_STORE_ID,
    items: ITEMS_100,
  })
  if (res.code !== 0) throw new Error(`step1 code=${res.code}: ${res.message}`)
  if ((res.data?.coupons || []).length !== 0) {
    throw new Error(`step1 expect 0 (store mismatch), got ${res.data.coupons.length}`)
  }

  // Step 2: 改券模板限定到当前门店 → 返回
  await pgQuery(
    `UPDATE coupon_templates SET applicable_store_ids = $1::text[]
     WHERE template_id = $2`,
    [[TEST_STORE_ID], `${NS}_CTPL_A3`]
  )
  res = await invokeAs(openid, 'coupon.available', {
    storeId: TEST_STORE_ID,
    items: ITEMS_100,
  })
  if (res.code !== 0) throw new Error(`step2 code=${res.code}: ${res.message}`)
  if ((res.data?.coupons || []).length !== 1) {
    throw new Error(`step2 expect 1, got ${res.data?.coupons?.length}`)
  }
}

async function caseCategoryScope() {
  const { userId, openid } = await makeClient('A4')
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  await createTestCouponTemplate({
    templateId: `${NS}_CTPL_A4`,
    minSpend: '100.00',
    discountValue: '10.00',
    applicableCategoryIds: [`${NS}_OTHER_CAT`],
  })
  await createTestCoupon({
    couponId: `${NS}_CPN_A4`, templateId: `${NS}_CTPL_A4`, userId, status: '未使用',
  })
  const res = await invokeAs(openid, 'coupon.available', {
    storeId: TEST_STORE_ID,
    items: ITEMS_100,
  })
  if (res.code !== 0) throw new Error(`code=${res.code}: ${res.message}`)
  if ((res.data?.coupons || []).length !== 0) {
    throw new Error(`expect 0 (category mismatch), got ${res.data.coupons.length}`)
  }
}

async function caseUsedNotReturned() {
  const { userId, openid } = await makeClient('A5')
  await createTestSku({ skuId: TEST_SKU_NORMAL_ID, productId: TEST_PRODUCT_ID })
  await createTestCouponTemplate({
    templateId: `${NS}_CTPL_A5`,
    minSpend: '100.00',
    discountValue: '10.00',
  })
  await createTestCoupon({
    couponId: `${NS}_CPN_A5`, templateId: `${NS}_CTPL_A5`, userId, status: '已使用',
  })
  const res = await invokeAs(openid, 'coupon.available', {
    storeId: TEST_STORE_ID,
    items: ITEMS_100,
  })
  if (res.code !== 0) throw new Error(`code=${res.code}: ${res.message}`)
  if ((res.data?.coupons || []).length !== 0) {
    throw new Error(`expect 0 (used coupon filtered), got ${res.data.coupons.length}`)
  }
}

const CASES = [
  ['happy: 满 100 减 10 → returns coupon', caseHappy],
  ['below min_spend → not returned', caseBelowThreshold],
  ['store scope: other store → no; current store → yes', caseStoreScope],
  ['category scope mismatch → not returned', caseCategoryScope],
  ['used coupon → not returned', caseUsedNotReturned],
]

let pass = 0, fail = 0
console.log(`[coupon-available.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[coupon-available.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
