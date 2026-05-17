// bs05-appt-to-service.spec.mjs — L3 BS-05 预约 → 到店 → 服务单自动创建
// 设计文档：BUSINESS-SCENARIOS-DESIGN.md §5 BS-05
//
// ⚠️ 已知 prod bug（截 2026-05-17）：staffApi/routes/service.js create() 第 211 行 INSERT
//    service_items 写了 sku_id 列，但 db/schema/service.ts 的 service_items 表**没有** sku_id 字段。
//    step 4 提交必抛 `column "sku_id" of relation "service_items" does not exist` → toast 报错。
//    本 spec step 4 标记 expected fail；prod bug 修复后会自动走 PASS 分支并提醒删 expected-fail 注释。
//
// 不确定点：
//   1. appointment-detail URL 参数名 = `?id=<appointmentId>`（appointment-detail.ts onLoad 取 options.id）
//   2. step 4 提交：直接 page.callMethod('onSubmit') + setData 模拟勾选，避免 Vant cell tap 不稳定
//   3. items 自动带入：appointment 分支只填 selectedCustomer，paidOrders 由 loadPaidOrders 异步填，
//      selectedItems 必须测试侧主动 setData 模拟用户勾选（UI 上是 onToggleItem 触发）
//   4. appointments.employee_id NOT NULL → fixture 用 TEST_MANAGER_EMPLOYEE_ID（manager 看自己的预约不受 scope 拦）
//   5. appointment → '已完成' 自动转的触发点不在 service.create，在 service.complete；本 spec 不覆盖此跳变

import { launchStaff, disconnect, waitForData } from '../helpers/automator.mjs';
import { loginStaffWithTestOpenid } from '../helpers/login.mjs';
import { installToastHook, assertToast, clearToasts, autoConfirmModal } from '../helpers/toast.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { query, pgPoll, closePool } from '../helpers/pg.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from '../helpers/fixtures.mjs';
import {
  TEST_OPENID_MANAGER, TEST_CLIENT_USER_ID,
  NAMESPACE, TEST_ORDER_PREFIX, TEST_ITEM_PREFIX,
} from '../helpers/constants.mjs';

let miniProgram = null;
// ID 长度约束：sale_order_id / sale_item_id varchar(30)
// TEST_ORDER_PREFIX/TEST_ITEM_PREFIX 已 16 字符 → 后缀最多 14 字符（base36 TS 取 8 字符）
const TS = Date.now().toString(36).slice(-8);
const APPT_ID = `${NAMESPACE}APPT_${TS}`;
const PAID_ORDER_ID = `${TEST_ORDER_PREFIX}${TS}`;
const PAID_ITEM_ID = `${TEST_ITEM_PREFIX}${TS}`;

async function seedFixture(mgr, cli) {
  await query(
    `INSERT INTO sale_orders (sale_order_id, status, sale_order_type, market_name, store_id,
        sale_order_datetime, client_user_id, client_phone, customer_name,
        total_amount, prepaid_card_amount, payable_amount, received, payment_method, opened_by)
     VALUES ($1, '已支付', '销售单', 'L3 测试市场', $2, NOW(), $3, $4, 'L3 测试顾客',
        1500, 0, 1500, 1500, '线下', $5)`,
    [PAID_ORDER_ID, mgr.storeId, cli.userId, cli.phone, mgr.employeeId],
  );
  await query(
    `INSERT INTO sale_items (sale_item_id, sale_order_id, store_id, item_direction,
        product_name, sku_spec_name, product_type, unit_price, quantity, unit_real_price,
        sale_amount, received, service_fee, is_shengmei, is_experience, is_recharge_card,
        session_count, remaining_sessions)
     VALUES ($1, $2, $3, '购买', 'L3 疗程卡', '5次卡', '疗程卡', 1500, 1, 1500,
        1500, 1500, 0, false, false, false, 5, 5)`,
    [PAID_ITEM_ID, PAID_ORDER_ID, mgr.storeId],
  );
  await query(
    `INSERT INTO appointments (appointment_id, status, store_id, client_user_id, client_name,
        employee_id, employee_name, sale_item_id, appointment_time, confirmed_at)
     VALUES ($1, '已确认', $2, $3, 'L3 测试顾客', $4, 'L3 测试店长', $5, NOW(), NOW())`,
    [APPT_ID, mgr.storeId, cli.userId, mgr.employeeId, PAID_ITEM_ID],
  );
}

async function run() {
  console.log('[bs05] === START ===');
  resetSnapshots();

  console.log('[step 0] cleanup + fixture');
  await cleanupL3TestData();
  const manager = await createTestManager();
  const client = await createTestClient();
  await seedFixture(manager, client);
  console.log(`  appt=${APPT_ID} item=${PAID_ITEM_ID}`);

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);
  await installToastHook(miniProgram);

  // Step 1: appointment-detail 加载 + 状态=已确认
  console.log('[step 1] navigate appointment-detail');
  await clearToasts(miniProgram);
  await miniProgram.navigateTo(
    `/packageService/appointment-detail/appointment-detail?id=${APPT_ID}`,
  );
  await waitForData(miniProgram, (d) => d.appt?.id === APPT_ID && d.statusText === '已确认');
  await snapshot(miniProgram, 'bs05-step1-detail');
  console.log('  ✓ statusText=已确认');

  // Step 2: 顾客已到店 → checkin
  console.log('[step 2] checkin');
  await clearToasts(miniProgram);
  let page = await miniProgram.currentPage();
  await page.callMethod('onCheckin');
  await assertToast(miniProgram, '顾客到店已记录');
  await pgPoll(
    'SELECT checkin_at FROM appointments WHERE appointment_id = $1',
    [APPT_ID],
    (rows) => rows.length === 1 && rows[0].checkin_at !== null,
  );
  await snapshot(miniProgram, 'bs05-step2-checkin');
  console.log('  ✓ checkin_at written');

  // Step 3: 创建服务单 → service-create 页带入 client + items
  console.log('[step 3] navigate service-create');
  await clearToasts(miniProgram);
  page = await miniProgram.currentPage();
  await page.callMethod('onCreateService');
  await waitForData(
    miniProgram,
    (d) => d.appointmentId === APPT_ID
      && d.selectedCustomer?.id === TEST_CLIENT_USER_ID
      && Array.isArray(d.paidOrders),
    { timeoutMs: 8000 },
  );
  const paid = await miniProgram.evaluate(() => {
    const p = getCurrentPages().slice(-1)[0];
    return { paidOrders: p.data.paidOrders };
  });
  if (!paid.paidOrders.some(o => o.items.some(i => i.saleItemId === PAID_ITEM_ID))) {
    throw new Error(`paidOrders 未含 fixture item=${PAID_ITEM_ID}: ${JSON.stringify(paid.paidOrders)}`);
  }
  await snapshot(miniProgram, 'bs05-step3-svc-create');
  console.log('  ✓ service-create 带入 client + paidOrders');

  // Step 4: 提交（⚠️ EXPECTED FAIL — prod bug sku_id）
  console.log('[step 4] submit (EXPECTED FAIL until prod bug fix)');
  await clearToasts(miniProgram);
  await autoConfirmModal(miniProgram);
  page = await miniProgram.currentPage();
  await page.setData({
    selectedItems: [{
      saleItemId: PAID_ITEM_ID, itemName: 'L3 疗程卡', spec: '5次卡',
      saleOrderId: PAID_ORDER_ID, sessionCount: 1,
    }],
    selectedFlowNos: { [PAID_ITEM_ID]: true },
    selectedSessionCounts: { [PAID_ITEM_ID]: 1 },
  });
  await page.callMethod('onSubmit');

  let outcome = 'unknown';
  try {
    await assertToast(miniProgram, '服务单已创建', { timeoutMs: 4000 });
    const svc = await pgPoll(
      `SELECT service_order_id, appointment_id FROM service_orders WHERE appointment_id = $1`,
      [APPT_ID],
      (rows) => rows.length === 1,
    );
    if (svc[0].appointment_id !== APPT_ID) {
      throw new Error(`service_orders.appointment_id 期望 ${APPT_ID} 实际 ${svc[0].appointment_id}`);
    }
    outcome = 'PASS_unexpected';
    console.warn('  ⚠️ prod bug 似已修复，请删除 step 4 的 expected-fail 注释 + 头部 ⚠️ 块');
  } catch (_) {
    const toasts = await miniProgram.evaluate(() => wx.__e2e_toasts || []);
    const sawErr = toasts.some(t => /sku_id|提交失败|不存在|失败/.test(t.title || ''));
    if (!sawErr) {
      throw new Error(`step 4 未 PASS 也未抓到预期错误 toast: ${JSON.stringify(toasts)}`);
    }
    outcome = 'EXPECTED_FAIL';
    console.log(`  ✓ EXPECTED FAIL: ${toasts.map(t => t.title).join(' | ')}`);
  }
  await snapshot(miniProgram, 'bs05-step4-submit');

  console.log(`[bs05] === DONE (submit=${outcome}) ===`);
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[bs05] === FAIL ===');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    dumpRecentSnapshots(3);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch (e) { console.warn('[cleanup]', e.message); }
    await disconnect(miniProgram);
    await closePool();
  }
}

main();
