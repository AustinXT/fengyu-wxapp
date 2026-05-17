/**
 * 端到端 fixture：测试组织 / 门店 / 员工 / 顾客 / 销售单 / 商品 / 预约 / 服务单 /
 * 退款申请 / 储值卡 / 优惠券。
 *
 * 所有写入必须以命名空间 (默认 'TEST_E2E_L2' 即 'TE2L2_') 为前缀，cleanupTestData
 * 用前缀 WHERE 精确清理，保证不污染生产数据。
 *
 * 创建顺序（FK 依赖正向）：
 *   org_nodes(总部 → 市场 → 门店) → stores → product_categories → product_skus
 *   → staff_wechat_users + permission_roles
 *   → client_wechat_users → prepaid_cards
 *   → coupon_templates → user_coupons
 *   → sale_orders + sale_items + sale_allocations + sale_order_payments
 *   → appointments → service_orders + service_items
 *
 * 清理顺序（FK 依赖反向）：
 *   service_items → service_orders → appointments
 *   → point_transactions → card_transactions → sale_allocations
 *   → sale_order_payments → sale_items → sale_orders
 *   → user_coupons → coupon_templates → prepaid_cards
 *   → operation_logs → client_wechat_users → permission_roles
 *   → staff_wechat_users → product_skus → product_categories
 *   → stores → org_nodes
 */
import {
  NS,
  TEST_STORE_ID, TEST_STORE_ORG_ID, TEST_HQ_ORG_ID, TEST_MARKET_ORG_ID,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_MANAGER_PHONE,
  TEST_CLIENT_USER_ID, TEST_CLIENT_OPENID, TEST_CLIENT_PHONE,
  pgQuery, getPool,
} from '../setup.mjs'

// ────────────────────────────────────────────────────────────────────────
// 组织架构 + 门店
// ────────────────────────────────────────────────────────────────────────

/**
 * 确保测试组织架构（总部 → 市场 → 门店）+ stores 行存在
 * 幂等：用 ON CONFLICT DO NOTHING / DO UPDATE
 */
export async function ensureTestStore() {
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

  return { storeId: TEST_STORE_ID, storeOrgId: TEST_STORE_ORG_ID, marketOrgId: TEST_MARKET_ORG_ID, hqOrgId: TEST_HQ_ORG_ID }
}

// ────────────────────────────────────────────────────────────────────────
// 员工 + 权限
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试员工（默认店长 manager 角色）。
 * @returns {Promise<{employeeId, openid, phone}>}
 */
export async function createTestStaff({
  employeeId = TEST_MANAGER_EMP_ID,
  openid = TEST_MANAGER_OPENID,
  phone = TEST_MANAGER_PHONE,
  name = `${NS}_店长`,
  isManager = true,
  positionName = '门店经理',
  skills = ['美容师'],
  storeId = TEST_STORE_ID,
  orgNodeId = TEST_STORE_ORG_ID,
} = {}) {
  await ensureTestStore()

  await pgQuery(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id, org_node_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6, $7,
             $8::text[], false, CURRENT_DATE)
     ON CONFLICT (employee_id) DO UPDATE
       SET openid = EXCLUDED.openid,
           phone = EXCLUDED.phone,
           name = EXCLUDED.name,
           store_id = EXCLUDED.store_id,
           org_node_id = EXCLUDED.org_node_id,
           position_name = EXCLUDED.position_name,
           skills = EXCLUDED.skills,
           is_resigned = false`,
    [employeeId, openid, phone, name, storeId, orgNodeId, positionName, skills]
  )

  if (isManager) {
    await createTestPermissionRole({ employeeId, role: 'manager', scopeId: orgNodeId })
  }

  return { employeeId, openid, phone }
}

/**
 * 单独绑定权限角色（一人多角色或多 scope 时单步调用）。
 */
export async function createTestPermissionRole({
  employeeId,
  role = 'manager',
  scopeId = TEST_STORE_ORG_ID,
  createdBy = 'e2e-fixture',
} = {}) {
  if (!employeeId) throw new Error('createTestPermissionRole: employeeId required')
  await pgQuery(
    `INSERT INTO permission_roles (employee_id, role, scope_id, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_id, role, scope_id) DO NOTHING`,
    [employeeId, role, scopeId, createdBy]
  )
  return { employeeId, role, scopeId }
}

// ────────────────────────────────────────────────────────────────────────
// 顾客
// ────────────────────────────────────────────────────────────────────────

export async function createTestClient({
  userId = TEST_CLIENT_USER_ID,
  openid = TEST_CLIENT_OPENID,
  phone = TEST_CLIENT_PHONE,
  name = `${NS}_顾客`,
  boundStoreId = TEST_STORE_ID,
  pointsBalance = 0,
  customerType = '流量客',
  spendingTier = '<1990',
  memberLevel = null,
} = {}) {
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance, member_level
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6::customer_type, $7::spending_tier, $8, $9::member_level)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid,
           phone = EXCLUDED.phone,
           bound_store_id = EXCLUDED.bound_store_id,
           points_balance = EXCLUDED.points_balance,
           customer_type = EXCLUDED.customer_type,
           spending_tier = EXCLUDED.spending_tier,
           member_level = EXCLUDED.member_level`,
    [userId, openid, phone, name, boundStoreId, customerType, spendingTier, pointsBalance, memberLevel]
  )
  return { userId, openid, phone }
}

// ────────────────────────────────────────────────────────────────────────
// 商品域：品项分类 + SKU
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试商品分类 + SKU。最小可用 fixture：order.create 价格从 product_skus 读取。
 *
 * @param {object} opts
 * @param {string} opts.suffix - 唯一后缀，用于生成 categoryId/skuId（默认 '1'）
 * @param {string} opts.productKind - 一级品项类型（如 '护理项目' / '充值卡' / '体验卡' / '家居产品'）
 * @param {string} opts.productType - SKU 产品类型枚举值（'疗程卡' / '单品' / '家居产品'）
 * @param {string} opts.salesCategory - 销售分类（'自销自耗' / '他销自耗' / '他销他耗' / '生态合作'）
 * @param {number} opts.price - 标价
 * @param {number|null} opts.sessionCount - 疗程次数（疗程卡>=2，单品=1，家居=null）
 * @param {boolean} opts.isShengmei - 是否生美（护理项目用）
 * @param {boolean} opts.isExperience - 是否体验卡
 * @param {boolean} opts.isRechargeCard - 是否充值卡
 * @param {number} opts.serviceFee - 固定手工费
 * @returns {Promise<{categoryId, skuId, specName}>}
 */
export async function createTestProduct({
  suffix = '1',
  productKind = '护理项目',
  productType = '疗程卡',
  salesCategory = '他销他耗',
  price = 1000,
  sessionCount = 10,
  isShengmei = true,
  isExperience = false,
  isRechargeCard = false,
  serviceFee = 0,
} = {}) {
  // 一级品项（'护理项目' / '家居产品' / '充值卡' / '体验卡'）在生产库已 seed。
  // 不再 INSERT 测试级 level-1 行，避免与生产同名 category_name 触发 LEFT JOIN 重复
  // （createConversion 的 held query 通过 category_name 匹配 parent_is_card_kind）。
  // 二级分类（product_kind=该一级名，sales_category 决定提成）
  const subCatId = `${NS}_CAT_${suffix}`
  await pgQuery(
    `INSERT INTO product_categories (
       category_id, category_name, product_kind, sales_category, sort_order, is_valid
     )
     VALUES ($1, $2, $3, $4::sales_category, 0, true)
     ON CONFLICT (category_id) DO UPDATE
       SET product_kind = EXCLUDED.product_kind,
           sales_category = EXCLUDED.sales_category`,
    [subCatId, `${NS}_品类_${suffix}`, productKind, salesCategory]
  )

  const skuId = `${NS}_SKU_${suffix}`
  const specName = `${NS}_商品_${suffix}`
  await pgQuery(
    `INSERT INTO product_skus (
       sku_id, category_id, product_type, spec_name, price,
       session_count, sort_order, service_fee, is_shengmei,
       is_experience, is_recharge_card, is_enabled
     )
     VALUES ($1, $2, $3::product_type, $4, $5,
             $6, 0, $7, $8,
             $9, $10, true)
     ON CONFLICT (sku_id) DO UPDATE
       SET category_id = EXCLUDED.category_id,
           product_type = EXCLUDED.product_type,
           spec_name = EXCLUDED.spec_name,
           price = EXCLUDED.price,
           session_count = EXCLUDED.session_count,
           service_fee = EXCLUDED.service_fee,
           is_shengmei = EXCLUDED.is_shengmei,
           is_experience = EXCLUDED.is_experience,
           is_recharge_card = EXCLUDED.is_recharge_card,
           is_enabled = true`,
    [
      skuId, subCatId, productType, specName, price,
      sessionCount, serviceFee, isShengmei,
      isExperience, isRechargeCard,
    ]
  )

  return { categoryId: subCatId, skuId, specName }
}

// ────────────────────────────────────────────────────────────────────────
// 销售订单
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建一个销售单（默认"待确认收款"，含 sale_items 一行）。
 * 向后兼容旧 smoke：保留 saleOrderId/clientUserId/totalAmount 必填字段。
 */
export async function createTestSaleOrder({
  saleOrderId,
  clientUserId,
  storeId = TEST_STORE_ID,
  openedBy = TEST_MANAGER_EMP_ID,
  totalAmount = 300,
  status = '待确认收款',
  saleOrderType = '销售单',
  paymentMethod = '线下',
  skuId = null,
  productName = `${NS}_测试商品`,
  productType = '单品',
  quantity = 1,
  sessionCount = null,
  isShengmei = null,
  isExperience = false,
  isRechargeCard = false,
  salesCategory = null,
  prepaidCardAmount = 0,
  preferredEmployeeId = null,
  refSaleOrderId = null,
} = {}) {
  if (!saleOrderId) throw new Error('createTestSaleOrder: saleOrderId required')
  if (!clientUserId) throw new Error('createTestSaleOrder: clientUserId required')

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const payableAmount = Number(totalAmount) - Number(prepaidCardAmount)
    await client.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, opened_by, preferred_employee_id, allocation_status,
         ref_sale_order_id
       )
       VALUES ($1, $2::order_status, $3::sale_order_type, $4, $5,
               NOW(), $6, $7, $8,
               $9, $10, $11, 0,
               $12::payment_method, $13, $14, '待分配'::allocation_status,
               $15)`,
      [
        saleOrderId, status, saleOrderType, `${NS}_市场`, storeId,
        clientUserId, TEST_CLIENT_PHONE, `${NS}_顾客`,
        totalAmount, prepaidCardAmount, payableAmount,
        paymentMethod, openedBy, preferredEmployeeId,
        refSaleOrderId,
      ]
    )

    const itemId = `${saleOrderId}_ITEM_1`
    await client.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, sku_spec_name, product_type,
         session_count, remaining_sessions,
         unit_price, quantity, unit_real_price, sale_amount, received,
         is_experience, is_recharge_card, is_shengmei, sales_category
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               $4, $5, '默认', $6::product_type,
               $7, $7,
               $8, $9, $8, $10, $10,
               $11, $12, $13, $14::sales_category)`,
      [
        itemId, saleOrderId, storeId,
        skuId, productName, productType,
        sessionCount,
        Number(totalAmount) / Number(quantity), quantity, totalAmount,
        isExperience, isRechargeCard, isShengmei, salesCategory,
      ]
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

// ────────────────────────────────────────────────────────────────────────
// 预约
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试预约。
 * @param {object} opts
 * @param {string} opts.appointmentId - 必填，建议 NS 前缀（如 'TE2L2_APPT_001'）
 * @param {string} opts.status - 默认 '待确认'
 * @param {Date|string} opts.appointmentTime - 默认 现在 +1 小时
 * @param {string} opts.saleItemId - 关联购买行（可选）
 * @returns {Promise<{appointmentId}>}
 */
export async function createTestAppointment({
  appointmentId,
  status = '待确认',
  storeId = TEST_STORE_ID,
  clientUserId = TEST_CLIENT_USER_ID,
  clientName = `${NS}_顾客`,
  employeeId = TEST_MANAGER_EMP_ID,
  employeeName = `${NS}_店长`,
  saleItemId = null,
  appointmentTime = null,
  notes = null,
} = {}) {
  if (!appointmentId) throw new Error('createTestAppointment: appointmentId required')
  const at = appointmentTime || new Date(Date.now() + 60 * 60 * 1000)
  await pgQuery(
    `INSERT INTO appointments (
       appointment_id, status, store_id, client_user_id, client_name,
       employee_id, employee_name, sale_item_id, appointment_time, notes
     )
     VALUES ($1, $2::appointment_status, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (appointment_id) DO UPDATE
       SET status = EXCLUDED.status,
           appointment_time = EXCLUDED.appointment_time,
           sale_item_id = EXCLUDED.sale_item_id`,
    [appointmentId, status, storeId, clientUserId, clientName, employeeId, employeeName, saleItemId, at, notes]
  )
  return { appointmentId }
}

// ────────────────────────────────────────────────────────────────────────
// 服务单
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试服务单（含可选 service_items）。
 *
 * @param {object} opts
 * @param {string} opts.serviceOrderId - 必填，varchar(30)，NS 前缀（如 'TE2L2_SVC_001'）
 * @param {string} opts.status - 默认 '待服务'
 * @param {Array<{saleItemId, employeeId?, sessionUsed?, serviceDuration?}>} opts.items
 * @param {string} opts.appointmentId - 可选关联预约
 * @returns {Promise<{serviceOrderId, items: [{serviceItemId}]}>}
 */
export async function createTestServiceOrder({
  serviceOrderId,
  status = '待服务',
  serviceOrderType = '售前',
  storeId = TEST_STORE_ID,
  assignedEmployeeId = TEST_MANAGER_EMP_ID,
  clientUserId = TEST_CLIENT_USER_ID,
  serviceDate = null,
  remark = null,
  appointmentId = null,
  items = [],
} = {}) {
  if (!serviceOrderId) throw new Error('createTestServiceOrder: serviceOrderId required')
  const date = serviceDate || new Date().toISOString().slice(0, 10)

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `INSERT INTO service_orders (
         service_order_id, status, service_order_type, market_name, store_id,
         service_date, assigned_employee_id, remark, appointment_id, client_user_id
       )
       VALUES ($1, $2::service_order_status, $3::service_order_type, $4, $5,
               $6, $7, $8, $9, $10)`,
      [serviceOrderId, status, serviceOrderType, `${NS}_市场`, storeId,
       date, assignedEmployeeId, remark, appointmentId, clientUserId]
    )

    const itemRefs = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const sItemId = `${serviceOrderId}_I${i + 1}`
      await client.query(
        `INSERT INTO service_items (
           service_item_id, sale_item_id, service_order_id, session_used,
           employee_id, service_duration, unit_real_price, is_shengmei, sales_category
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::sales_category)`,
        [
          sItemId, it.saleItemId, serviceOrderId, it.sessionUsed ?? 1,
          it.employeeId ?? assignedEmployeeId, it.serviceDuration ?? 60,
          it.unitRealPrice ?? null, it.isShengmei ?? null, it.salesCategory ?? null,
        ]
      )
      itemRefs.push({ serviceItemId: sItemId })
    }

    await client.query('COMMIT')
    return { serviceOrderId, items: itemRefs }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// ────────────────────────────────────────────────────────────────────────
// 退款审批
// ────────────────────────────────────────────────────────────────────────

/**
 * 在已有销售单上创建一条"待审批"退款申请（sale_order_payments）。
 *
 * @param {object} opts
 * @param {string} opts.saleOrderId - 原销售单（必须已是 '已支付'/'部分支付'）
 * @param {number} opts.refundAmount - 退款金额（输入正数，函数自动转负）
 * @param {string} opts.refundReason - 退款原因
 * @param {string} opts.refSaleItemId - 部分退款关联的具体 sale_item（可选）
 * @param {number|null} opts.sessionCount - 退疗程卡的次数（可选）
 * @param {string} opts.operatorEmployeeId - 发起人
 * @returns {Promise<{paymentId}>}
 */
export async function createTestRefundRequest({
  saleOrderId,
  refundAmount,
  refundReason = `${NS}_e2e_refund`,
  refSaleItemId = null,
  sessionCount = null,
  operatorEmployeeId = TEST_MANAGER_EMP_ID,
  paymentMethod = '线下',
} = {}) {
  if (!saleOrderId) throw new Error('createTestRefundRequest: saleOrderId required')
  if (!refundAmount || refundAmount <= 0) throw new Error('createTestRefundRequest: refundAmount must be > 0')

  const rows = await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, status, source_end,
       operator_employee_id, note, refund_reason, ref_sale_item_id, session_count, created_at
     )
     VALUES ($1, '退款'::payment_change_type, $2, $3::payment_method, '待审批'::payment_flow_status, 'staff'::payment_source_end,
             $4, NULL, $5, $6, $7, NOW())
     RETURNING id`,
    [saleOrderId, -Math.abs(refundAmount), paymentMethod, operatorEmployeeId, refundReason, refSaleItemId, sessionCount]
  )
  return { paymentId: rows[0].id }
}

// ────────────────────────────────────────────────────────────────────────
// 储值卡
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试储值卡（一户一账户；写 prepaid_cards + 可选首充 card_transactions）。
 *
 * @param {object} opts
 * @param {string} opts.userId - 顾客 user_id（默认 TEST_CLIENT_USER_ID）
 * @param {number} opts.initialBalance - 初始余额（>0 时同步写一条 type='充值' 流水）
 * @param {string} opts.cardId - 自定义 card_id（默认 NS_CARD_<userId 尾>）
 * @param {string} opts.refOrderId - 充值流水关联订单（可选）
 * @returns {Promise<{cardId, balance}>}
 */
export async function createTestPrepaidCard({
  userId = TEST_CLIENT_USER_ID,
  initialBalance = 0,
  cardId = null,
  refOrderId = null,
} = {}) {
  const cid = cardId || `${NS}_CARD_${userId.split('_').pop()}`
  await pgQuery(
    `INSERT INTO prepaid_cards (card_id, user_id, balance)
     VALUES ($1, $2, $3)
     ON CONFLICT (card_id) DO UPDATE
       SET balance = EXCLUDED.balance`,
    [cid, userId, initialBalance]
  )
  if (Number(initialBalance) > 0) {
    await pgQuery(
      `INSERT INTO card_transactions (card_id, type, amount, ref_order_id)
       VALUES ($1, '充值'::card_transaction_type, $2, $3)`,
      [cid, initialBalance, refOrderId]
    )
  }
  return { cardId: cid, balance: Number(initialBalance) }
}

// ────────────────────────────────────────────────────────────────────────
// 优惠券
// ────────────────────────────────────────────────────────────────────────

/**
 * 创建测试券模板 + 给指定用户发一张。
 *
 * @param {object} opts
 * @param {string} opts.templateId - 自定义模板 ID（默认 NS_CTPL_1）
 * @param {string} opts.couponId - 自定义实例 ID（默认 NS_UC_<userId 尾>）
 * @param {string} opts.couponType - 现金券/品项券/折扣券
 * @param {number} opts.discountValue - 现金/品项=抵扣金额；折扣=折扣率
 * @param {number} opts.minSpend - 满减门槛
 * @param {Date|null} opts.expireAt - 默认 +30 天
 * @param {string} opts.userId - 发给谁
 * @param {string[]|null} opts.applicableCategoryIds - 适用品类（null=全部）
 * @returns {Promise<{templateId, couponId}>}
 */
export async function createTestCoupon({
  templateId = null,
  couponId = null,
  couponType = '现金券',
  discountValue = 30,
  minSpend = 200,
  expireAt = null,
  userId = TEST_CLIENT_USER_ID,
  applicableCategoryIds = null,
  applicableStoreIds = null,
  status = '未使用',
  name = `${NS}_测试券`,
} = {}) {
  const tplId = templateId || `${NS}_CTPL_1`
  const ucId = couponId || `${NS}_UC_${userId.split('_').pop()}`
  const expire = expireAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

  await pgQuery(
    `INSERT INTO coupon_templates (
       template_id, name, coupon_type, discount_value, min_spend,
       applicable_category_ids, applicable_store_ids,
       validity_mode, valid_from, valid_to, is_active
     )
     VALUES ($1, $2, $3::coupon_type, $4, $5,
             $6::text[], $7::text[],
             'fixed', NOW() - INTERVAL '1 day', $8, true)
     ON CONFLICT (template_id) DO UPDATE
       SET discount_value = EXCLUDED.discount_value,
           min_spend = EXCLUDED.min_spend,
           valid_to = EXCLUDED.valid_to,
           applicable_category_ids = EXCLUDED.applicable_category_ids,
           applicable_store_ids = EXCLUDED.applicable_store_ids,
           is_active = true`,
    [tplId, name, couponType, discountValue, minSpend,
     applicableCategoryIds, applicableStoreIds, expire]
  )

  await pgQuery(
    `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at)
     VALUES ($1, $2, $3, $4::coupon_status, $5)
     ON CONFLICT (coupon_id) DO UPDATE
       SET status = EXCLUDED.status,
           expire_at = EXCLUDED.expire_at`,
    [ucId, tplId, userId, status, expire]
  )
  return { templateId: tplId, couponId: ucId }
}

// ────────────────────────────────────────────────────────────────────────
// 清理
// ────────────────────────────────────────────────────────────────────────

/**
 * 清理所有以 prefix 开头的测试数据
 *
 * 顺序由 FK 依赖决定（被引用的表后删）。
 * 用 LIKE prefix% 锁定测试命名空间。
 */
export async function cleanupTestData(prefix = NS) {
  const like = `${prefix}%`
  const testPhones = [TEST_MANAGER_PHONE, TEST_CLIENT_PHONE]

  const stmts = [
    // ─── 1) service / appointment（独立链） ───
    [`DELETE FROM service_items WHERE service_order_id LIKE $1`, [like]],
    [
      // 由 service.create 自动生成的 HLD-WX-* 服务单按 store_id / client / employee 反查
      `DELETE FROM service_items
         WHERE service_order_id IN (
           SELECT service_order_id FROM service_orders
            WHERE store_id LIKE $1
               OR assigned_employee_id LIKE $1
               OR client_user_id LIKE $1
         )`,
      [like],
    ],
    [
      `DELETE FROM service_commissions
         WHERE employee_id LIKE $1
            OR service_item_id IN (
              SELECT service_item_id FROM service_items
                WHERE service_order_id IN (
                  SELECT service_order_id FROM service_orders
                   WHERE store_id LIKE $1 OR assigned_employee_id LIKE $1 OR client_user_id LIKE $1
                )
            )`,
      [like],
    ],
    [`DELETE FROM service_orders WHERE service_order_id LIKE $1`, [like]],
    [
      `DELETE FROM service_orders
         WHERE store_id LIKE $1 OR assigned_employee_id LIKE $1 OR client_user_id LIKE $1`,
      [like],
    ],
    [`DELETE FROM appointments WHERE appointment_id LIKE $1`, [like]],
    [
      `DELETE FROM appointments
         WHERE store_id LIKE $1 OR client_user_id LIKE $1 OR employee_id LIKE $1`,
      [like],
    ],

    // ─── 2) operation_logs（先于 sale_orders）───
    [
      `DELETE FROM operation_logs WHERE target_id LIKE $1 OR target_id IN (
         SELECT sale_order_id FROM sale_orders WHERE sale_order_id LIKE $1
            OR client_user_id LIKE $1 OR opened_by LIKE $1
       )`,
      [like],
    ],
    [
      `DELETE FROM operation_logs
         WHERE operator_employee_id IN (SELECT employee_id FROM staff_wechat_users WHERE employee_id LIKE $1)`,
      [like],
    ],

    // ─── 3) card_transactions（必须先于 prepaid_cards 和 sale_orders）───
    [`DELETE FROM card_transactions WHERE ref_order_id LIKE $1`, [like]],
    [
      `DELETE FROM card_transactions
         WHERE ref_order_id IN (
           SELECT sale_order_id FROM sale_orders WHERE client_user_id LIKE $1 OR opened_by LIKE $1
         )`,
      [like],
    ],
    [
      `DELETE FROM card_transactions
         WHERE card_id IN (
           SELECT card_id FROM prepaid_cards
             WHERE card_id LIKE $1
                OR user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)
         )`,
      [like],
    ],

    // ─── 4) point_transactions ───
    [`DELETE FROM point_transactions WHERE ref_order_id LIKE $1`, [like]],
    [
      `DELETE FROM point_transactions
         WHERE user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)`,
      [like],
    ],

    // ─── 5) sale_order_payments ───
    [`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_order_payments
         WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders WHERE client_user_id LIKE $1 OR opened_by LIKE $1)`,
      [like],
    ],

    // ─── 6) sale_allocations ───
    [`DELETE FROM sale_allocations WHERE sale_item_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_allocations
         WHERE sale_item_id IN (SELECT sale_item_id FROM sale_items
           WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders WHERE client_user_id LIKE $1 OR opened_by LIKE $1))`,
      [like],
    ],

    // ─── 7) sale_items（自引用 ref_sale_item_id：先打断指针，再批量删）───
    [
      `UPDATE sale_items SET ref_sale_item_id = NULL
         WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders
           WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1 OR opened_by LIKE $1)`,
      [like],
    ],
    [
      `DELETE FROM sale_items
         WHERE sale_order_id IN (SELECT sale_order_id FROM sale_orders
           WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1 OR opened_by LIKE $1)`,
      [like],
    ],

    // ─── 8) sale_orders（自引用 ref_sale_order_id：先打断）───
    [
      `UPDATE sale_orders SET ref_sale_order_id = NULL
         WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1 OR opened_by LIKE $1`,
      [like],
    ],
    [
      `DELETE FROM sale_orders
         WHERE sale_order_id LIKE $1 OR client_user_id LIKE $1 OR opened_by LIKE $1`,
      [like],
    ],

    // ─── 9) 券 / 卡 / 权限 ───
    [`DELETE FROM user_coupons WHERE coupon_id LIKE $1 OR template_id LIKE $1`, [like]],
    [
      `DELETE FROM user_coupons
         WHERE user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)`,
      [like],
    ],
    [`DELETE FROM coupon_templates WHERE template_id LIKE $1`, [like]],
    [`DELETE FROM prepaid_cards WHERE card_id LIKE $1`, [like]],
    [
      `DELETE FROM prepaid_cards
         WHERE user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)`,
      [like],
    ],
    [`DELETE FROM permission_roles WHERE employee_id LIKE $1`, [like]],

    // ─── 10) 用户主表 ───
    [`DELETE FROM client_wechat_users WHERE user_id LIKE $1`, [like]],
    [`DELETE FROM client_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],
    [`DELETE FROM staff_wechat_users WHERE employee_id LIKE $1`, [like]],
    [`DELETE FROM staff_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],

    // ─── 11) 商品域 ───
    [`DELETE FROM mall_product_skus WHERE sku_id LIKE $1`, [like]],
    [`DELETE FROM product_skus WHERE sku_id LIKE $1`, [like]],
    [`DELETE FROM product_categories WHERE category_id LIKE $1`, [like]],

    // ─── 12) 门店 / 组织（门店 → 市场 → 总部）───
    [`DELETE FROM stores WHERE store_id LIKE $1 OR org_node_id LIKE $1`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '门店'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '市场'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '总部'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1`, [like]],
  ]

  // 跑 3 遍：每遍 FK 顺序可能部分失败，反复 retry 把跨 smoke 残留全清
  for (let pass = 0; pass < 3; pass++) {
    for (const [sql, params] of stmts) {
      try {
        await pgQuery(sql, params)
      } catch (e) {
        if (pass === 2) {
          console.warn(`[cleanup] skip "${sql.split('\n')[0]}…": ${e.message}`)
        }
      }
    }
  }
}
