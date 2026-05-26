#!/usr/bin/env bun
/**
 * clientApi.order.create — 组合套餐分支
 *
 * 覆盖：
 *   - bundleProductId 校验：商品需 is_bundle=true 且未删除
 *   - 套餐 SKU 归属校验：items.skuId 必须都属于该 bundle
 *   - 分组配额校验：N 选 M / 全选 两种 pickCount 都要满足
 *   - 定价：unit_real_price 取 mall_product_skus.bundle_price（admin 一致）
 *
 * 仅本 spec 改后端 order.create，不依赖其它模块。
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID,
  TEST_MALL_CATEGORY_ID, TEST_PRODUCT_CATEGORY_ID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import { cleanupTestData } from '../helpers/fixtures.mjs'
import {
  ensureTestCategories, createTestProduct, createTestSku,
  cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'

const BUNDLE_PRODUCT_ID = `${NS}_BUNDLE_P`
const OUTSIDE_PRODUCT_ID = `${NS}_PROD_OUT`
const SKU_A_ID = `${NS}_BSKU_A` // 组1 - N 选 M
const SKU_B_ID = `${NS}_BSKU_B` // 组1
const SKU_C_ID = `${NS}_BSKU_C` // 组2 - 全选
const SKU_D_ID = `${NS}_BSKU_D` // 组2 - 全选
const SKU_OUTSIDE_ID = `${NS}_BSKU_OUT` // 不在 bundle 内

/** 构造一份套餐数据：2 组，组1=2 选 1（A 或 B，每个 ¥40），组2=全选（C+D 必填，C=¥300 / D=¥0） */
async function seedBundle() {
  await ensureTestCategories()

  // 1. bundle 主商品 + 一个无关商品（用于"跨 bundle SKU"测试）
  await createTestProduct({
    productId: BUNDLE_PRODUCT_ID,
    name: `${NS}_测试大礼包`,
    price: '300.00',
    isBundle: true,
  })
  await createTestProduct({
    productId: OUTSIDE_PRODUCT_ID,
    name: `${NS}_无关商品`,
    price: '100.00',
    isBundle: false,
  })

  // 2. 4 个套餐 SKU + 1 个外部 SKU（createTestSku 默认会插入 mall_product_skus 关联）
  // 套餐 SKU：linkToProduct=false 后手动 INSERT mall_product_skus 带 bundle_group_id + bundle_price
  for (const skuId of [SKU_A_ID, SKU_B_ID]) {
    await createTestSku({
      skuId, productId: BUNDLE_PRODUCT_ID,
      productType: '单品', price: '49.80', sessionCount: null,
      linkToProduct: false,
    })
  }
  for (const skuId of [SKU_C_ID, SKU_D_ID]) {
    await createTestSku({
      skuId, productId: BUNDLE_PRODUCT_ID,
      productType: '疗程卡', price: '362.00', sessionCount: 10,
      linkToProduct: false,
    })
  }
  await createTestSku({
    skuId: SKU_OUTSIDE_ID, productId: OUTSIDE_PRODUCT_ID,
    productType: '单品', price: '100.00', sessionCount: null,
  })

  // 3. 两个 group
  const grp1Rows = await pgQuery(
    `INSERT INTO mall_bundle_groups (product_id, group_name, pick_count, sort_order)
     VALUES ($1, $2, 1, 0) RETURNING id`,
    [BUNDLE_PRODUCT_ID, `${NS}_组1选1`]
  )
  const grp2Rows = await pgQuery(
    `INSERT INTO mall_bundle_groups (product_id, group_name, pick_count, sort_order)
     VALUES ($1, $2, NULL, 1) RETURNING id`,
    [BUNDLE_PRODUCT_ID, `${NS}_组2全选`]
  )
  const grp1 = grp1Rows[0].id
  const grp2 = grp2Rows[0].id

  // 4. mall_product_skus 关联：组1 SKU bundlePrice=40，组2 SKU bundlePrice=300/0
  await pgQuery(
    `INSERT INTO mall_product_skus (product_id, sku_id, bundle_group_id, bundle_price, sort_order)
     VALUES
       ($1, $2, $3, 40.00, 0),
       ($1, $4, $3, 40.00, 1),
       ($1, $5, $6, 300.00, 2),
       ($1, $7, $6, 0.00, 3)
     ON CONFLICT (product_id, sku_id) DO UPDATE
       SET bundle_group_id = EXCLUDED.bundle_group_id,
           bundle_price = EXCLUDED.bundle_price`,
    [BUNDLE_PRODUCT_ID,
     SKU_A_ID, grp1,
     SKU_B_ID,
     SKU_C_ID, grp2,
     SKU_D_ID]
  )

  return { grp1, grp2 }
}

async function ensureClient() {
  // createTestClient 复用：sale_orders FK 依赖 client_wechat_users + 手机号
  const { createTestClient } = await import('../helpers/fixtures.mjs')
  await createTestClient()
}

async function clearExistingPendings() {
  // 清掉前一个用例可能遗留的待支付订单（FK 阻塞）
  await pgQuery(
    `UPDATE sale_orders SET status = '已关闭' WHERE client_user_id = $1 AND status = '待支付'`,
    [TEST_CLIENT_USER_ID]
  )
}

async function caseHappy() {
  await ensureClient()
  await seedBundle()
  await clearExistingPendings()

  // 组1 选 A；组2 必选 C+D（全选）
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    bundleProductId: BUNDLE_PRODUCT_ID,
    items: [
      { skuId: SKU_A_ID, quantity: 1 },
      { skuId: SKU_C_ID, quantity: 1 },
      { skuId: SKU_D_ID, quantity: 1 },
    ],
    paymentMethod: '线下',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const orderNo = res.data?.saleOrderId
  // sale_items 三行：sale_amount = bundle_price × quantity（行总额，权威）；
  // unit_real_price 为 per-session 单次价 = sale_amount / session_count（卡）/ quantity（非卡）。
  const items = await pgQuery(
    `SELECT sku_id, unit_price, unit_real_price, sale_amount, quantity, session_count
     FROM sale_items WHERE sale_order_id = $1 ORDER BY sku_id`,
    [orderNo]
  )
  if (items.length !== 3) throw new Error(`expect 3 sale_items, got ${items.length}`)
  const byKey = Object.fromEntries(items.map(i => [i.sku_id, i]))
  // SKU_A：单品（session_count=null），bundle_price=40，per-session 退化为 per-unit = 40
  if (Number(byKey[SKU_A_ID].unit_real_price) !== 40) {
    throw new Error(`SKU_A unit_real_price expect 40, got ${byKey[SKU_A_ID].unit_real_price}`)
  }
  // SKU_C：10次疗程卡，bundle_price=300 → sale_amount=300，per-session = 300/10 = 30
  if (Number(byKey[SKU_C_ID].unit_real_price) !== 30) {
    throw new Error(`SKU_C unit_real_price expect 30 (per-session 300/10), got ${byKey[SKU_C_ID].unit_real_price}`)
  }
  if (Number(byKey[SKU_D_ID].unit_real_price) !== 0) {
    throw new Error(`SKU_D unit_real_price expect 0, got ${byKey[SKU_D_ID].unit_real_price}`)
  }
  // unit_price 仍是 product_skus.price 快照
  if (Number(byKey[SKU_A_ID].unit_price) !== 49.8) {
    throw new Error(`SKU_A unit_price snapshot expect 49.8, got ${byKey[SKU_A_ID].unit_price}`)
  }
  // total_amount = sum(bundle_price) = 40 + 300 + 0 = 340
  const orderRows = await pgQuery(
    `SELECT total_amount FROM sale_orders WHERE sale_order_id = $1`,
    [orderNo]
  )
  if (Number(orderRows[0].total_amount) !== 340) {
    throw new Error(`total_amount expect 340 (sum of bundle prices), got ${orderRows[0].total_amount}`)
  }
}

async function caseMissingPickFromGroup1() {
  await ensureClient()
  await seedBundle()
  await clearExistingPendings()

  // 组1 漏选；只交了组2 → BUNDLE_GROUP_PICK_MISMATCH
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    bundleProductId: BUNDLE_PRODUCT_ID,
    items: [
      { skuId: SKU_C_ID, quantity: 1 },
      { skuId: SKU_D_ID, quantity: 1 },
    ],
    paymentMethod: '线下',
  })
  if (res.code === 0) throw new Error(`expect error, got success`)
  if (!/BUNDLE_GROUP_PICK_MISMATCH/.test(res.message || '')) {
    throw new Error(`expect BUNDLE_GROUP_PICK_MISMATCH, got: ${res.message}`)
  }
}

async function caseAllSelectGroupMissingOne() {
  await ensureClient()
  await seedBundle()
  await clearExistingPendings()

  // 组2 全选要求 C+D，只交 C → BUNDLE_GROUP_PICK_MISMATCH
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    bundleProductId: BUNDLE_PRODUCT_ID,
    items: [
      { skuId: SKU_A_ID, quantity: 1 },
      { skuId: SKU_C_ID, quantity: 1 },
    ],
    paymentMethod: '线下',
  })
  if (res.code === 0) throw new Error(`expect error, got success`)
  if (!/BUNDLE_GROUP_PICK_MISMATCH/.test(res.message || '')) {
    throw new Error(`expect BUNDLE_GROUP_PICK_MISMATCH, got: ${res.message}`)
  }
}

async function caseSkuNotBelong() {
  await ensureClient()
  await seedBundle()
  await clearExistingPendings()

  // 混进无关 bundle 的 SKU → BUNDLE_SKU_NOT_BELONG
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    bundleProductId: BUNDLE_PRODUCT_ID,
    items: [
      { skuId: SKU_A_ID, quantity: 1 },
      { skuId: SKU_C_ID, quantity: 1 },
      { skuId: SKU_D_ID, quantity: 1 },
      { skuId: SKU_OUTSIDE_ID, quantity: 1 },
    ],
    paymentMethod: '线下',
  })
  if (res.code === 0) throw new Error(`expect error, got success`)
  if (!/BUNDLE_SKU_NOT_BELONG/.test(res.message || '')) {
    throw new Error(`expect BUNDLE_SKU_NOT_BELONG, got: ${res.message}`)
  }
}

async function caseBundleNotFound() {
  await ensureClient()
  await seedBundle()
  await clearExistingPendings()

  // 用非 bundle 的 productId
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    bundleProductId: OUTSIDE_PRODUCT_ID,
    items: [{ skuId: SKU_OUTSIDE_ID, quantity: 1 }],
    paymentMethod: '线下',
  })
  if (res.code === 0) throw new Error(`expect error, got success`)
  if (!/BUNDLE_NOT_FOUND/.test(res.message || '')) {
    throw new Error(`expect BUNDLE_NOT_FOUND, got: ${res.message}`)
  }
}

async function caseNonBundleFlowStillWorks() {
  await ensureClient()
  await seedBundle()
  await clearExistingPendings()

  // 不传 bundleProductId，走原有普通商品路径，使用 SKU_OUTSIDE_ID
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: SKU_OUTSIDE_ID, quantity: 1 }],
    paymentMethod: '线下',
  })
  if (res.code !== 0) throw new Error(`non-bundle path regression: ${res.message}`)
}

const CASES = [
  ['bundle happy path → 3 sale_items + unit_real_price=bundle_price + total=340', caseHappy],
  ['bundle 组1 漏选 → BUNDLE_GROUP_PICK_MISMATCH', caseMissingPickFromGroup1],
  ['bundle 组2(全选) 漏一个 → BUNDLE_GROUP_PICK_MISMATCH', caseAllSelectGroupMissingOne],
  ['bundle items 混入跨 bundle SKU → BUNDLE_SKU_NOT_BELONG', caseSkuNotBelong],
  ['bundleProductId 指向非 bundle 商品 → BUNDLE_NOT_FOUND', caseBundleNotFound],
  ['不传 bundleProductId 普通商品流不受影响', caseNonBundleFlowStillWorks],
]

let pass = 0, fail = 0
console.log(`[order/bundle.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[order/bundle.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
