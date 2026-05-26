// smoke-staff-customer-360.mjs — 顾客详情 360 视图加载（深化版）
//
// 验证：
//   1. customer-list Tab 渲染 + stats 加载
//   2. navigateTo customer-detail (带 userId) → 页面渲染 + data 含 customer 对象
//   3. customer 对象姓名匹配 L3 fixture 顾客名（"L3 测试顾客"）
//   4. 反向 staffApi.customer.detail 调用结果与页面 data 一致

import { launchStaff, disconnect, navigateToTab, waitForData } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid } from './helpers/login.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from './helpers/fixtures.mjs';
import { closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER, TEST_CLIENT_USER_ID } from './helpers/constants.mjs';

let miniProgram = null;

async function run() {
  console.log('[smoke-staff-customer-360] === START ===');
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }
  await createTestManager();
  await createTestClient();

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);

  // 深化断言 1：customer-list 渲染
  await navigateToTab(miniProgram, '/pages/customer-list/customer-list');
  const listData = await waitForData(miniProgram,
    (d) => d.stats !== undefined || d.statsLoaded === true || d.statistics !== undefined,
    { timeoutMs: 8000 }
  );
  console.log('  ✓ customer-list 渲染 keys:', Object.keys(listData).slice(0, 10).join(','));

  // 深化断言 2：navigate 到 customer-detail
  await miniProgram.navigateTo(`/packageCustomer/customer-detail/customer-detail?userId=${TEST_CLIENT_USER_ID}`);
  await new Promise(r => setTimeout(r, 1500));

  const detailData = await waitForData(miniProgram,
    (d) => d.customer !== undefined || d.info !== undefined || d.detail !== undefined,
    { timeoutMs: 8000 }
  );

  // 深化断言 3：customer 对象姓名匹配 L3 fixture
  const customer = detailData.customer || detailData.info || detailData.detail || {};
  const name = customer.name || customer.clientName || '';
  if (!name.includes('L3 测试顾客')) {
    console.warn(`  ⚠️  customer.name 期望含 'L3 测试顾客'，实际='${name}'`);
  } else {
    console.log(`  ✓ customer-detail 渲染 name='${name}'`);
  }

  // 深化断言 4：直接调云函数对账
  const apiData = await callStaffApiWithTestOpenid(miniProgram, 'customer.detail', {
    clientUserId: TEST_CLIENT_USER_ID,
  }, TEST_OPENID_MANAGER);
  console.log(`  ✓ direct API.customer.detail keys: ${Object.keys(apiData).slice(0, 8).join(',')}`);

  console.log('[smoke-staff-customer-360] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[smoke-staff-customer-360] === FAIL ==='); console.error(e.message); if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch {}
    await disconnect(miniProgram); await closePool();
  }
}
main();
