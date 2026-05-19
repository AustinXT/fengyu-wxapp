/**
 * cross-end fixture helpers
 *
 * 命名空间 NS=TE2X，建组织 / 门店 / 店长 / 顾客 / SKU / 储值卡 / 优惠券 / 历史订单
 * 等跨端测试需要的数据。结构对齐 e2e-cloudfn/helpers/fixtures.mjs + client-fixtures.mjs，
 * 但所有 id 前缀都是 TE2X_ 互不冲突。
 *
 * 清理顺序按 FK 依赖反向（被引用表后删）。
 */
import {
  NS, pgQuery, getPool,
  TEST_STORE_ID, TEST_STORE_ORG_ID, TEST_HQ_ORG_ID, TEST_MARKET_ORG_ID,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_MANAGER_PHONE,
  TEST_CLIENT_USER_ID, TEST_CLIENT_OPENID, TEST_CLIENT_PHONE,
  TEST_MALL_CATEGORY_ID, TEST_PRODUCT_CATEGORY_ID, TEST_PRODUCT_ID,
  TEST_SKU_NORMAL_ID, TEST_PREPAID_CARD_ID,
  TEST_COUPON_TEMPLATE_ID, TEST_COUPON_ID,
} from '../setup.mjs'

// ─── 组织 / 门店 ───
export async function ensureCrossEndStore() {
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '总部', NULL, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_HQ_ORG_ID, `${NS}_总部`]
  )
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '市场', $3, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_MARKET_ORG_ID, `${NS}_市场`, TEST_HQ_ORG_ID]
  )
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '门店', $3, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_STORE_ORG_ID, `${NS}_测试店`, TEST_MARKET_ORG_ID]
  )
  await pgQuery(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false)
     ON CONFLICT (store_id) DO NOTHING`,
    [TEST_STORE_ID, `${NS}_测试店`, TEST_STORE_ORG_ID]
  )
  return { storeId: TEST_STORE_ID, storeOrgId: TEST_STORE_ORG_ID }
}

// ─── 店长（manager role） ───
export async function createCrossManager({
  employeeId = TEST_MANAGER_EMP_ID,
  openid = TEST_MANAGER_OPENID,
  phone = TEST_MANAGER_PHONE,
  name = `${NS}_店长`,
} = {}) {
  await ensureCrossEndStore()
  await pgQuery(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id, org_node_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6, '门店经理',
             ARRAY['美容师']::text[], false, CURRENT_DATE)
     ON CONFLICT (employee_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
           name = EXCLUDED.name, store_id = EXCLUDED.store_id,
           is_resigned = false`,
    [employeeId, openid, phone, name, TEST_STORE_ID, TEST_STORE_ORG_ID]
  )
  await pgQuery(
    `INSERT INTO permission_roles (employee_id, role, scope_id, created_by)
     VALUES ($1, 'manager', $2, 'e2e-cross-fixture')
     ON CONFLICT (employee_id, role, scope_id) DO NOTHING`,
    [employeeId, TEST_STORE_ORG_ID]
  )
  return { employeeId, openid, phone }
}

// ─── 顾客（默认带 prepaid_card） ───
export async function createCrossClient({
  userId = TEST_CLIENT_USER_ID,
  openid = TEST_CLIENT_OPENID,
  phone = TEST_CLIENT_PHONE,
  name = `${NS}_顾客`,
  balance = 200,
  withPrepaidCard = true,
} = {}) {
  await ensureCrossEndStore()
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, $3, $4, '女', $5, '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
           bound_store_id = EXCLUDED.bound_store_id`,
    [userId, openid, phone, name, TEST_STORE_ID]
  )
  if (withPrepaidCard) {
    await pgQuery(
      `INSERT INTO prepaid_cards (card_id, user_id, balance)
       VALUES ($1, $2, $3::numeric)
       ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
      [TEST_PREPAID_CARD_ID, userId, String(balance)]
    )
  }
  return { userId, openid, phone, balance: withPrepaidCard ? balance : 0 }
}

// ─── 测试 SKU（100 元普通单品） ───
export async function ensureCrossSku({
  mallCategoryId = TEST_MALL_CATEGORY_ID,
  productCategoryId = TEST_PRODUCT_CATEGORY_ID,
  productId = TEST_PRODUCT_ID,
  skuId = TEST_SKU_NORMAL_ID,
  price = '100.00',
} = {}) {
  await pgQuery(
    `INSERT INTO mall_categories (category_id, category_name, sort_order)
     VALUES ($1, $2, 0)
     ON CONFLICT (category_id) DO NOTHING`,
    [mallCategoryId, `${NS}_商城分类`]
  )
  await pgQuery(
    `INSERT INTO product_categories (
       category_id, category_name, product_kind, sales_category,
       sort_order, is_valid
     )
     VALUES ($1, $2, '护理项目', '自销自耗'::sales_category, 0, true)
     ON CONFLICT (category_id) DO NOTHING`,
    [productCategoryId, `${NS}_品项分类`]
  )
  await pgQuery(
    `INSERT INTO products (
       product_id, category_id, name, price, is_bundle,
       sort_order, is_visible
     )
     VALUES ($1, $2, $3, $4::numeric, false, 0, true)
     ON CONFLICT (product_id) DO UPDATE SET price = EXCLUDED.price, is_visible = true`,
    [productId, mallCategoryId, `${NS}_测试商品`, price]
  )
  await pgQuery(
    `INSERT INTO product_skus (
       sku_id, category_id, product_type, spec_name, price,
       sort_order, service_fee, is_experience, is_recharge_card, is_enabled
     )
     VALUES ($1, $2, '单品'::product_type, $3, $4::numeric, 0, 0, false, false, true)
     ON CONFLICT (sku_id) DO UPDATE
       SET price = EXCLUDED.price, is_enabled = true`,
    [skuId, productCategoryId, `${NS}_默认规格`, price]
  )
  await pgQuery(
    `INSERT INTO mall_product_skus (product_id, sku_id, sort_order)
     VALUES ($1, $2, 0) ON CONFLICT (product_id, sku_id) DO NOTHING`,
    [productId, skuId]
  )
  return { productId, skuId, price }
}

// ─── 清理 ───
export async function cleanupCrossEnd(prefix = NS) {
  const like = `${prefix}%`
  const testPhones = [TEST_MANAGER_PHONE, TEST_CLIENT_PHONE]
  const stmts = [
    // 0) card_transactions 按 card_id 清（含充值流水 ref_order_id=null）
    [
      `DELETE FROM card_transactions WHERE card_id IN (
         SELECT card_id FROM prepaid_cards WHERE user_id IN (
           SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
         )
       )`,
      [like],
    ],
    [`DELETE FROM card_transactions WHERE ref_order_id LIKE $1`, [like]],
    [`DELETE FROM messages WHERE recipient_id LIKE $1`, [like]],
    [`DELETE FROM user_coupons WHERE coupon_id LIKE $1`, [like]],
    [
      `DELETE FROM user_coupons WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1
       )`,
      [like],
    ],
    [`DELETE FROM coupon_templates WHERE template_id LIKE $1`, [like]],
    [
      `DELETE FROM appointments WHERE client_user_id LIKE $1 OR sale_item_id LIKE $1`,
      [like],
    ],
    [
      `DELETE FROM service_items WHERE service_order_id IN (
         SELECT service_order_id FROM service_orders WHERE service_order_id LIKE $1
       )`,
      [like],
    ],
    [`DELETE FROM service_orders WHERE service_order_id LIKE $1`, [like]],
    // sale_order_payments / sale_allocations / sale_items 都 FK → sale_orders，必须先删
    // 用范围更宽的 client_user_id IN (...) 子查询覆盖 staff.order.create 生成的 FY-XSD-WX-* 订单
    [
      `DELETE FROM sale_order_payments WHERE sale_order_id IN (
         SELECT sale_order_id FROM sale_orders WHERE client_user_id IN (
           SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
         )
         UNION
         SELECT sale_order_id FROM sale_orders WHERE opened_by IN (
           SELECT employee_id FROM staff_wechat_users WHERE employee_id LIKE $1
         )
       )`,
      [like],
    ],
    [`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_allocations WHERE sale_item_id IN (
         SELECT sale_item_id FROM sale_items WHERE sale_order_id IN (
           SELECT sale_order_id FROM sale_orders WHERE client_user_id IN (
             SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
           )
         )
       )`,
      [like],
    ],
    [`DELETE FROM sale_allocations WHERE sale_item_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_items WHERE sale_order_id IN (
         SELECT sale_order_id FROM sale_orders WHERE client_user_id IN (
           SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
         )
         UNION
         SELECT sale_order_id FROM sale_orders WHERE opened_by IN (
           SELECT employee_id FROM staff_wechat_users WHERE employee_id LIKE $1
         )
       )`,
      [like],
    ],
    [`DELETE FROM sale_items WHERE sale_order_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_orders WHERE client_user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
       )`,
      [like],
    ],
    [`DELETE FROM sale_orders WHERE sale_order_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_orders WHERE opened_by IN (
         SELECT employee_id FROM staff_wechat_users WHERE employee_id LIKE $1
       )`,
      [like],
    ],
    [`DELETE FROM mall_product_skus WHERE sku_id LIKE $1 OR product_id LIKE $1`, [like]],
    [`DELETE FROM products WHERE product_id LIKE $1`, [like]],
    [`DELETE FROM product_skus WHERE sku_id LIKE $1`, [like]],
    [`DELETE FROM product_categories WHERE category_id LIKE $1`, [like]],
    [`DELETE FROM mall_categories WHERE category_id LIKE $1`, [like]],
    [
      `DELETE FROM prepaid_cards WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
       )`,
      [like],
    ],
    [
      `DELETE FROM point_transactions WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
       )`,
      [like],
    ],
    [`DELETE FROM operation_logs WHERE target_id LIKE $1`, [like]],
    [`DELETE FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1`, [like]],
    [`DELETE FROM client_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],
    [`DELETE FROM permission_roles WHERE employee_id LIKE $1 OR scope_id LIKE $1`, [like]],
    [`DELETE FROM staff_wechat_users WHERE employee_id LIKE $1`, [like]],
    [`DELETE FROM staff_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],
    [`DELETE FROM stores WHERE store_id LIKE $1`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '门店'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '市场'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '总部'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1`, [like]],
  ]

  for (const [sql, params] of stmts) {
    try {
      await pgQuery(sql, params)
    } catch (e) {
      console.warn(`[cleanup-cross] skip "${sql.split('\n')[0]}…": ${e.message}`)
    }
  }
}
