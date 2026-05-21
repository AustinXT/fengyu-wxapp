// bs12-cross-store-deny.spec.mjs — L3 BS-12 跨店越权 UI 拒绝
//
// 场景：manager@A1 登录后，绕开 UI 直接 navigateTo /packageOrder/order-qrcode?saleOrderId=storeB 单
//       验证页面拉详情时被后端拒绝（"订单不在本门店"），UI 显示空态 / toast / 返回。
//
// 设计：
//   1. fixture：A1 店长 + B 店长 + B 店一笔已支付销售单 ORDER_B
//   2. 用 manager@A1 _testOpenid 登录，直接 callStaffApi('order.detail', { saleOrderId: ORDER_B })
//      → 期望 code != 0（INVALID_PARAMS：订单不存在或不属于本门店）
//   3. 用页面 navigateTo 进 order-detail，验证页面 data.order 为空/error
//      （order-detail 内部会用 ctx.auth.effectiveStoreId 过滤，跨店订单查不到）
//
// 这条 spec 主要价值：守护"前端拿到一个不在 scope 的订单号" → 页面不会 silently 渲染对方门店数据。

import { launchStaff, disconnect } from '../helpers/automator.mjs';
import { loginAs, callStaffApiWithTestOpenid } from '../helpers/login.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { closePool, query } from '../helpers/pg.mjs';
import {
  createTestPersonnelMatrix, createTestClient, cleanupL3TestData,
} from '../helpers/fixtures.mjs';
import {
  TEST_OPENID_MANAGER, TEST_OPENID_MANAGER_B1,
  TEST_MGR_B1_EMP_ID, TEST_STORE_B1_ID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE,
  TEST_ORDER_PREFIX, TEST_ITEM_PREFIX,
} from '../helpers/constants.mjs';

let miniProgram = null;

async function createTestOrderInStoreB() {
  // 在 store_B1 建一笔已支付订单（client_user_id 用 fixture 默认顾客，bound_store=A1 也无所谓——
  // 这里我们关心 sale_orders.store_id = B1 而 manager@A1 effectiveStoreId=A1 → 查不到）
  const ts = Date.now().toString().slice(-10);
  const orderId = `${TEST_ORDER_PREFIX}B_${ts}`;
  const itemId = `${TEST_ITEM_PREFIX}B_${ts}`;
  await query(
    `INSERT INTO sale_orders
       (sale_order_id, status, sale_order_type, market_name, store_id,
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, prepaid_card_amount, payable_amount, received,
        payment_method, opened_by)
     VALUES
       ($1, '已支付', '销售单', 'L3 测试市场 B', $2,
        NOW(), $3, $4, 'L3 测试顾客',
        500, 0, 500, 500, '线下', $5)`,
    [orderId, TEST_STORE_B1_ID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, TEST_MGR_B1_EMP_ID],
  );
  await query(
    `INSERT INTO sale_items
       (sale_item_id, sale_order_id, store_id, item_direction,
        product_name, sku_spec_name, product_type,
        unit_price, quantity, unit_real_price, sale_amount, received,
        service_fee, is_shengmei, is_experience)
     VALUES
       ($1, $2, $3, '购买',
        'L3 B 店商品', '标准', '单品',
        500, 1, 500, 500, 500,
        0, false, false)`,
    [itemId, orderId, TEST_STORE_B1_ID],
  );
  return { orderId, itemId };
}

async function runCase(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    return true;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    try { await snapshot(miniProgram, `bs12-${label.replace(/\s+/g, '-')}`); } catch {}
    return false;
  }
}

async function run() {
  console.log('[bs12-cross-store-deny] === START ===');
  resetSnapshots();
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }

  // 建多市场组织 + B 市场店长 + 默认顾客（B 单 client_user_id FK 依赖），再造一笔 B 店订单
  await createTestPersonnelMatrix();
  await createTestClient();
  const { orderId } = await createTestOrderInStoreB();
  console.log(`  ✓ fixture: B 店订单 ${orderId}`);

  miniProgram = await launchStaff();
  let fail = 0;

  // ─── Case 1: A1 店长直接调 order.detail(orderId=B 店单) → INVALID_PARAMS ───
  if (!await runCase('A1.order.detail.B_order → INVALID_PARAMS', async () => {
    await loginAs(miniProgram, TEST_OPENID_MANAGER);
    let denied = false;
    try {
      await callStaffApiWithTestOpenid(miniProgram, 'order.detail',
        { saleOrderId: orderId }, TEST_OPENID_MANAGER);
    } catch (e) {
      denied = true;
      // 期望 message 含 "订单不存在或不属于本门店" 或 "PERMISSION_DENIED"
      const ok = /INVALID_PARAMS|PERMISSION_DENIED|不存在|不属于/.test(e.message);
      if (!ok) throw new Error(`期望拒绝拒绝信息，实际: ${e.message}`);
    }
    if (!denied) throw new Error('A1 manager 直接调 detail 应该被拒绝，但返回 code=0');
  })) fail++;

  // ─── Case 2: A1 店长 navigateTo order-detail 页面 → data.order 应为空或显示错误 ───
  if (!await runCase('A1.navigate.order-detail.B_order → empty/error', async () => {
    await miniProgram.navigateTo(`/packageOrder/order-detail/order-detail?id=${encodeURIComponent(orderId)}`);
    await new Promise(r => setTimeout(r, 1500));
    const page = await miniProgram.currentPage();
    const data = await page.data();
    // 不同实现：data.order=null / data.error=true / data 缺关键字段
    const orderField = data.order ?? data.detail ?? null;
    // 跨店单显示了完整内容 → fail
    if (orderField && orderField.sale_order_id === orderId && orderField.store_id) {
      throw new Error(`order-detail 页面渲染了 B 店订单数据，未阻断: ${JSON.stringify(orderField).slice(0, 200)}`);
    }
  })) fail++;

  // ─── Case 3: B 店长可以查同一笔单（对照组：scope 内 OK）───
  if (!await runCase('B1.order.detail.B_order → OK', async () => {
    await loginAs(miniProgram, TEST_OPENID_MANAGER_B1, TEST_STORE_B1_ID);
    const data = await callStaffApiWithTestOpenid(miniProgram, 'order.detail',
      { saleOrderId: orderId }, TEST_OPENID_MANAGER_B1);
    if (!data?.order?.sale_order_id) {
      throw new Error(`B 店长应能拿到自家订单，实际 data=${JSON.stringify(data).slice(0, 200)}`);
    }
    if (data.order.sale_order_id !== orderId) {
      throw new Error(`订单号不符: 期望=${orderId}, 实际=${data.order.sale_order_id}`);
    }
  })) fail++;

  console.log(`[bs12-cross-store-deny] cases 3 / 失败 ${fail}`);
  if (fail > 0) {
    dumpRecentSnapshots(5);
    throw new Error(`BS-12 失败 ${fail}/3`);
  }
  console.log('[bs12-cross-store-deny] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[bs12-cross-store-deny] === FAIL ===');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch {}
    await disconnect(miniProgram);
    await closePool();
  }
}
main();
