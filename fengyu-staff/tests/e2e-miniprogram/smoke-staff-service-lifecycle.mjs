// smoke-staff-service-lifecycle.mjs — 服务单生命周期 UI 导航
//
// ⚠️ 当前 staffApi service.create / service.complete 存在生产 bug（详见 L2 smoke 注释），
//    本 smoke 主要验证 UI 路径上 service 页 Tab 切换 + 列表渲染；
//    完整 start/complete 待 bug 修复后扩展。

import { launchStaff, disconnect, navigateToTab, waitForData } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid } from './helpers/login.mjs';
import { createTestManager, cleanupL3TestData } from './helpers/fixtures.mjs';
import { closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER } from './helpers/constants.mjs';

let miniProgram = null;

async function run() {
  console.log('[smoke-staff-service-lifecycle] === START ===');
  await cleanupL3TestData();
  await createTestManager();

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);

  await navigateToTab(miniProgram, '/pages/service/service');
  const data = await waitForData(miniProgram, (d) =>
    d.services !== undefined || d.serviceList !== undefined || d.list !== undefined,
    { timeoutMs: 8000 }
  );
  console.log('  ✓ service Tab 渲染 keys=', Object.keys(data).slice(0, 8).join(','));

  console.log('[smoke-staff-service-lifecycle] === PASS（UI 渲染阶段；start/complete 待 prod bug 修复后扩展）===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[smoke-staff-service-lifecycle] === FAIL ===');
    console.error(e.message); if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch {}
    await disconnect(miniProgram); await closePool();
  }
}
main();
