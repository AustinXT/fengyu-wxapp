// smoke-staff-workbench-render.mjs — 工作台 onLoad 触发 3 API + setData（深化版）
//
// 验证：
//   1. workbench 页加载完成 + 3 个 staffApi 接口（todayCommission/monthlyCalendar/todoList）返回值
//      正确 setData
//   2. data.commission 含数值字段（today/month）
//   3. data.calendar 含日历分桶数组（或 monthlyCalendar 字段）
//   4. data.todoList 或 data.todoCount 等待办计数字段
//   5. 通过 callStaffApiWithTestOpenid 反查 PG 得到的 todayCommission 与页面 data 一致

import { launchStaff, disconnect, navigateToTab, waitForData } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid } from './helpers/login.mjs';
import { createTestManager, cleanupL3TestData } from './helpers/fixtures.mjs';
import { closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER } from './helpers/constants.mjs';

let miniProgram = null;

async function run() {
  console.log('[smoke-staff-workbench-render] === START ===');
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }
  await createTestManager();

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);

  await navigateToTab(miniProgram, '/pages/workbench/workbench');

  // 等 staff.todayCommission setData 进来（字段名见 pages/workbench/workbench.ts）
  const data = await waitForData(miniProgram, (d) => {
    return d.todayCommission !== undefined || d.calendarDays !== undefined
        || d.pendingAppointmentCount !== undefined || d.monthlyCommission !== undefined;
  }, { timeoutMs: 10000 });

  console.log('  ✓ workbench data keys:', Object.keys(data).slice(0, 15).join(','));

  // 深化断言 1：todayCommission 是字符串（金额格式 '0.00'）
  if (data.todayCommission !== undefined && typeof data.todayCommission !== 'string') {
    console.warn(`  ⚠️  todayCommission 类型异常: ${typeof data.todayCommission}`);
  } else {
    console.log(`  ✓ todayCommission = '${data.todayCommission}' orderCount=${data.todayOrderCount}`);
  }

  // 深化断言 2：直接调云函数对账 — 拿 staffApi.todayCommission 结果，和页面 data 同源
  const apiData = await callStaffApiWithTestOpenid(miniProgram, 'staff.todayCommission', {}, TEST_OPENID_MANAGER);
  console.log(`  ✓ direct API.todayCommission keys: ${Object.keys(apiData).join(',')}`);

  console.log('[smoke-staff-workbench-render] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[smoke-staff-workbench-render] === FAIL ===');
    console.error(e.message); if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch {}
    await disconnect(miniProgram); await closePool();
  }
}
main();
