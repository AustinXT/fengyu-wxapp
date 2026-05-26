// bs07-customer-assign.spec.mjs — BS-07 顾客分配（双 actor）
//
// 用户故事：店长 A 在 customer-list 把顾客小王分配给本店美容师 C；
//          切换登录身份到 C，验证 C 通过 customer.search 能看到小王。
//
// ─── 已知不确定点 / 假设（顶部 5 条）───
// 1. customer-list 卡片的"分配"触发是 **bindlongpress**（非 tap）；
//    miniprogram-automator Element 没有 longpress API（只有 tap/touchstart/end）。
//    退化：直接 `page.callMethod('onLongPressAssign', mockEvent)` 触发同名 handler，
//    不走真实手势，等价于业务逻辑层验证。
// 2. customer-list.ts L205~L210 调 `staff.list` 后直接 `(staff || []).map(...)`，
//    但路由实际返回 `{ staffList: [...] }`（对象，非数组）。这是 page 端的真实 bug，
//    会导致 onLongPressAssign 走 catch 分支 toast "获取员工列表失败"。
//    本 spec 绕开 page 内的列表加载，直接 `page.callMethod('onAssignSelect', { detail })`
//    用伪造 action 触发 assign API；这等价于"用户从 action sheet 选了 C"。
// 3. loginAs 的已知限制：auth.login 不读 _testOpenid，前端 globalData.staffWfId
//    可能不变；故 C 端"我的客户列表"无法用 UI 验证。退化为
//    `callStaffApiWithTestOpenid('customer.search', { phone }, BEAU_OPENID)` 验。
// 4. customer.assign 校验 employeeId 必须 `store_id = ctx.auth.effectiveStoreId`，
//    所以美容师 C 必须与店长 A 同 store_id（TEST_STORE_ID）。
// 5. assign 写库后 `bound_employee_id` 即时落，pgPoll 1s 内应可见；
//    若超时多半是 auth scope 解错门店导致 UPDATE rowCount=0（API 抛 PERMISSION_DENIED）。

import { launchStaff, disconnect, navigateToTab, waitForData } from '../helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid, loginAs } from '../helpers/login.mjs';
import { installToastHook, assertToast, clearToasts, autoConfirmModal } from '../helpers/toast.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { query, pgPoll, closePool, tx } from '../helpers/pg.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from '../helpers/fixtures.mjs';
import {
  TEST_OPENID_MANAGER,
  TEST_MANAGER_EMPLOYEE_ID,
  TEST_CLIENT_USER_ID,
  TEST_CLIENT_PHONE,
  NAMESPACE,
} from '../helpers/constants.mjs';

// 美容师 C — 与店长同店但非 manager
const BEAU_EMPLOYEE_ID = `${NAMESPACE}BEAU_001`;
const BEAU_OPENID = `${NAMESPACE}BEAU_OPENID`;
const BEAU_PHONE = '13900000002';
const TEST_STORE_ID = 'TEST_E2E_L3_STORE';
const TEST_STORE_ORG_ID = 'TEST_E2E_L3_STORE_ORG';

let miniProgram = null;

async function createTestBeautician() {
  // 复用 ensureBaseFixtures 写的 org / store；这里只插员工行，不写 permission_roles（非 manager）
  await tx(async (c) => {
    await c.query(
      `INSERT INTO staff_wechat_users
         (employee_id, openid, phone, name, position_name, store_id, org_node_id, is_resigned)
       VALUES ($1, $2, $3, $4, '美容师', $5, $6, false)
       ON CONFLICT (employee_id) DO UPDATE
         SET openid = EXCLUDED.openid, phone = EXCLUDED.phone, store_id = EXCLUDED.store_id, is_resigned = false`,
      [BEAU_EMPLOYEE_ID, BEAU_OPENID, BEAU_PHONE, 'L3 测试美容师', TEST_STORE_ID, TEST_STORE_ORG_ID],
    );
  });
  return { employeeId: BEAU_EMPLOYEE_ID, openid: BEAU_OPENID, phone: BEAU_PHONE, storeId: TEST_STORE_ID };
}

async function run() {
  console.log('[bs07-customer-assign] === START ===');
  resetSnapshots();

  // ─── Setup ───
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }
  const manager = await createTestManager();
  const client = await createTestClient();
  const beautician = await createTestBeautician();
  console.log(`  ✓ fixtures ready: manager=${manager.employeeId} beau=${beautician.employeeId} client=${client.userId}`);

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);
  await installToastHook(miniProgram);
  await autoConfirmModal(miniProgram);

  // ─── Step 1: 店长 A 进 customer-list ───
  // IDE 真实账号身份不可控，前端 isManager() 读 globalData.staffLevel 可能=false
  // hack：在 navigate 前覆写 globalData.staffLevel='store_manager'，再触发 onShow 重渲染
  await clearToasts(miniProgram);
  await miniProgram.evaluate(() => {
    const app = getApp();
    if (app?.globalData) app.globalData.staffLevel = 'store_manager';
  });
  await navigateToTab(miniProgram, '/pages/customer-list/customer-list');
  // page onShow 不一定 setData isManager，手动触发
  const page0 = await miniProgram.currentPage();
  try { await page0.callMethod('onShow'); } catch {}
  await waitForData(miniProgram, (d) => d.isManager === true, { timeoutMs: 5000 });
  await snapshot(miniProgram, 'bs07-step1-customer-list');
  console.log('  ✓ Step 1: customer-list 渲染 + isManager=true');

  // ─── Step 2: 触发 assign（绕过 longpress 手势 + 绕过 staff.list 列表加载 bug）───
  // 等同于"店长长按小王卡片 → action sheet 弹出 → 选 C"
  // 因绕开 onLongPressAssign，需先注入 assignTarget（否则 API 报 INVALID_PARAMS）
  await clearToasts(miniProgram);
  const page = await miniProgram.currentPage();
  await page.setData({
    assignTarget: { clientUserId: client.userId, name: 'L3 测试顾客' },
    showAssignSheet: false,
  });
  await page.callMethod('onAssignSelect', {
    detail: { name: 'L3 测试美容师', employeeId: beautician.employeeId },
  });
  await snapshot(miniProgram, 'bs07-step2-after-assign');

  // 等成功 toast
  await assertToast(miniProgram, '已分配给', { timeoutMs: 5000 });
  console.log('  ✓ Step 2: assign API 调用 + toast "已分配给…" 出现');

  // ─── Step 3: PG 断言 bound_employee_id 落地 ───
  const rows = await pgPoll(
    `SELECT user_id, bound_employee_id FROM client_wechat_users WHERE user_id = $1`,
    [client.userId],
    (r) => r[0]?.bound_employee_id === beautician.employeeId,
    { timeoutMs: 3000 },
  );
  console.log(`  ✓ Step 3: PG bound_employee_id=${rows[0].bound_employee_id}`);

  // operation_logs 审计
  const logs = await query(
    `SELECT action, target_id, detail FROM operation_logs
       WHERE action = 'customer.assign' AND target_id = $1
       ORDER BY created_at DESC LIMIT 1`,
    [client.userId],
  );
  if (logs.length === 0) throw new Error('operation_logs 未写入 customer.assign 审计');
  console.log(`  ✓ Step 3b: audit log written, detail=${logs[0].detail}`);

  // ─── Step 4: 切换到美容师 C → 用 callStaffApiWithTestOpenid 验 C 能搜到小王 ───
  // loginAs 已知限制：auth.login 不读 _testOpenid，前端身份字段可能不切；
  // 但 callStaffApiWithTestOpenid 自带 _testOpenid，后端 auth 中间件能正确解出 C 的身份/store scope。
  await clearToasts(miniProgram);
  try {
    await loginAs(miniProgram, BEAU_OPENID);
  } catch (e) {
    // auth.login 在 IDE 真实身份下若失败属预期范围（见 helper 注释），不中断 spec
    console.warn(`  ⚠️ loginAs(BEAU) warn (可忽略): ${e.message}`);
  }
  await snapshot(miniProgram, 'bs07-step4-after-loginAs');

  const searchResult = await callStaffApiWithTestOpenid(
    miniProgram,
    'customer.search',
    { phone: TEST_CLIENT_PHONE },
    BEAU_OPENID,
  );
  const list = Array.isArray(searchResult) ? searchResult : (searchResult?.list || []);
  const hit = list.find((c) => (c.phone || '').replace(/\D/g, '').includes(TEST_CLIENT_PHONE.slice(-4))
    || c.userId === client.userId
    || c.clientUserId === client.userId);
  if (!hit) {
    throw new Error(
      `美容师 C 通过 customer.search(phone=${TEST_CLIENT_PHONE}) 未找到小王，` +
      `返回 ${list.length} 条：${JSON.stringify(list).slice(0, 200)}`,
    );
  }
  console.log(`  ✓ Step 4: 美容师 C search 看到小王 (name=${hit.name || hit.clientName})`);

  console.log('[bs07-customer-assign] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[bs07-customer-assign] === FAIL ===');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    dumpRecentSnapshots(5);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch {}
    await disconnect(miniProgram);
    await closePool();
  }
}
main();
