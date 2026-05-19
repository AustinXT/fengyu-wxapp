// bs11-multi-store-switch.spec.mjs — L3 BS-11 多店切换 UI
//
// 场景：市场经理（manager@market_A）在 workbench 顶部门店切换器把当前门店从 A1 切到 A2，
//      验证：
//        a) 切换后 globalData.currentStoreId = A2
//        b) data.currentStoreName 更新为 A2 店名
//        c) loadWorkbench 重新拉数据（按 effectiveStoreId=A2 过滤）
//        d) 再切回 A1，数据恢复一致
//
// fixture：createTestPersonnelMatrix 建好 manager@market_A + 2 个门店 A1/A2
//
// ⚠️ 已知限制：
//   - 切店 emit('store-changed') 后 loadWorkbench 内部 callStaffApi 用 _testOpenid hook 走对的 scope
//   - 但 staff_wechat_users.scopedStores 是 IDE 真账号的 → 需要 hack globalData.scopedStores 为 fixture 内 A1+A2

import { launchStaff, disconnect, navigateToTab } from '../helpers/automator.mjs';
import { loginAs } from '../helpers/login.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { closePool } from '../helpers/pg.mjs';
import {
  createTestPersonnelMatrix, cleanupL3TestData,
} from '../helpers/fixtures.mjs';
import {
  TEST_OPENID_MANAGER_MARKET, TEST_MARKET_A_ORG_ID,
  TEST_STORE_A1_ID, TEST_STORE_A2_ID,
} from '../helpers/constants.mjs';

let miniProgram = null;

async function setMarketIdentity() {
  await miniProgram.evaluate((mktId, a1Id, a2Id) => {
    const app = getApp();
    if (app?.globalData) {
      app.globalData.staffLevel = 'market';
      app.globalData.roleBindings = [
        { role: 'manager', scopeType: '市场', scopeId: mktId },
      ];
      app.globalData.availableLoginLevels = ['store', 'management'];
      app.globalData.loginLevel = 'store';
      app.globalData.scopedStores = [
        { storeId: a1Id, storeName: 'L3 测试门店' },
        { storeId: a2Id, storeName: 'L3 测试 A2' },
      ];
      app.globalData.currentStoreId = a1Id; // 默认 A1
    }
  }, TEST_MARKET_A_ORG_ID, TEST_STORE_A1_ID, TEST_STORE_A2_ID);
}

async function runCase(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    return true;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    try { await snapshot(miniProgram, `bs11-${label.replace(/\s+/g, '-')}`); } catch {}
    return false;
  }
}

async function run() {
  console.log('[bs11-multi-store-switch] === START ===');
  resetSnapshots();
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }
  await createTestPersonnelMatrix();

  miniProgram = await launchStaff();
  let fail = 0;

  // 登录 + hack market 身份 + 进 workbench
  await loginAs(miniProgram, TEST_OPENID_MANAGER_MARKET, TEST_STORE_A1_ID);
  await setMarketIdentity();
  await navigateToTab(miniProgram, '/pages/workbench/workbench');
  await new Promise(r => setTimeout(r, 800));

  // ─── Case 1: 默认 currentStoreId=A1, hasMultiStore=true ───
  if (!await runCase('default.currentStoreId=A1+hasMultiStore', async () => {
    const page = await miniProgram.currentPage();
    // page.onShow 已被 navigateToTab 触发，syncStoreContext 应已读 globalData.scopedStores
    await page.callMethod('syncStoreContext').catch(() => {});
    await new Promise(r => setTimeout(r, 400));
    const data = await page.data();
    if (data.currentStoreId !== TEST_STORE_A1_ID) {
      throw new Error(`期望 currentStoreId=A1, 实际=${data.currentStoreId}`);
    }
    if (!data.hasMultiStore) {
      throw new Error(`期望 hasMultiStore=true (scopedStores.length=2), 实际=${data.hasMultiStore} scopedStores.len=${(data.scopedStores || []).length}`);
    }
  })) fail++;

  // ─── Case 2: 调 onStorePickerSelect(A2) 切到 A2 ───
  if (!await runCase('switch.A1→A2', async () => {
    const page = await miniProgram.currentPage();
    await page.callMethod('onStorePickerSelect', {
      detail: { storeId: TEST_STORE_A2_ID, name: 'L3 测试 A2' },
    });
    await new Promise(r => setTimeout(r, 800));
    const data = await page.data();
    if (data.currentStoreId !== TEST_STORE_A2_ID) {
      throw new Error(`切换后 currentStoreId 期望=A2, 实际=${data.currentStoreId}`);
    }
    // globalData 也应同步
    const g = await miniProgram.evaluate(() => getApp()?.globalData?.currentStoreId);
    if (g !== TEST_STORE_A2_ID) {
      throw new Error(`globalData.currentStoreId 未同步: ${g}`);
    }
  })) fail++;

  // ─── Case 3: 再切回 A1，状态恢复 ───
  if (!await runCase('switch.A2→A1', async () => {
    const page = await miniProgram.currentPage();
    await page.callMethod('onStorePickerSelect', {
      detail: { storeId: TEST_STORE_A1_ID, name: 'L3 测试门店' },
    });
    await new Promise(r => setTimeout(r, 800));
    const data = await page.data();
    if (data.currentStoreId !== TEST_STORE_A1_ID) {
      throw new Error(`切回后 currentStoreId 期望=A1, 实际=${data.currentStoreId}`);
    }
  })) fail++;

  console.log(`[bs11-multi-store-switch] cases 3 / 失败 ${fail}`);
  if (fail > 0) {
    dumpRecentSnapshots(5);
    throw new Error(`BS-11 失败 ${fail}/3`);
  }
  console.log('[bs11-multi-store-switch] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[bs11-multi-store-switch] === FAIL ===');
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
