// helpers/fixtures.mjs — L3 命名空间基础 fixture（共享给 client/staff 端）
//
// 命名空间：'TEST_E2E_L3_'（与 L2 'TE2L2_' 严格隔离）
//
// 基础内容：org_nodes 三级 + stores + 测试员工 + 测试顾客
// 端特定的 fixture（商品 / 储值卡 / 优惠券 / 消息等）请在
// fengyu-client/tests/e2e-miniprogram/helpers/ 或 fengyu-staff/... 下扩展

import { query, tx } from './pg.mjs'
import {
  NAMESPACE,
  TEST_MANAGER_EMPLOYEE_ID, TEST_OPENID_MANAGER, TEST_MANAGER_PHONE,
  TEST_STAFF_EMPLOYEE_ID, TEST_OPENID_STAFF,
  TEST_CLIENT_USER_ID, TEST_OPENID_CLIENT, TEST_CLIENT_PHONE,
} from './constants.mjs'

const NS = NAMESPACE.replace(/_$/, '')  // 'TEST_E2E_L3'

export const TEST_STORE_ID = `${NS}_STORE`
export const TEST_HQ_ORG_ID = `${NS}_HQ_ORG`
export const TEST_MARKET_ORG_ID = `${NS}_MARKET_ORG`
export const TEST_STORE_ORG_ID = `${NS}_STORE_ORG`

/**
 * 确保 org_nodes 三级 + stores 行存在（幂等）
 */
export async function ensureBaseFixtures() {
  await query(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '总部', NULL, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_HQ_ORG_ID, `${NS}_总部`]
  )
  await query(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '市场', $3, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_MARKET_ORG_ID, `${NS}_市场`, TEST_HQ_ORG_ID]
  )
  await query(
    `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
     VALUES ($1, $2, '门店', $3, 0, true)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_STORE_ORG_ID, `${NS}_测试店`, TEST_MARKET_ORG_ID]
  )
  await query(
    `INSERT INTO stores (store_id, store_name, org_node_id, opening_date, is_closed)
     VALUES ($1, $2, $3, CURRENT_DATE, false)
     ON CONFLICT (store_id) DO NOTHING`,
    [TEST_STORE_ID, `${NS}_测试店`, TEST_STORE_ORG_ID]
  )
  return { storeId: TEST_STORE_ID, storeOrgId: TEST_STORE_ORG_ID }
}

/**
 * 创建测试店长（OPENID 默认 TEST_OPENID_MANAGER；如启 ALLOW_TEST_OPENID 由 _testOpenid 注入）
 */
export async function ensureTestManager(opts = {}) {
  await ensureBaseFixtures()
  const {
    employeeId = TEST_MANAGER_EMPLOYEE_ID,
    openid = TEST_OPENID_MANAGER,
    phone = TEST_MANAGER_PHONE,
    name = `${NS}_店长`,
  } = opts
  await query(
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
  await query(
    `INSERT INTO permission_roles (employee_id, role, scope_id, created_by)
     VALUES ($1, 'manager', $2, 'e2e-l3-fixture')
     ON CONFLICT (employee_id, role, scope_id) DO NOTHING`,
    [employeeId, TEST_STORE_ORG_ID]
  )
  return { employeeId, openid, phone }
}

/**
 * 创建测试美容师
 */
export async function ensureTestBeautician(opts = {}) {
  await ensureBaseFixtures()
  const {
    employeeId = TEST_STAFF_EMPLOYEE_ID,
    openid = TEST_OPENID_STAFF,
    phone = '13900000002',
    name = `${NS}_美容师`,
    position = '美容师',
  } = opts
  await query(
    `INSERT INTO staff_wechat_users (
       employee_id, openid, phone, name, gender, store_id, org_node_id,
       position_name, skills, is_resigned, hired_at
     )
     VALUES ($1, $2, $3, $4, '女', $5, $6, $7,
             ARRAY['美容师']::text[], false, CURRENT_DATE)
     ON CONFLICT (employee_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
           name = EXCLUDED.name, store_id = EXCLUDED.store_id,
           position_name = EXCLUDED.position_name, is_resigned = false`,
    [employeeId, openid, phone, name, TEST_STORE_ID, TEST_STORE_ORG_ID, position]
  )
  return { employeeId, openid, phone }
}

/**
 * 创建测试顾客（默认已绑店 + 已绑手机号）
 */
export async function ensureTestClient(opts = {}) {
  await ensureBaseFixtures()
  const {
    userId = TEST_CLIENT_USER_ID,
    openid = TEST_OPENID_CLIENT,
    phone = TEST_CLIENT_PHONE,
    name = `${NS}_顾客`,
    boundStoreId = TEST_STORE_ID,
    pointsBalance = 0,
  } = opts
  await query(
    `INSERT INTO client_wechat_users (
       user_id, openid, phone, name, gender, bound_store_id,
       customer_type, spending_tier, points_balance
     )
     VALUES ($1, $2, $3, $4, '女', $5,
             '流量客'::customer_type, '<1990'::spending_tier, $6)
     ON CONFLICT (user_id) DO UPDATE
       SET openid = EXCLUDED.openid, phone = EXCLUDED.phone,
           bound_store_id = EXCLUDED.bound_store_id,
           points_balance = EXCLUDED.points_balance`,
    [userId, openid, phone, name, boundStoreId, pointsBalance]
  )
  return { userId, openid, phone }
}

/**
 * 反向清理 L3 命名空间残留（FK 依赖反向）
 *
 * 在跑任何 spec 前后都应调用，确保隔离。
 */
export async function cleanupL3TestData(prefix = NS) {
  const like = `${prefix}%`
  const testPhones = [TEST_MANAGER_PHONE, TEST_CLIENT_PHONE, '13900000002']

  const stmts = [
    // 0a) 复位真实 IDE 用户的 bound_store_id（PROBE 模式 loginAsTestClient 曾把它改成
    //     TEST_E2E_L3_* 门店；测试结束必须清，否则真实用户绑了不存在的门店）
    [`UPDATE client_wechat_users SET bound_store_id = NULL WHERE bound_store_id LIKE $1`, [like]],

    // 子表（FK → sale_orders / sale_items）
    [
      `DELETE FROM card_transactions WHERE card_id IN (
         SELECT card_id FROM prepaid_cards WHERE user_id IN (
           SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
         )
       )`, [like],
    ],
    [`DELETE FROM card_transactions WHERE ref_order_id LIKE $1`, [like]],
    [
      `DELETE FROM point_transactions WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
       )`, [like],
    ],
    [`DELETE FROM operation_logs WHERE target_id LIKE $1`, [like]],
    [`DELETE FROM sale_order_payments WHERE sale_order_id LIKE $1`, [like]],
    [`DELETE FROM sale_allocations WHERE sale_item_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_items WHERE sale_order_id IN (
         SELECT sale_order_id FROM sale_orders WHERE client_user_id IN (
           SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
         )
       )`, [like],
    ],
    [`DELETE FROM sale_items WHERE sale_order_id LIKE $1`, [like]],
    [
      `DELETE FROM sale_orders WHERE client_user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
       )`, [like],
    ],
    [`DELETE FROM sale_orders WHERE sale_order_id LIKE $1`, [like]],

    // 预约 / 服务单
    [`DELETE FROM appointments WHERE client_user_id LIKE $1 OR employee_id LIKE $1`, [like]],
    [
      `DELETE FROM service_items WHERE service_order_id IN (
         SELECT service_order_id FROM service_orders WHERE service_order_id LIKE $1
       )`, [like],
    ],
    [`DELETE FROM service_orders WHERE service_order_id LIKE $1`, [like]],

    // 储值卡
    [
      `DELETE FROM prepaid_cards WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
       )`, [like],
    ],

    // 消息 / 优惠券
    [`DELETE FROM messages WHERE recipient_id LIKE $1`, [like]],
    [
      `DELETE FROM user_coupons WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1
       )`, [like],
    ],
    [`DELETE FROM user_coupons WHERE coupon_id LIKE $1`, [like]],
    [`DELETE FROM coupon_templates WHERE template_id LIKE $1`, [like]],

    // 解绑申请
    [
      `DELETE FROM store_unbind_requests WHERE user_id IN (
         SELECT user_id FROM client_wechat_users WHERE user_id LIKE $1
       ) OR user_id LIKE $1`, [like],
    ],

    // 商品域（mall + product）
    [`DELETE FROM mall_product_skus WHERE sku_id LIKE $1 OR product_id LIKE $1`, [like]],
    [`DELETE FROM mall_bundle_groups WHERE product_id LIKE $1`, [like]],
    [`DELETE FROM products WHERE product_id LIKE $1`, [like]],
    [`DELETE FROM product_skus WHERE sku_id LIKE $1`, [like]],
    [`DELETE FROM product_categories WHERE category_id LIKE $1`, [like]],
    [`DELETE FROM mall_categories WHERE category_id LIKE $1`, [like]],

    // 权限 / 用户 / 门店 / 组织
    [`DELETE FROM permission_roles WHERE employee_id LIKE $1 OR scope_id LIKE $1`, [like]],
    [
      `DELETE FROM operation_logs WHERE operator_employee_id IN (
         SELECT employee_id FROM staff_wechat_users WHERE employee_id LIKE $1
       )`, [like],
    ],
    [`DELETE FROM client_wechat_users WHERE user_id LIKE $1 OR openid LIKE $1`, [like]],
    [`DELETE FROM client_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],
    [`DELETE FROM staff_wechat_users WHERE employee_id LIKE $1 OR org_node_id LIKE $1`, [like]],
    [`DELETE FROM staff_wechat_users WHERE phone = ANY($1::text[])`, [testPhones]],
    [`DELETE FROM stores WHERE store_id LIKE $1 OR org_node_id LIKE $1`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '门店'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '市场'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1 AND type = '总部'`, [like]],
    [`DELETE FROM org_nodes WHERE id LIKE $1`, [like]],
  ]

  for (const [sql, params] of stmts) {
    try {
      await query(sql, params)
    } catch (e) {
      console.warn(`[cleanup-l3] skip "${sql.split('\n')[0]}…": ${e.message}`)
    }
  }
}
