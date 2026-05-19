/**
 * client 端专属 fixture
 *
 * 复用根 helpers/fixtures.mjs 的基础 fixture（ensureTestStore / createTestClient 等），
 * 在其上叠加 client 端特有数据：商品、SKU、储值卡、优惠券、消息、积分流水、待支付订单、预约。
 *
 * 命名空间统一用根 NS=TE2L2_，cleanupClientExtras 反向清理这些表，
 * 必须在 cleanupTestData(NS) 之前调用（因为这些表 FK → client_wechat_users / sale_orders 等基础表）。
 */
import {
  NS, pgQuery, getPool,
  TEST_CLIENT_USER_ID, TEST_CLIENT_OPENID, TEST_CLIENT_PHONE,
  TEST_STORE_ID,
} from '../setup.mjs'
import {
  TEST_MALL_CATEGORY_ID,
  TEST_PRODUCT_CATEGORY_ID,
  TEST_PRODUCT_ID,
  TEST_SKU_NORMAL_ID,
  TEST_SKU_COURSE_ID,
  TEST_SKU_EXPERIENCE_ID,
  TEST_SKU_RECHARGE_ID,
  TEST_PREPAID_CARD_ID,
  TEST_COUPON_TEMPLATE_ID,
  TEST_COUPON_ID,
  TEST_CLIENT2_USER_ID, TEST_CLIENT2_OPENID, TEST_CLIENT2_PHONE,
} from '../setup.mjs'

// ─── 工具：手机号 ────────────────────────────────────
/**
 * 把任意 suffix（可含字母）哈希到一个合法手机号字符串
 * chk_cwu_phone_format / chk_swu_phone_format 约束 `^1[3-9][0-9]{9}$`
 * 拼法：固定前缀 `1999909` (7 位) + 4 位 hash (0000-9999) = 11 位
 */
export function suffixToPhone(suffix) {
  let h = 0
  for (const c of String(suffix)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return '1999909' + String(h % 10000).padStart(4, '0')
}

// ─── 商品分类 ─────────────────────────────────────────
/**
 * 同时确保两个分类系统的测试行：
 *  - mall_categories（商城分类，products FK）
 *  - product_categories（品项分类，product_skus FK）
 */
export async function ensureTestCategories({
  mallCategoryId = TEST_MALL_CATEGORY_ID,
  productCategoryId = TEST_PRODUCT_CATEGORY_ID,
  productKind = '护理项目',
  salesCategory = '自销自耗',  // sales_category enum: 自销自耗/他销自耗/他销他耗/生态合作
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
     VALUES ($1, $2, $3, $4::sales_category, 0, true)
     ON CONFLICT (category_id) DO NOTHING`,
    [productCategoryId, `${NS}_品项分类`, productKind, salesCategory]
  )
  return { mallCategoryId, productCategoryId }
}

// ─── 商品 + SKU ────────────────────────────────────────
/**
 * 创建测试商品（mall.products 行 + 一条 product_skus + mall_product_skus 关联）
 * 默认创建一个 100 元普通单品 SKU。可叠加调用创建多个 SKU。
 */
export async function createTestProduct({
  productId = TEST_PRODUCT_ID,
  name = `${NS}_测试商品`,
  price = '100.00',
  isBundle = false,
  isVisible = true,
} = {}) {
  await ensureTestCategories()
  await pgQuery(
    `INSERT INTO products (
       product_id, category_id, name, price, is_bundle,
       sort_order, is_visible
     )
     VALUES ($1, $2, $3, $4::numeric, $5, 0, $6)
     ON CONFLICT (product_id) DO UPDATE
       SET name = EXCLUDED.name, price = EXCLUDED.price,
           is_visible = EXCLUDED.is_visible`,
    [productId, TEST_MALL_CATEGORY_ID, name, price, isBundle, isVisible]
  )
  return { productId }
}

/**
 * 创建测试 SKU
 *
 * @param {object} opts
 * @param {string} opts.skuId - SKU id
 * @param {string} opts.productType - '单品' | '疗程卡' | '家居产品'（productTypeEnum）
 * @param {string} opts.price
 * @param {number?} opts.sessionCount - 疗程次数（疗程卡 ≥ 2）
 * @param {boolean} opts.isExperience
 * @param {boolean} opts.isRechargeCard
 * @param {boolean} opts.linkToProduct - 是否插入 mall_product_skus 关联（默认 true）
 */
export async function createTestSku({
  skuId = TEST_SKU_NORMAL_ID,
  productId = TEST_PRODUCT_ID,
  specName = `${NS}_默认规格`,
  productType = '单品',
  price = '100.00',
  sessionCount = null,
  isExperience = false,
  isRechargeCard = false,
  linkToProduct = true,
} = {}) {
  await ensureTestCategories()
  await pgQuery(
    `INSERT INTO product_skus (
       sku_id, category_id, product_type, spec_name, price,
       session_count, sort_order, service_fee,
       is_experience, is_recharge_card, is_enabled
     )
     VALUES ($1, $2, $3::product_type, $4, $5::numeric,
             $6, 0, 0,
             $7, $8, true)
     ON CONFLICT (sku_id) DO UPDATE
       SET price = EXCLUDED.price, spec_name = EXCLUDED.spec_name,
           session_count = EXCLUDED.session_count, is_enabled = true,
           is_experience = EXCLUDED.is_experience,
           is_recharge_card = EXCLUDED.is_recharge_card`,
    [skuId, TEST_PRODUCT_CATEGORY_ID, productType, specName, price,
     sessionCount, isExperience, isRechargeCard]
  )

  if (linkToProduct) {
    await createTestProduct({ productId })
    await pgQuery(
      `INSERT INTO mall_product_skus (product_id, sku_id, sort_order)
       VALUES ($1, $2, 0)
       ON CONFLICT (product_id, sku_id) DO NOTHING`,
      [productId, skuId]
    )
  }
  return { skuId, productId }
}

// ─── 储值卡 ────────────────────────────────────────────
/**
 * 创建测试顾客的储值卡账户（一户一账户，uq_prepaid_cards_user 唯一约束）
 */
export async function createTestPrepaidCard({
  cardId = TEST_PREPAID_CARD_ID,
  userId = TEST_CLIENT_USER_ID,
  balance = '1000.00',
} = {}) {
  await pgQuery(
    `INSERT INTO prepaid_cards (card_id, user_id, balance)
     VALUES ($1, $2, $3::numeric)
     ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
    [cardId, userId, balance]
  )
  return { cardId, userId, balance: Number(balance) }
}

export async function setCardBalance(userId, balance) {
  await pgQuery(
    `UPDATE prepaid_cards SET balance = $1::numeric WHERE user_id = $2`,
    [String(balance), userId]
  )
}

// ─── 优惠券 ────────────────────────────────────────────
/**
 * 创建券模板（默认满 100 减 10 通用现金券）
 */
export async function createTestCouponTemplate({
  templateId = TEST_COUPON_TEMPLATE_ID,
  name = `${NS}_测试现金券`,
  couponType = '现金券',
  discountValue = '10.00',
  minSpend = '100.00',
  applicableProductIds = null,
  applicableCategoryIds = null,
  applicableStoreIds = null,
  applicableMarketIds = null,
  validityMode = 'fixed',
  validDays = null,
  validFrom = new Date(Date.now() - 86400_000),  // 昨天
  validTo = new Date(Date.now() + 86400_000 * 30),  // 30 天后
  isActive = true,
} = {}) {
  await pgQuery(
    `INSERT INTO coupon_templates (
       template_id, name, coupon_type, discount_value, min_spend,
       applicable_product_ids, applicable_category_ids,
       applicable_store_ids, applicable_market_ids,
       validity_mode, valid_days, valid_from, valid_to, is_active
     )
     VALUES ($1, $2, $3::coupon_type, $4::numeric, $5::numeric,
             $6::text[], $7::text[], $8::text[], $9::text[],
             $10, $11, $12, $13, $14)
     ON CONFLICT (template_id) DO UPDATE
       SET name = EXCLUDED.name, discount_value = EXCLUDED.discount_value,
           min_spend = EXCLUDED.min_spend, is_active = EXCLUDED.is_active,
           valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to`,
    [templateId, name, couponType, discountValue, minSpend,
     applicableProductIds, applicableCategoryIds,
     applicableStoreIds, applicableMarketIds,
     validityMode, validDays, validFrom, validTo, isActive]
  )
  return { templateId }
}

/**
 * 发券给测试顾客
 */
export async function createTestCoupon({
  couponId = TEST_COUPON_ID,
  templateId = TEST_COUPON_TEMPLATE_ID,
  userId = TEST_CLIENT_USER_ID,
  status = '未使用',
  expireAt = new Date(Date.now() + 86400_000 * 30),
  faceValueOverride = null,
} = {}) {
  await createTestCouponTemplate({ templateId })
  await pgQuery(
    `INSERT INTO user_coupons (
       coupon_id, template_id, user_id, status, expire_at, face_value_override
     )
     VALUES ($1, $2, $3, $4::coupon_status, $5, $6)
     ON CONFLICT (coupon_id) DO UPDATE
       SET status = EXCLUDED.status, expire_at = EXCLUDED.expire_at`,
    [couponId, templateId, userId, status, expireAt, faceValueOverride]
  )
  return { couponId }
}

// ─── 积分流水 ──────────────────────────────────────────
export async function createTestPointTxn({
  userId = TEST_CLIENT_USER_ID,
  type = '获取',  // point_transactions.type 是 text 非 enum，默认 '获取'
  amount = 10,
  refOrderId = null,
  externalRef = null,
} = {}) {
  const res = await pgQuery(
    `INSERT INTO point_transactions (user_id, type, amount, ref_order_id, external_ref)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, type, amount, refOrderId, externalRef]
  )
  return { id: res[0].id }
}

// ─── 站内消息 ──────────────────────────────────────────
export async function createTestMessage({
  recipientId = TEST_CLIENT_USER_ID,
  recipientType = '客户',
  title = `${NS}_测试消息`,
  body = '这是一条测试消息',
  messageType = 'system',
  isRead = false,
  refEntityType = null,
  refEntityId = null,
  idempotencyKey = null,
} = {}) {
  const res = await pgQuery(
    `INSERT INTO messages (
       recipient_type, recipient_id, title, body, message_type,
       is_read, ref_entity_type, ref_entity_id, idempotency_key
     )
     VALUES ($1::message_recipient_type, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [recipientType, recipientId, title, body, messageType,
     isRead, refEntityType, refEntityId, idempotencyKey]
  )
  return { id: res[0].id }
}

// ─── 美容师（service/staff/appointment 测试用） ──────
/**
 * 创建测试美容师（position_name='美容师'，与默认的店长 createTestStaff 区分）
 * staff.list / appointments 等场景需要美容师身份
 */
export async function createTestBeautician({
  employeeId = `${NS}_BEAUT`,
  openid = `${NS}_BEAUT_OPENID`,
  phone = '19999099004',
  name = `${NS}_美容师`,
  position = '美容师',  // 美容师/高级美容师/资深美容师
  storeId = TEST_STORE_ID,
} = {}) {
  await pgQuery(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6,
             ARRAY['美容师']::text[], false, CURRENT_DATE)
     ON CONFLICT (employee_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
           name = EXCLUDED.name, store_id = EXCLUDED.store_id,
           position_name = EXCLUDED.position_name, is_resigned = false`,
    [employeeId, openid, phone, name, storeId, position]
  )
  return { employeeId, openid, phone, name }
}

// ─── 预约（带必要 FK） ────────────────────────────────
/**
 * 创建测试预约。前置条件由调用方保证：
 *  - storeId 在 stores 表（默认 ensureTestStore 提供 TEST_STORE_ID）
 *  - clientUserId 在 client_wechat_users 表
 *  - employeeId 在 staff_wechat_users 表
 *  - saleItemId（可选）在 sale_items 表
 *
 * @returns {Promise<{appointmentId}>}
 */
export async function createTestAppointment({
  appointmentId,
  clientUserId = TEST_CLIENT_USER_ID,
  clientName = `${NS}_顾客`,
  employeeId,
  employeeName,
  storeId = TEST_STORE_ID,
  saleItemId = null,
  appointmentTime = new Date(Date.now() + 86400_000),  // 明天
  status = '待确认',
  notes = null,
} = {}) {
  if (!appointmentId) throw new Error('createTestAppointment: appointmentId required')
  if (!employeeId) throw new Error('createTestAppointment: employeeId required (use createTestBeautician)')
  await pgQuery(
    `INSERT INTO appointments (
       appointment_id, status, store_id, client_user_id, client_name,
       employee_id, employee_name, sale_item_id, appointment_time, notes
     )
     VALUES ($1, $2::appointment_status, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (appointment_id) DO UPDATE
       SET status = EXCLUDED.status,
           appointment_time = EXCLUDED.appointment_time,
           notes = EXCLUDED.notes`,
    [appointmentId, status, storeId, clientUserId, clientName,
     employeeId, employeeName ?? `${NS}_美容师`, saleItemId, appointmentTime, notes]
  )
  return { appointmentId }
}

// ─── 工具：设置疗程卡剩余次数 ─────────────────────────
export async function setRemainingSessions(saleItemId, count) {
  await pgQuery(
    `UPDATE sale_items SET remaining_sessions = $1 WHERE sale_item_id = $2`,
    [count, saleItemId]
  )
}

// ─── 工具：强制更新订单状态（绕过状态机，仅测试用） ─
export async function forceUpdateOrderStatus(saleOrderId, status) {
  await pgQuery(
    `UPDATE sale_orders SET status = $1::order_status WHERE sale_order_id = $2`,
    [status, saleOrderId]
  )
}

// ─── 第二顾客（跨用户测试场景） ──────────────────────
export async function createTestClient2({
  userId = TEST_CLIENT2_USER_ID,
  openid = TEST_CLIENT2_OPENID,
  phone = TEST_CLIENT2_PHONE,
  name = `${NS}_顾客2`,
  boundStoreId = TEST_STORE_ID,
} = {}) {
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, $3, $4, '女', $5, '流量客'::customer_type, '<1990'::spending_tier, 0)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
           bound_store_id = EXCLUDED.bound_store_id`,
    [userId, openid, phone, name, boundStoreId]
  )
  return { userId, openid, phone }
}

// ─── 客户端"待支付"销售单 ─────────────────────────────
/**
 * 客户端 order.create 视角的销售单（status='待支付'，单行 sale_items）
 * 与根 createTestSaleOrder('待确认收款') 区分；这里语义是"顾客微信端下单后待支付"
 */
export async function createTestPendingSaleOrder({
  saleOrderId,
  clientUserId = TEST_CLIENT_USER_ID,
  storeId = TEST_STORE_ID,
  totalAmount = 100,
  skuId = TEST_SKU_NORMAL_ID,
  productType = '单品',
  isExperience = false,
  isRechargeCard = false,
  sessionCount = null,
  remainingCount = null,
} = {}) {
  if (!saleOrderId) throw new Error('createTestPendingSaleOrder: saleOrderId required')

  // 自动确保 SKU 存在（创建一个匹配 productType 的 SKU，避免 sale_items FK 违例）
  await createTestSku({
    skuId,
    productType,
    sessionCount,
    isExperience,
    isRechargeCard,
    linkToProduct: false,  // 仅建 SKU 行，不需要建 mall_product_skus
  })

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, allocation_status
       )
       VALUES ($1, '待支付'::order_status, '销售单'::sale_order_type, $2, $3,
               NOW(), $4, $5, $6,
               $7, 0, $7, 0,
               '微信'::payment_method, '待分配'::allocation_status)`,
      [saleOrderId, `${NS}_市场`, storeId,
       clientUserId, TEST_CLIENT_PHONE, `${NS}_顾客`, totalAmount]
    )
    const itemId = `${saleOrderId}_I1`
    await client.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, sku_spec_name, product_type,
         unit_price, quantity, unit_real_price, sale_amount, received,
         session_count, remaining_sessions,
         is_experience, is_recharge_card
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               $4, $5, '默认', $6::product_type,
               $7, 1, $7, $7, 0,
               $8, $9,
               $10, $11)`,
      [itemId, saleOrderId, storeId,
       skuId, `${NS}_测试商品`, productType,
       totalAmount,
       sessionCount, remainingCount ?? sessionCount,
       isExperience, isRechargeCard]
    )
    await client.query('COMMIT')
    return { saleOrderId, saleItemId: itemId }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// ─── 清理 client 专属表 ────────────────────────────────
/**
 * 反向清理 client 专属表（products / skus / categories / coupons / messages 等）
 * 必须在 cleanupTestData(NS) 之前调用（因为这些表 FK 到 client_wechat_users 等基础表）
 *
 * 注意：根 cleanupTestData 已清理 prepaid_cards / card_transactions / point_transactions
 * 通过 user_id LIKE 'TE2L2%'，所以这里不重复处理它们；其他 client 端独有的表才需要在这里清。
 */
export async function cleanupClientExtras(prefix = NS) {
  const like = `${prefix}%`
  const testPhones = [TEST_CLIENT2_PHONE]

  const stmts = [
    // 0) card_transactions 按 card_id 清（FK：card_transactions.card_id → prepaid_cards）
    //    必须先删流水才能后续删 prepaid_cards。
    //    根 cleanupTestData 只按 ref_order_id LIKE 清，会漏掉充值流水（ref_order_id=null）。
    [
      `DELETE FROM card_transactions WHERE card_id IN (
         SELECT card_id FROM prepaid_cards WHERE user_id IN (
           SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
         )
       )`,
      [like],
    ],

    // 1) 消息（按 recipient_id LIKE）
    [`DELETE FROM messages WHERE recipient_id LIKE $1`, [like]],

    // 2) 用户券（FK → user_coupons → coupon_templates / client_wechat_users）
    [`DELETE FROM user_coupons WHERE coupon_id LIKE $1`, [like]],
    [
      `DELETE FROM user_coupons WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1
       )`,
      [like],
    ],
    [`DELETE FROM coupon_templates WHERE template_id LIKE $1`, [like]],

    // 3) 预约（FK → sale_items → sale_orders）
    [
      `DELETE FROM appointments WHERE client_user_id LIKE $1 OR sale_item_id LIKE $1`,
      [like],
    ],

    // 4) 服务单（FK → sale_orders / service_items 反向）
    [
      `DELETE FROM service_items WHERE service_order_id IN (
         SELECT service_order_id FROM service_orders WHERE service_order_id LIKE $1
       )`,
      [like],
    ],
    [`DELETE FROM service_orders WHERE service_order_id LIKE $1`, [like]],

    // 5) 商品 / SKU / 分类（最后清，FK：mall_product_skus → products/skus；mall_bundle_groups → products）
    [
      `DELETE FROM mall_product_skus WHERE sku_id LIKE $1 OR product_id LIKE $1`,
      [like],
    ],
    [`DELETE FROM mall_bundle_groups WHERE product_id LIKE $1`, [like]],
    [`DELETE FROM products WHERE product_id LIKE $1`, [like]],
    [`DELETE FROM product_skus WHERE sku_id LIKE $1`, [like]],
    [`DELETE FROM product_categories WHERE category_id LIKE $1`, [like]],
    [`DELETE FROM mall_categories WHERE category_id LIKE $1`, [like]],

    // 6) 第二顾客手机号防御
    [`DELETE FROM client_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],

    // 7) 自动生成 FYGK-* user_id 但 openid 是测试命名空间的（auth.login 等场景）
    //    先清依赖该 user_id 的子表（与根 cleanupTestData 已清的重叠但幂等）
    [
      `DELETE FROM point_transactions WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE openid LIKE $1
       )`,
      [like],
    ],
    [
      `DELETE FROM prepaid_cards WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE openid LIKE $1
       )`,
      [like],
    ],
    [
      `DELETE FROM user_coupons WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE openid LIKE $1
       )`,
      [like],
    ],
    [
      `DELETE FROM messages WHERE recipient_id IN (
         SELECT user_id FROM client_wechat_users WHERE openid LIKE $1
       )`,
      [like],
    ],
    // 8) FY-XSD-WX-* 命名空间订单残留（card.recharge / order.create 用 advisory lock 生成的订单号
    //    不带 TE2L2 前缀，但 client_user_id 在 NS 范围或 openid LIKE NS）
    [
      `DELETE FROM card_transactions WHERE ref_order_id IN (
         SELECT sale_order_id FROM sale_orders WHERE client_user_id IN (
           SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
         )
       )`,
      [like],
    ],
    [
      `DELETE FROM sale_items WHERE sale_order_id IN (
         SELECT sale_order_id FROM sale_orders WHERE client_user_id IN (
           SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
         )
       )`,
      [like],
    ],
    [
      `DELETE FROM sale_orders WHERE client_user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
       )`,
      [like],
    ],
    [`DELETE FROM client_wechat_users WHERE openid LIKE $1`, [like]],

    // 9) 解绑申请（独立表）
    [
      `DELETE FROM store_unbind_requests WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1
       ) OR user_id LIKE $1`,
      [like],
    ],

    // 10) Appointments（FK → staff_wechat_users / stores）必须在 staff/stores 清理前清掉
    [`DELETE FROM appointments WHERE store_id LIKE $1 OR employee_id LIKE $1`, [like]],

    // 11) 强清 staff_wechat_users 任何 org_node_id LIKE NS%（防 org_nodes FK 阻塞）
    [`DELETE FROM staff_wechat_users WHERE org_node_id LIKE $1`, [like]],

    // 12) 强清 stores 任何 org_node_id LIKE NS%
    [`DELETE FROM stores WHERE org_node_id LIKE $1`, [like]],

    // 13) 强清 permission_roles 任何 scope_id LIKE NS%
    [`DELETE FROM permission_roles WHERE scope_id LIKE $1`, [like]],
  ]

  for (const [sql, params] of stmts) {
    try {
      await pgQuery(sql, params)
    } catch (e) {
      console.warn(`[cleanup-client] skip "${sql.split('\n')[0]}…": ${e.message}`)
    }
  }
}
