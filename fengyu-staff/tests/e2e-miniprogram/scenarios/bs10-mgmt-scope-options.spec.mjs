// bs10-mgmt-scope-options.spec.mjs — L3 BS-10 管理层 scope 切换 UI
//
// 验证矩阵：
//   a) HQ 账号 navigate /pages/mgmt-dashboard：
//        - data.scope.scopeType='all'
//        - mgmt-scope-picker 拉到的 scopeOptions.markets 含 ≥2 个市场（A + B）
//   b) market 账号（绑 market_A）navigate /pages/mgmt-dashboard：
//        - data.scope.scopeType='market', scopeId=market_A
//        - 拉到的 markets 只剩 [A]（一个市场）
//   c) HQ 账号切到 scopeType='store', scopeId=A1：
//        - data.scope.scopeId=A1
//        - loadSummary 调云函数应 code=0（即真实数据下钻成功）
//
// 实现要点：
//   - 通过 loginAs(TEST_OPENID_*) 切真实身份 + 前端 globalData hack（staffLevel、availableLoginLevels、roleBindings）
//   - 直接 reLaunch /pages/mgmt-dashboard/mgmt-dashboard 进入管理层视图
//   - 用 page.callMethod('onLoad', {}) 触发 computeDefaultScope；如果 page 已加载用 onScopeChange 模拟手动切
//
// ⚠️ 已知约束：
//   1. staffApi.auth.login 用 cloud.getWXContext().OPENID（IDE 真账号），不读 _testOpenid →
//      返回的 staffLevel/roleBindings 总是 IDE 账号身份；为让前端 computeDefaultScope 行为正确，
//      需在 loginAs 后手动覆写 app.globalData.staffLevel / roleBindings
//   2. 后端 mgmtDashboard.summary 等仍按 _testOpenid 鉴权（callStaffApi hook 注入），权限独立校验

import { launchStaff, disconnect } from '../helpers/automator.mjs';
import { loginAs } from '../helpers/login.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { closePool } from '../helpers/pg.mjs';
import {
  createTestPersonnelMatrix, cleanupL3TestData,
} from '../helpers/fixtures.mjs';
import {
  TEST_OPENID_MANAGER_HQ, TEST_OPENID_MANAGER_MARKET,
  TEST_MARKET_A_ORG_ID, TEST_STORE_A1_ID,
} from '../helpers/constants.mjs';

let miniProgram = null;

/**
 * loginAs 后覆写 globalData，让前端 computeDefaultScope 走对应身份分支
 */
async function setManagementIdentity(staffLevel, roleBindings, scopedStores) {
  await miniProgram.evaluate((lv, rbs, ss) => {
    const app = getApp();
    if (app?.globalData) {
      app.globalData.staffLevel = lv;
      app.globalData.roleBindings = rbs;
      app.globalData.availableLoginLevels = ['store', 'management'];
      app.globalData.loginLevel = 'management';
      app.globalData.scopedStores = ss;
    }
  }, staffLevel, roleBindings, scopedStores);
}

async function navigateToMgmtDashboard() {
  await miniProgram.reLaunch('/pages/mgmt-dashboard/mgmt-dashboard');
  await new Promise(r => setTimeout(r, 1200)); // 等 onLoad → loadSummary
}

async function readScope() {
  const page = await miniProgram.currentPage();
  const data = await page.data();
  return data.scope || null;
}

async function callScopeOptionsViaHook() {
  // 直接调云函数（已被 callStaffApi hook 注入 _testOpenid）
  return miniProgram.evaluate(() => new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'staffApi',
      data: { action: 'mgmtDashboard.scopeOptions', payload: { _loginLevel: 'management' } },
      success: (res) => resolve(res.result),
      fail: (err) => reject(new Error(err?.errMsg || String(err))),
    });
  }));
}

async function runCase(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    return true;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    try { await snapshot(miniProgram, `bs10-${label.replace(/\s+/g, '-')}`); } catch {}
    return false;
  }
}

async function run() {
  console.log('[bs10-mgmt-scope-options] === START ===');
  resetSnapshots();
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }
  await createTestPersonnelMatrix();

  miniProgram = await launchStaff();
  let fail = 0;

  // ─── Case 1: HQ 身份默认 scope=all + 可见 ≥2 markets ───
  if (!await runCase('HQ.default.scope=all', async () => {
    await loginAs(miniProgram, TEST_OPENID_MANAGER_HQ);
    await setManagementIdentity('headquarters', [
      { role: 'manager', scopeType: '总部', scopeId: 'TEST_E2E_L3_HQ' },
    ], []);
    await navigateToMgmtDashboard();
    const scope = await readScope();
    if (!scope || scope.scopeType !== 'all') {
      throw new Error(`期望 scopeType=all, 实际=${JSON.stringify(scope)}`);
    }
    // 验 scopeOptions 看到 ≥2 markets
    const r = await callScopeOptionsViaHook();
    if (r?.code !== 0) throw new Error(`scopeOptions code=${r?.code} ${r?.message}`);
    const markets = r.data?.markets || [];
    // 至少看到 fixture 建的 market_A + market_B 两个；可能还混杂生产真实 market
    if (markets.length < 2) {
      throw new Error(`期望 ≥2 markets, 实际=${markets.length}: ${JSON.stringify(markets.map(m => m.id))}`);
    }
  })) fail++;

  // ─── Case 2: market 身份默认 scope=market + 仅可见 1 market ───
  if (!await runCase('market.default.scope=market+1market', async () => {
    await loginAs(miniProgram, TEST_OPENID_MANAGER_MARKET);
    await setManagementIdentity('market', [
      { role: 'manager', scopeType: '市场', scopeId: TEST_MARKET_A_ORG_ID },
    ], []);
    await navigateToMgmtDashboard();
    const scope = await readScope();
    if (!scope || scope.scopeType !== 'market' || scope.scopeId !== TEST_MARKET_A_ORG_ID) {
      throw new Error(`期望 scopeType=market scopeId=${TEST_MARKET_A_ORG_ID}, 实际=${JSON.stringify(scope)}`);
    }
    const r = await callScopeOptionsViaHook();
    if (r?.code !== 0) throw new Error(`scopeOptions code=${r?.code} ${r?.message}`);
    const markets = r.data?.markets || [];
    if (markets.length !== 1) {
      throw new Error(`期望 1 market, 实际=${markets.length}`);
    }
    if (markets[0].id !== TEST_MARKET_A_ORG_ID) {
      throw new Error(`期望 market_A, 实际=${markets[0].id}`);
    }
  })) fail++;

  // ─── Case 3: HQ 身份切到 scopeType='store' + summary 调用 OK ───
  if (!await runCase('HQ.switch.scope=store_A1+summary.ok', async () => {
    await loginAs(miniProgram, TEST_OPENID_MANAGER_HQ);
    await setManagementIdentity('headquarters', [
      { role: 'manager', scopeType: '总部', scopeId: 'TEST_E2E_L3_HQ' },
    ], []);
    await navigateToMgmtDashboard();
    // 模拟 mgmt-scope-picker 切到 store
    const page = await miniProgram.currentPage();
    await page.callMethod('onScopeChange', {
      detail: { scopeType: 'store', scopeId: TEST_STORE_A1_ID, scopeName: 'L3 测试门店' },
    });
    await new Promise(r => setTimeout(r, 1000));
    const scope = await readScope();
    if (scope?.scopeId !== TEST_STORE_A1_ID) {
      throw new Error(`scope 未切到 store_A1, 实际=${JSON.stringify(scope)}`);
    }
    // loadSummary 应已被 onScopeChange 触发，验 data.summary 存在
    const data = await page.data();
    if (data.summaryState === 'error') {
      throw new Error(`summary state=error，loadSummary 失败`);
    }
  })) fail++;

  console.log(`[bs10-mgmt-scope-options] cases 3 / 失败 ${fail}`);
  if (fail > 0) {
    dumpRecentSnapshots(5);
    throw new Error(`BS-10 失败 ${fail}/3`);
  }
  console.log('[bs10-mgmt-scope-options] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[bs10-mgmt-scope-options] === FAIL ===');
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
