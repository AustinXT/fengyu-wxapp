// smoke-staff-allocation-save.mjs — 提成分配 UI 路径
// 仅验证 navigate 到 allocation-list / revenue-allocation 不崩溃

import { launchStaff, disconnect, navigateToPage } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid } from './helpers/login.mjs';
import { createTestManager, cleanupL3TestData } from './helpers/fixtures.mjs';
import { closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER } from './helpers/constants.mjs';

let miniProgram = null;
async function run() {
  console.log('[smoke-staff-allocation-save] === START ===');
  await cleanupL3TestData();
  await createTestManager();
  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);

  await navigateToPage(miniProgram, '/packageOrder/allocation-list/allocation-list');
  await new Promise(r => setTimeout(r, 1500));
  const page = await miniProgram.currentPage();
  console.log('  ✓ allocation-list 加载：', page.path);

  console.log('[smoke-staff-allocation-save] === PASS（UI 加载；save UI 路径 TODO）===');
}
async function main() {
  try { await run(); process.exit(0); }
  catch (e) { console.error('=== FAIL ==='); console.error(e.message); process.exit(1); }
  finally { try { await cleanupL3TestData(); } catch {}; await disconnect(miniProgram); await closePool(); }
}
main();
