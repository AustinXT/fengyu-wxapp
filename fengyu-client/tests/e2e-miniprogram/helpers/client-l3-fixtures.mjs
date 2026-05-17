// client L3 专属 fixture — 商品/储值卡/优惠券/消息/积分/待支付订单 等
// 命名空间统一 'TEST_E2E_L3_'（与 staff 共享根 cleanupL3TestData）
//
// 使用方式：
//   await ensureBaseFixtures()    // 来自根 fixtures.mjs，建 org/store
//   await ensureTestClient(...)   // 来自根，建测试顾客
//   await createClientProduct(...)// 本文件，建测试商品/SKU
//
// IMPORTANT: spec 跑前/跑后调用 `cleanupL3TestData()`（来自根 fixtures.mjs）一次性清干净。

import { query, tx } from './pg.mjs'
import {
  TEST_STORE_ID,
  ensureBaseFixtures,
} from './fixtures.mjs'
import {
  NAMESPACE,
  TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE,
  TEST_STAFF_EMPLOYEE_ID,
} from './constants.mjs'

const NS = NAMESPACE.replace(/_$/, '')  // 'TEST_E2E_L3'

// ─── client 专属命名空间 ───────────────────────────────
export const L3_MALL_CATEGORY_ID = `${NS}_MALLCAT`
export const L3_PROD_CATEGORY_ID = `${NS}_PRODCAT`
export const L3_PRODUCT_ID = `${NS}_PROD`
export const L3_SKU_NORMAL_ID = `${NS}_SKU_N`
export const L3_SKU_COURSE_ID = `${NS}_SKU_C`
export const L3_SKU_EXP_ID = `${NS}_SKU_E`
export const L3_PREPAID_CARD_ID = `${NS}_CARD`
export const L3_COUPON_TEMPLATE_ID = `${NS}_CTPL`
export const L3_COUPON_ID = `${NS}_CPN`

// ─── 商品分类 + 商品 + SKU ────────────────────────────
export async function ensureClientCategories() {
  await query(
    `INSERT INTO mall_categories (category_id, category_name, sort_order)
     VALUES ($1, $2, 0) ON CONFLICT (category_id) DO NOTHING`,
    [L3_MALL_CATEGORY_ID, `${NS}_商城分类`]
  )
  await query(
    `INSERT INTO product_categories (
       category_id, category_name, product_kind, sales_category,
       sort_order, is_valid
     )
     VALUES ($1, $2, '护理项目', '自销自耗'::sales_category, 0, true)
     ON CONFLICT (category_id) DO NOTHING`,
    [L3_PROD_CATEGORY_ID, `${NS}_品项分类`]
  )
}

/**
 * 一次性建 1 商品 + 3 SKU（普通 / 疗程卡 / 体验卡）
 * 默认在 mall_product_skus 表也建好关联，使 product.spuList 可见。
 */
export async function ensureClientProductCatalog() {
  await ensureBaseFixtures()
  await ensureClientCategories()

  await query(
    `INSERT INTO products (
       product_id, category_id, name, price, is_bundle,
       sort_order, is_enabled, is_visible
     )
     VALUES ($1, $2, $3, '100.00'::numeric, false, 0, true, true)
     ON CONFLICT (product_id) DO UPDATE SET is_enabled = true, is_visible = true`,
    [L3_PRODUCT_ID, L3_MALL_CATEGORY_ID, `${NS}_测试商品`]
  )

  const skus = [
    [L3_SKU_NORMAL_ID, '单品', `${NS}_普通规格`, '100.00', null, false],
    [L3_SKU_COURSE_ID, '疗程卡', `${NS}_5次卡`, '500.00', 5, false],
    [L3_SKU_EXP_ID, '单品', `${NS}_体验装`, '9.90', null, true],
  ]
  for (const [skuId, type, name, price, sessions, isExp] of skus) {
    await query(
      `INSERT INTO product_skus (
         sku_id, category_id, product_type, spec_name, price,
         session_count, sort_order, service_fee,
         is_experience, is_recharge_card, is_enabled
       )
       VALUES ($1, $2, $3::product_type, $4, $5::numeric,
               $6, 0, 0, $7, false, true)
       ON CONFLICT (sku_id) DO UPDATE
         SET price = EXCLUDED.price, spec_name = EXCLUDED.spec_name,
             session_count = EXCLUDED.session_count, is_enabled = true`,
      [skuId, L3_PROD_CATEGORY_ID, type, name, price, sessions, isExp]
    )
    await query(
      `INSERT INTO mall_product_skus (product_id, sku_id, sort_order)
       VALUES ($1, $2, 0) ON CONFLICT (product_id, sku_id) DO NOTHING`,
      [L3_PRODUCT_ID, skuId]
    )
  }
  return {
    productId: L3_PRODUCT_ID,
    skuNormal: L3_SKU_NORMAL_ID,
    skuCourse: L3_SKU_COURSE_ID,
    skuExperience: L3_SKU_EXP_ID,
  }
}

// ─── 储值卡 ────────────────────────────────────────────
export async function ensureClientPrepaidCard({
  userId = TEST_CLIENT_USER_ID,
  cardId = L3_PREPAID_CARD_ID,
  balance = '1000.00',
} = {}) {
  await query(
    `INSERT INTO prepaid_cards (card_id, user_id, balance)
     VALUES ($1, $2, $3::numeric)
     ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
    [cardId, userId, balance]
  )
  return { cardId, userId, balance: Number(balance) }
}

// ─── 优惠券 ────────────────────────────────────────────
export async function ensureClientCoupon({
  userId = TEST_CLIENT_USER_ID,
  templateId = L3_COUPON_TEMPLATE_ID,
  couponId = L3_COUPON_ID,
  discountValue = '10.00',
  minSpend = '100.00',
  status = '未使用',
  expireAt = new Date(Date.now() + 86400_000 * 30),
} = {}) {
  await query(
    `INSERT INTO coupon_templates (
       template_id, name, coupon_type, discount_value, min_spend,
       validity_mode, valid_from, valid_to, is_active
     )
     VALUES ($1, $2, '现金券'::coupon_type, $3::numeric, $4::numeric,
             'fixed', NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', true)
     ON CONFLICT (template_id) DO UPDATE SET is_active = true`,
    [templateId, `${NS}_测试券`, discountValue, minSpend]
  )
  await query(
    `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at)
     VALUES ($1, $2, $3, $4::coupon_status, $5)
     ON CONFLICT (coupon_id) DO UPDATE SET status = EXCLUDED.status`,
    [couponId, templateId, userId, status, expireAt]
  )
  return { couponId, templateId }
}

// ─── 站内消息 ──────────────────────────────────────────
export async function createClientMessages(items = [
  { title: 'L3-测试消息-1', isRead: false },
  { title: 'L3-测试消息-2', isRead: false },
  { title: 'L3-测试消息-3', isRead: true },
]) {
  const ids = []
  for (const it of items) {
    const res = await query(
      `INSERT INTO messages (
         recipient_type, recipient_id, title, body, message_type, is_read
       )
       VALUES ('客户'::message_recipient_type, $1, $2, '测试消息内容', 'system', $3)
       RETURNING id`,
      [TEST_CLIENT_USER_ID, it.title, it.isRead]
    )
    ids.push(res[0].id)
  }
  return ids
}

// ─── 积分流水 ──────────────────────────────────────────
export async function createClientPointTxn({
  userId = TEST_CLIENT_USER_ID,
  type = '获取',
  amount = 10,
  refOrderId = null,
} = {}) {
  const res = await query(
    `INSERT INTO point_transactions (user_id, type, amount, ref_order_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, type, amount, refOrderId]
  )
  return { id: res[0].id }
}

// ─── 员工开单（用于 scan-pay journey） ────────────────
/**
 * 创建一个员工已开但待客户扫码支付的销售单
 * 复刻 staff 端 sale_orders 行为，含 sale_items 一行
 */
export async function createPendingSaleOrderForScan({
  saleOrderId,
  clientUserId = TEST_CLIENT_USER_ID,
  totalAmount = 300,
  skuId = L3_SKU_NORMAL_ID,
} = {}) {
  if (!saleOrderId) throw new Error('saleOrderId required')
  await ensureClientProductCatalog()

  return await tx(async (client) => {
    await client.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, opened_by, allocation_status
       )
       VALUES ($1, '待支付'::order_status, '销售单'::sale_order_type, $2, $3,
               NOW(), $4, $5, $6,
               $7, 0, $7, 0,
               '微信'::payment_method, $8, '待分配'::allocation_status)`,
      [saleOrderId, `${NS}_市场`, TEST_STORE_ID,
       clientUserId, TEST_CLIENT_PHONE, `${NS}_顾客`, totalAmount,
       TEST_STAFF_EMPLOYEE_ID]
    )
    const itemId = `${saleOrderId}_I1`
    await client.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, sku_spec_name, product_type,
         unit_price, quantity, unit_real_price, sale_amount, received,
         is_experience, is_recharge_card
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               $4, $5, '默认', '单品'::product_type,
               $6, 1, $6, $6, 0, false, false)`,
      [itemId, saleOrderId, TEST_STORE_ID, skuId, `${NS}_测试商品`, totalAmount]
    )
    return { saleOrderId, saleItemId: itemId }
  })
}
