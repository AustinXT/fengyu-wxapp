/**
 * 端到端 fixture：测试组织 / 门店 / 员工 / 顾客 / 销售单。
 *
 * 所有写入必须以命名空间 (默认 'TEST_E2E_L2') 为前缀，cleanupTestData 用前缀
 * WHERE 精确清理，保证不污染生产数据。
 *
 * 创建顺序：
 *   org_nodes(总部 → 市场 → 门店) → stores → staff_wechat_users + permission_roles
 *   → client_wechat_users → sale_orders + sale_items
 *
 * 清理顺序（FK 依赖反向）：
 *   point_transactions → operation_logs → sale_allocations → sale_items
 *   → sale_order_payments → sale_orders → client_wechat_users → permission_roles
 *   → staff_wechat_users → stores → org_nodes
 */
import {
  NS,
  TEST_STORE_ID, TEST_STORE_ORG_ID, TEST_HQ_ORG_ID, TEST_MARKET_ORG_ID,
  TEST_STORE_ID_2, TEST_STORE_ORG_ID_2,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_MANAGER_PHONE,
  TEST_CLIENT_USER_ID, TEST_CLIENT_OPENID, TEST_CLIENT_PHONE,
  pgQuery, getPool,
} from '../setup.mjs'

/**
 * 确保测试组织架构（总部 → 市场 → 门店）+ stores 行存在
 * 幂等：用 ON CONFLICT DO NOTHING / DO UPDATE
 */
export async function ensureTestStore() {
  // org_nodes 链
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

  // stores 行（与 org_nodes 的 type='门店' 节点 1:1）
  await pgQuery(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false)
     ON CONFLICT (store_id) DO NOTHING`,
    [TEST_STORE_ID, `${NS}_测试店`, TEST_STORE_ORG_ID]
  )

  return { storeId: TEST_STORE_ID, storeOrgId: TEST_STORE_ORG_ID, marketOrgId: TEST_MARKET_ORG_ID, hqOrgId: TEST_HQ_ORG_ID }
}

/**
 * 确保第二测试门店存在（转店目标店，挂在同一市场下）
 * 依赖 ensureTestStore() 已建好市场节点
 */
export async function ensureTestStore2() {
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '门店', $3, 1, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_STORE_ORG_ID_2, `${NS}_测试店2`, TEST_MARKET_ORG_ID]
  )
  await pgQuery(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false)
     ON CONFLICT (store_id) DO NOTHING`,
    [TEST_STORE_ID_2, `${NS}_测试店2`, TEST_STORE_ORG_ID_2]
  )
  return { storeId: TEST_STORE_ID_2, storeOrgId: TEST_STORE_ORG_ID_2 }
}

/**
 * 创建测试店长（员工 + manager 角色绑定到测试门店）
 * @returns {Promise<{employeeId, openid, phone}>}
 */
export async function createTestStaff({
  employeeId = TEST_MANAGER_EMP_ID,
  openid = TEST_MANAGER_OPENID,
  phone = TEST_MANAGER_PHONE,
  name = `${NS}_店长`,
  isManager = true,
} = {}) {
  await ensureTestStore()

  // staff_wechat_users 行
  await pgQuery(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id, org_node_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6, '门店经理',
             ARRAY['美容师']::text[], false, CURRENT_DATE)
     ON CONFLICT (employee_id) DO UPDATE
       SET openid = EXCLUDED.openid,
           phone = EXCLUDED.phone,
           name = EXCLUDED.name,
           store_id = EXCLUDED.store_id,
           is_resigned = false`,
    [employeeId, openid, phone, name, TEST_STORE_ID, TEST_STORE_ORG_ID]
  )

  // permission_roles（店长在测试门店）
  if (isManager) {
    await pgQuery(
      `INSERT INTO permission_roles (employee_id, role, scope_id, created_by)
       VALUES ($1, 'manager', $2, 'e2e-fixture')
       ON CONFLICT (employee_id, role, scope_id) DO NOTHING`,
      [employeeId, TEST_STORE_ORG_ID]
    )
  }

  return { employeeId, openid, phone }
}

/**
 * 创建测试顾客
 */
export async function createTestClient({
  userId = TEST_CLIENT_USER_ID,
  openid = TEST_CLIENT_OPENID,
  phone = TEST_CLIENT_PHONE,
  name = `${NS}_顾客`,
  boundStoreId = TEST_STORE_ID,
  pointsBalance = 0,
} = {}) {
  await ensureTestStore()
  await pgQuery(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, $3, $4, '女', $5, '流量客'::customer_type, '<1990'::spending_tier, $6)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid,
           phone = EXCLUDED.phone,
           bound_store_id = EXCLUDED.bound_store_id,
           points_balance = EXCLUDED.points_balance,
           customer_type = '流量客'::customer_type,
           spending_tier = '<1990'::spending_tier`,
    [userId, openid, phone, name, boundStoreId, pointsBalance]
  )
  return { userId, openid, phone }
}

/**
 * 创建一个"待确认收款"销售单（含 sale_items 一行）
 *
 * @param {object} opts
 * @param {string} opts.saleOrderId - 必填，命名空间前缀编号，如 'TEST_E2E_L2_ORDER_001'
 * @param {string} opts.clientUserId - 顾客 user_id
 * @param {string} opts.storeId - 默认测试门店
 * @param {string} opts.openedBy - 员工 employee_id（开单店长）
 * @param {number} opts.totalAmount - 含一行 sale_items received 之和（默认 300）
 * @param {string} opts.status - 初始状态（默认 '待支付'）
 */
export async function createTestSaleOrder({
  saleOrderId,
  clientUserId,
  storeId = TEST_STORE_ID,
  openedBy = TEST_MANAGER_EMP_ID,
  totalAmount = 300,
  status = '待支付',
  paymentMethod = '线下',
} = {}) {
  if (!saleOrderId) throw new Error('createTestSaleOrder: saleOrderId required')
  if (!clientUserId) throw new Error('createTestSaleOrder: clientUserId required')

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // sale_orders
    await client.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, opened_by, allocation_status
       )
       VALUES ($1, $2::order_status, '销售单'::sale_order_type, $3, $4,
               NOW(), $5, $6, $7,
               $8, 0, $8, 0,
               $9::payment_method, $10, '待分配'::allocation_status)`,
      [
        saleOrderId, status, `${NS}_市场`, storeId,
        clientUserId, TEST_CLIENT_PHONE, `${NS}_顾客`,
        totalAmount, paymentMethod, openedBy,
      ]
    )

    // sale_items 一行：疗程卡 productType / sale_amount=received=totalAmount
    const itemId = `${saleOrderId}_ITEM_1`
    await client.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, product_type,
         unit_price, quantity, unit_real_price, sale_amount, received,
         is_experience
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               NULL, $4, '疗程卡'::product_type,
               $5, 1, $5, $5, $5,
               false)`,
      [itemId, saleOrderId, storeId, `${NS}_测试商品`, totalAmount]
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

/**
 * 清理所有以 prefix 开头的测试数据
 *
 * 顺序由 FK 依赖决定（被引用的表后删）。
 * 用 LIKE prefix% 锁定测试命名空间。
 */
export async function cleanupTestData(prefix = NS) {
  const like = `${prefix}%`
  const testPhones = [TEST_MANAGER_PHONE, TEST_CLIENT_PHONE]

  // 找出本次涉及的 user_id / employee_id / store_id / order_id
  // （所有 fixture 都用了固定的 NS 前缀，可直接 LIKE）
  const stmts = [
    // 1) 子表（依赖 sale_orders / sale_items）
    [`DELETE FROM card_transactions WHERE ref_order_id LIKE $1`, [like]],
    [`DELETE FROM point_transactions WHERE ref_order_id LIKE $1`, [like]],
    [
      `DELETE FROM point_transactions
         WHERE user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)`,
      [like],
    ],
    [
      `DELETE FROM operation_logs WHERE target_id LIKE $1 OR target_id IN (
         SELECT sale_order_id FROM sale_orders WHERE sale_order_id LIKE $1
       )`,
      [like],
    ],
    // sale_payment_allocatable_items / sale_allocations 引用 payments(+items)，必须先于 payments/items/orders 删，
    // 否则 payments/orders 删除撞 FK 被 skip → 残留「待支付」单撞 uq_sale_orders_client_pending，污染后续 spec。
    [`DELETE FROM sale_payment_allocatable_items WHERE sale_order_id LIKE $1`, [like]],
    [`DELETE FROM sale_allocations WHERE sale_item_id LIKE $1 OR sale_payment_id IN (SELECT id FROM sale_order_payments WHERE sale_order_id LIKE $1)`, [like]],
    [`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [like]],
    [`DELETE FROM sale_items WHERE sale_order_id LIKE $1`, [like]],
    [`DELETE FROM sale_orders WHERE sale_order_id LIKE $1`, [like]],

    // 2) 用户/员工相关副表
    [
      `DELETE FROM prepaid_cards
         WHERE user_id IN (SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1)`,
      [like],
    ],
    // permission_roles FK → staff_wechat_users，必须在 staff 之前删；
    // 双轨清扫：employee_id LIKE NS、scope_id LIKE NS，以及 employee_id IN(NS-staff)
    [`DELETE FROM permission_roles WHERE employee_id LIKE $1 OR scope_id LIKE $1`, [like]],
    [
      `DELETE FROM permission_roles WHERE employee_id IN (
         SELECT employee_id FROM staff_wechat_users
         WHERE employee_id LIKE $1 OR org_node_id LIKE $1 OR store_id LIKE $1
       )`,
      [like],
    ],
    [
      `DELETE FROM operation_logs
         WHERE operator_employee_id IN (SELECT employee_id FROM staff_wechat_users WHERE employee_id LIKE $1)`,
      [like],
    ],

    // 3) 主表
    [`DELETE FROM client_wechat_users WHERE user_id LIKE $1`, [like]],
    // 防御：也按已知测试手机号清理（处理 _testOpenid 命名空间漂移导致的残留）
    [`DELETE FROM client_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],
    // staff 需要在 stores 之前删（staff.store_id FK → stores）
    [`DELETE FROM staff_wechat_users WHERE employee_id LIKE $1 OR store_id LIKE $1 OR org_node_id LIKE $1`, [like]],
    [`DELETE FROM staff_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],
    [`DELETE FROM stores WHERE store_id LIKE $1`, [like]],

    // 4) org_nodes 必须按层级反向（最叶节点先删）
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '门店'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '市场'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '总部'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1`, [like]],
  ]

  for (const [sql, params] of stmts) {
    try {
      await pgQuery(sql, params)
    } catch (e) {
      // 个别表可能 schema 不同（比如没有 prepaid_cards），打印但不中断
      console.warn(`[cleanup] skip "${sql.split('\n')[0]}…": ${e.message}`)
    }
  }
}
