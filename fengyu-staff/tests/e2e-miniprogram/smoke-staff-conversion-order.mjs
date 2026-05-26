// smoke-staff-conversion-order.mjs — 转换单 ConversionPanel 流程
// 简化：直接 callStaffApiWithTestOpenid('order.createConversion', ...) 验证 IDE 链路

import { launchStaff, disconnect } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid } from './helpers/login.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from './helpers/fixtures.mjs';
import { query, closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER } from './helpers/constants.mjs';

let miniProgram = null;

async function run() {
  console.log('[smoke-staff-conversion-order] === START ===');
  await cleanupL3TestData();
  await createTestManager();
  await createTestClient();

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);

  // 转换单需要源卡（已支付疗程卡），不易在 L3 fixture 构造（需 mall_product_skus）。
  // 这里仅验证 IDE 路径能调到云函数，会因"无折抵卡"业务错误返回 — 视为符合预期。
  try {
    await callStaffApiWithTestOpenid(miniProgram, 'order.createConversion', {
      clientUserId: 'L3_NOT_EXIST', convertOutSaleItemIds: ['NOT_EXIST'],
      convertInItems: [{ skuId: 'NOT_EXIST', quantity: 1 }],
      paymentMethod: '线下',
    });
    throw new Error('应得业务错误，实际成功');
  } catch (e) {
    if (e.message.includes('顾客不存在') || e.message.includes('卡不属于') || e.message.includes('SKU')) {
      console.log('  ✓ 业务错误符合预期:', e.message);
    } else {
      throw e;
    }
  }

  console.log('[smoke-staff-conversion-order] === PASS（链路连通；完整 fixture 需 mall_product_skus 数据，留 TODO）===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) { console.error('=== FAIL ==='); console.error(e.message); process.exit(1); }
  finally { try { await cleanupL3TestData(); } catch {}; await disconnect(miniProgram); await closePool(); }
}
main();
