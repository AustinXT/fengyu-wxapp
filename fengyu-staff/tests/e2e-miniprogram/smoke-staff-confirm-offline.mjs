// smoke-staff-confirm-offline.mjs — 员工端 "店长确认线下收款" 端到端
//
// **依赖**：staffApi 云函数环境变量 ALLOW_TEST_OPENID=true（生产环境严禁开启）。
// 未开启时本脚本会在 auth.login 阶段失败并打印明确指引。
//
// 流程：
//   1. PG fixture：造店长 + 顾客 + 待支付(线下)订单
//   2. launch staff miniprogram
//   3. login via _testOpenid
//   4. （方案 A）通过 callStaffApi 直接驱动 order.confirmOffline
//      （方案 B 留作扩展）通过 UI 模拟点击订单列表 → 详情 → 确认收款按钮
//   5. PG 断言：订单状态 '已支付'、received = total_amount
//   6. cleanup fixture
//   7. disconnect

import { launchStaff, disconnect } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid } from './helpers/login.mjs';
import {
  createTestPendingOfflineOrder,
  cleanupL3TestData,
  assertOrderStatus,
} from './helpers/fixtures.mjs';
import { assertReceivedAt, fetchPayments } from './helpers/pg-assert.mjs';
import { closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER } from './helpers/constants.mjs';

let miniProgram = null;
let createdOrderId = null;

async function run() {
  console.log('[smoke-staff-confirm-offline] === START ===');

  console.log('[step 0] 清理上次残留');
  await cleanupL3TestData();

  console.log('[step 1] 造 fixture（店长 + 顾客 + 待支付订单）');
  const fixture = await createTestPendingOfflineOrder({ amount: 188 });
  createdOrderId = fixture.orderId;
  console.log('  fixture =', JSON.stringify({
    orderId: fixture.orderId,
    amount: fixture.amount,
    managerEmployeeId: fixture.manager.employeeId,
  }));

  console.log('[step 2] launch staff miniprogram');
  miniProgram = await launchStaff();
  console.log('  ok');

  console.log('[step 3] login via _testOpenid');
  const loginData = await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);
  console.log('  loginData keys =', Object.keys(loginData || {}).join(','));
  if (!loginData?.roles?.includes('manager')) {
    throw new Error(`登录身份不是店长，roles=${JSON.stringify(loginData?.roles)}`);
  }
  console.log('  ok — 角色为 manager');

  console.log('[step 4] 触发 order.confirmOffline');
  // 方案 A：直接走云函数（最稳定）— UI 点击留作 packageOrder/order-detail 完成后扩展
  const confirmResult = await callStaffApiWithTestOpenid(
    miniProgram,
    'order.confirmOffline',
    { saleOrderId: fixture.orderId },
    TEST_OPENID_MANAGER,
  );
  console.log('  confirmOffline result =', JSON.stringify(confirmResult));

  console.log('[step 5] PG 断言：订单状态 → 已支付');
  const order = await assertOrderStatus(fixture.orderId, '已支付');
  await assertReceivedAt(fixture.orderId, fixture.amount);
  console.log('  ok — status=已支付, received=', order.received);

  console.log('[step 6] PG 断言：sale_order_payments 新增 "首次支付" 行');
  const payments = await fetchPayments(fixture.orderId);
  console.log('  payments =', JSON.stringify(payments));
  const firstPay = payments.find(p => p.change_type === '首次支付' && p.status === '已支付');
  if (!firstPay) {
    throw new Error(`未找到 change_type=首次支付,status=已支付 的 payments 行`);
  }
  if (Math.abs(Number(firstPay.amount) - fixture.amount) > 0.001) {
    throw new Error(`首次支付 amount 期望 ${fixture.amount} 实际 ${firstPay.amount}`);
  }
  console.log('  ok');

  console.log('[smoke-staff-confirm-offline] === PASS ===');
}

async function main() {
  try {
    await run();
    process.exit(0);
  } catch (e) {
    console.error('[smoke-staff-confirm-offline] === FAIL ===');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    try {
      console.log('[cleanup] 删除 L3 命名空间 fixture');
      await cleanupL3TestData();
    } catch (e) {
      console.warn('[cleanup] 警告:', e.message);
    }
    await disconnect(miniProgram);
    await closePool();
  }
}

main();
