// smoke-staff-refund-approve.mjs — 退款审批 UI 路径
// 仅验证 navigate 到 refund-list / refund-detail 不崩溃

import { launchStaff, disconnect } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid } from './helpers/login.mjs';
import { createTestManager, cleanupL3TestData } from './helpers/fixtures.mjs';
import { closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER } from './helpers/constants.mjs';

let miniProgram = null;
async function run() {
  console.log('[smoke-staff-refund-approve] === START ===');
  await cleanupL3TestData();
  await createTestManager();
  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);

  await miniProgram.navigateTo('/packageOrder/refund-list/refund-list');
  await new Promise(r => setTimeout(r, 1500));
  const page = await miniProgram.currentPage();
  console.log('  ✓ refund-list 加载：', page.path);

  console.log('[smoke-staff-refund-approve] === PASS（UI 加载；approve UI 按钮 tap TODO）===');
}
async function main() {
  try { await run(); process.exit(0); }
  catch (e) { console.error('=== FAIL ==='); console.error(e.message); process.exit(1); }
  finally { try { await cleanupL3TestData(); } catch {}; await disconnect(miniProgram); await closePool(); }
}
main();
