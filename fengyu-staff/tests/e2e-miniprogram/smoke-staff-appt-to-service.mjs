// smoke-staff-appt-to-service.mjs — 预约 → 确认 → checkin → service-create 串联
// 仅验证 UI 路径：navigate 到 packageService/appointment 页加载成功

import { launchStaff, disconnect } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid } from './helpers/login.mjs';
import { createTestManager, cleanupL3TestData } from './helpers/fixtures.mjs';
import { closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER } from './helpers/constants.mjs';

let miniProgram = null;
async function run() {
  console.log('[smoke-staff-appt-to-service] === START ===');
  await cleanupL3TestData();
  await createTestManager();
  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);

  await miniProgram.navigateTo('/packageService/appointment/appointment');
  await new Promise(r => setTimeout(r, 1500));
  const page = await miniProgram.currentPage();
  console.log('  ✓ appointment 页面加载：', page.path);

  console.log('[smoke-staff-appt-to-service] === PASS（UI 加载阶段；confirm/checkin/service-create 串联 TODO）===');
}
async function main() {
  try { await run(); process.exit(0); }
  catch (e) { console.error('=== FAIL ==='); console.error(e.message); process.exit(1); }
  finally { try { await cleanupL3TestData(); } catch {}; await disconnect(miniProgram); await closePool(); }
}
main();
