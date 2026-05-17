// helpers/fixtures.mjs — L3 命名空间下的 PG fixture 造数与清理
//
// 命名空间约束：所有写入的主键必须以 TEST_E2E_L3_ 前缀打头。
// cleanup 必须仅删命名空间数据，绝对禁止 DELETE FROM xxx 无 WHERE。

import { query, tx } from './pg.mjs';
import {
  NAMESPACE,
  TEST_OPENID_MANAGER,
  TEST_OPENID_STAFF,
  TEST_OPENID_CLIENT,
  TEST_MANAGER_EMPLOYEE_ID,
  TEST_STAFF_EMPLOYEE_ID,
  TEST_CLIENT_USER_ID,
  TEST_CLIENT_PHONE,
  TEST_MANAGER_PHONE,
  TEST_ORDER_PREFIX,
  TEST_ITEM_PREFIX,
} from './constants.mjs';

// 测试组织节点 id
const TEST_HQ_ID = 'TEST_E2E_L3_HQ';
const TEST_MARKET_ID = 'TEST_E2E_L3_MK';
const TEST_STORE_ID = 'TEST_E2E_L3_STORE';
const TEST_STORE_ORG_ID = 'TEST_E2E_L3_STORE_ORG';

/**
 * 准备基础组织/门店 fixture（幂等：用 ON CONFLICT DO NOTHING；不清理已有数据）。
 *
 * 注意：本函数不调用 cleanup —— cleanup 是 smoke 入口 / teardown 的责任。
 * 否则连续 create* 调用会互相删除对方刚写入的数据。
 */
export async function ensureBaseFixtures() {
  await tx(async (c) => {
    // org_nodes：总部 → 市场 → 门店（type='门店'）
    await c.query(
      `INSERT INTO org_nodes (id, name, type, parent_id, sort_order, is_active)
       VALUES
         ($1, $2, '总部', NULL, 0, true),
         ($3, $4, '市场', $1, 0, true),
         ($5, $6, '门店', $3, 0, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_HQ_ID, 'L3 测试总部', TEST_MARKET_ID, 'L3 测试市场', TEST_STORE_ORG_ID, 'L3 测试门店'],
    );

    // stores：1:1 扩展 org_nodes type='门店'
    await c.query(
      `INSERT INTO stores (store_id, store_name, org_node_id, is_closed)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (store_id) DO NOTHING`,
      [TEST_STORE_ID, 'L3 测试门店', TEST_STORE_ORG_ID],
    );
  });
}

/**
 * 造一个店长（manager + 门店 scope）。
 */
export async function createTestManager() {
  await ensureBaseFixtures();

  await tx(async (c) => {
    await c.query(
      `INSERT INTO staff_wechat_users
         (employee_id, openid, phone, name, position_name, store_id, org_node_id, is_resigned)
       VALUES ($1, $2, $3, $4, '店长', $5, $6, false)
       ON CONFLICT (employee_id) DO UPDATE
         SET openid = EXCLUDED.openid, phone = EXCLUDED.phone, store_id = EXCLUDED.store_id, is_resigned = false`,
      [TEST_MANAGER_EMPLOYEE_ID, TEST_OPENID_MANAGER, TEST_MANAGER_PHONE, 'L3 测试店长', TEST_STORE_ID, TEST_STORE_ORG_ID],
    );

    // permission_roles: (manager, 门店 scope)
    await c.query(
      `INSERT INTO permission_roles (employee_id, role, scope_id, created_by)
       VALUES ($1, 'manager', $2, 'L3_E2E_TEST')
       ON CONFLICT (employee_id, role, scope_id) DO NOTHING`,
      [TEST_MANAGER_EMPLOYEE_ID, TEST_STORE_ORG_ID],
    );
  });

  return {
    employeeId: TEST_MANAGER_EMPLOYEE_ID,
    openid: TEST_OPENID_MANAGER,
    phone: TEST_MANAGER_PHONE,
    storeId: TEST_STORE_ID,
  };
}

/**
 * 造一个普通顾客（已绑定门店）。
 */
export async function createTestClient() {
  await ensureBaseFixtures();

  await tx(async (c) => {
    await c.query(
      `INSERT INTO client_wechat_users
         (user_id, openid, phone, name, bound_store_id)
       VALUES ($1, $2, $3, 'L3 测试顾客', $4)
       ON CONFLICT (user_id) DO UPDATE
         SET openid = EXCLUDED.openid, phone = EXCLUDED.phone, bound_store_id = EXCLUDED.bound_store_id`,
      [TEST_CLIENT_USER_ID, TEST_OPENID_CLIENT, TEST_CLIENT_PHONE, TEST_STORE_ID],
    );
  });

  return {
    userId: TEST_CLIENT_USER_ID,
    openid: TEST_OPENID_CLIENT,
    phone: TEST_CLIENT_PHONE,
    storeId: TEST_STORE_ID,
  };
}

/**
 * 造一个待确认收款（线下支付）的销售订单 + 1 条 sale_items。
 *
 * 注意：
 * - sale_order_id 主键格式不限于 FY-XSD-WX-... 我们用 TEST_E2E_L3_ORD_<ts> 区分
 * - payment_method='线下'，status='待支付'，便于 confirmOffline 转 '已支付'
 */
export async function createTestPendingOfflineOrder({ amount = 100 } = {}) {
  const manager = await createTestManager();
  const client = await createTestClient();

  const ts = Date.now().toString().slice(-10);
  const orderId = `${TEST_ORDER_PREFIX}${ts}`;
  const itemId = `${TEST_ITEM_PREFIX}${ts}`;

  await tx(async (c) => {
    await c.query(
      `INSERT INTO sale_orders
         (sale_order_id, status, sale_order_type, market_name, store_id,
          sale_order_datetime, client_user_id, client_phone, customer_name,
          total_amount, prepaid_card_amount, payable_amount, received,
          payment_method, opened_by)
       VALUES
         ($1, '待支付', '销售单', 'L3 测试市场', $2,
          NOW(), $3, $4, 'L3 测试顾客',
          $5, 0, $5, 0,
          '线下', $6)`,
      [orderId, client.storeId, client.userId, client.phone, amount, manager.employeeId],
    );

    await c.query(
      `INSERT INTO sale_items
         (sale_item_id, sale_order_id, store_id, item_direction,
          product_name, sku_spec_name, product_type,
          unit_price, quantity, unit_real_price, sale_amount, received,
          service_fee, is_shengmei, is_experience, is_recharge_card)
       VALUES
         ($1, $2, $3, '购买',
          'L3 测试商品', '标准规格', '单品',
          $4, 1, $4, $4, 0,
          0, false, false, false)`,
      [itemId, orderId, client.storeId, amount],
    );
  });

  return { orderId, itemId, amount, manager, client };
}

/**
 * 清理 L3 命名空间下的所有数据。
 * 严格通过 LIKE 'TEST_E2E_L3_%' 过滤；不会触及生产数据。
 *
 * 删除顺序：明细 → 主表 → 字典/权限 → 顾客/员工 → 门店/组织
 */
export async function cleanupL3TestData() {
  // 用普通 query（非事务）避免循环 FK 时单事务过大；每条 DELETE 都有命名空间 WHERE
  // 1. 销售相关
  await query(
    `DELETE FROM sale_allocations
     WHERE sale_item_id LIKE $1`,
    [`${TEST_ITEM_PREFIX}%`],
  );
  await query(
    `DELETE FROM sale_order_payments
     WHERE sale_order_id LIKE $1`,
    [`${TEST_ORDER_PREFIX}%`],
  );
  await query(
    `DELETE FROM card_transactions
     WHERE ref_order_id LIKE $1`,
    [`${TEST_ORDER_PREFIX}%`],
  );
  await query(
    `DELETE FROM sale_items
     WHERE sale_order_id LIKE $1`,
    [`${TEST_ORDER_PREFIX}%`],
  );
  await query(
    `DELETE FROM sale_orders
     WHERE sale_order_id LIKE $1`,
    [`${TEST_ORDER_PREFIX}%`],
  );

  // 2. 权限
  await query(
    `DELETE FROM permission_roles
     WHERE employee_id LIKE $1`,
    [`${NAMESPACE}%`],
  );

  // 3. 顾客
  await query(
    `DELETE FROM client_wechat_users
     WHERE user_id LIKE $1`,
    [`${NAMESPACE}%`],
  );

  // 4. 员工
  await query(
    `DELETE FROM staff_wechat_users
     WHERE employee_id LIKE $1`,
    [`${NAMESPACE}%`],
  );

  // 5. 门店（子先删）
  await query(
    `DELETE FROM stores
     WHERE store_id LIKE $1`,
    [`${NAMESPACE}%`],
  );

  // 6. 组织（要按 type 倒序：门店 → 市场 → 总部）
  await query(
    `DELETE FROM org_nodes
     WHERE id LIKE $1 AND type = '门店'`,
    [`${NAMESPACE}%`],
  );
  await query(
    `DELETE FROM org_nodes
     WHERE id LIKE $1 AND type = '市场'`,
    [`${NAMESPACE}%`],
  );
  await query(
    `DELETE FROM org_nodes
     WHERE id LIKE $1 AND type = '总部'`,
    [`${NAMESPACE}%`],
  );
}

/**
 * 断言订单状态。
 */
export async function assertOrderStatus(orderId, expectedStatus) {
  const rows = await query(
    `SELECT status, received, offline_confirmed_at, offline_confirmed_by
     FROM sale_orders
     WHERE sale_order_id = $1`,
    [orderId],
  );
  if (rows.length === 0) {
    throw new Error(`[assert] 订单不存在: ${orderId}`);
  }
  const actual = rows[0].status;
  if (actual !== expectedStatus) {
    throw new Error(
      `[assert] 订单 ${orderId} 状态期望 "${expectedStatus}" 实际 "${actual}"，` +
      `received=${rows[0].received}, offline_confirmed_at=${rows[0].offline_confirmed_at}`,
    );
  }
  return rows[0];
}
