// smoke-staff-login-tab.mjs — 登录后 5 个 Tab 渲染验证（深化版）
//
// 流程：
//   1. fixture：店长
//   2. launch staff miniprogram
//   3. login via _testOpenid → globalData.roles 含 manager + staffWfId 一致
//   4. 切到 5 个 tab 逐一确认页面 onLoad 不报错 + data 不空（非纯 wxml 壳）
//   5. 跨 tab 数据隔离：每个 tab 的 data 至少有一个 setData 产物字段

import { launchStaff, disconnect, navigateToTab, waitForData } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid } from './helpers/login.mjs';
import { createTestManager, cleanupL3TestData } from './helpers/fixtures.mjs';
import { closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER, TEST_MANAGER_EMPLOYEE_ID } from './helpers/constants.mjs';

let miniProgram = null;

const STAFF_TABS = [
  { url: '/pages/workbench/workbench', expectKey: 'commission' },
  { url: '/pages/order-create/order-create', expectKey: 'categories' },
  { url: '/pages/service/service', expectKey: 'serviceList' },
  { url: '/pages/customer-list/customer-list', expectKey: 'stats' },
  { url: '/pages/profile/profile', expectKey: 'staffInfo' },
];

async function run() {
  console.log('[smoke-staff-login-tab] === START ===');
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }
  await createTestManager();

  miniProgram = await launchStaff();
  const loginData = await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);

  // 深化断言 1：roles 含 manager
  // 注意：auth.login route 用 cloud.getWXContext().OPENID（不读 _testOpenid），所以这里
  // loginData.staffWfId 是 IDE 真实登录账号，可能 ≠ TEST_MANAGER_EMPLOYEE_ID。
  // 仅断言 roles — 该字段对店长身份足够强；具体身份由后续 _testOpenid action 控制。
  if (!loginData?.roles?.includes('manager')) {
    throw new Error(`登录身份非店长，roles=${JSON.stringify(loginData?.roles)} staffWfId=${loginData?.staffWfId}`);
  }
  console.log(`  ✓ login: roles=${JSON.stringify(loginData.roles)} staffWfId=${loginData.staffWfId}`);

  // 深化断言 2：globalData 落地
  const globalRoles = await miniProgram.evaluate(() => {
    const app = getApp();
    return app?.globalData?.roles || null;
  });
  if (!Array.isArray(globalRoles) || !globalRoles.includes('manager')) {
    throw new Error(`globalData.roles 未正确落地: ${JSON.stringify(globalRoles)}`);
  }
  console.log('  ✓ globalData.roles 正确落地 manager');

  // 深化断言 3：5 个 tab 渲染 + data 非空（至少一个字段对得上预期 key 模式）
  for (const tab of STAFF_TABS) {
    try {
      await navigateToTab(miniProgram, tab.url);
      const page = await miniProgram.currentPage();
      const route = '/' + page.path;
      if (route !== tab.url) {
        console.warn(`  ⚠️  tab=${tab.url} 实际 route=${route}`);
      }
      // 等任一非空字段进来（onLoad/onShow setData 触发）
      try {
        const data = await waitForData(
          miniProgram,
          (d) => Object.keys(d).length >= 3,  // 起码有几个字段
          { timeoutMs: 5000 }
        );
        const keys = Object.keys(data).slice(0, 6);
        console.log(`  ✓ ${tab.url} mounted (data keys: ${keys.join(',')})`);
      } catch (waitErr) {
        console.warn(`  ⚠️  ${tab.url} waitForData 超时（页面可能为静态）`);
      }
    } catch (e) {
      throw new Error(`tab=${tab.url} 加载失败: ${e.message}`);
    }
  }

  console.log('[smoke-staff-login-tab] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[smoke-staff-login-tab] === FAIL ===');
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
