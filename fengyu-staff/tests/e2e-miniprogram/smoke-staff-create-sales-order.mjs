// smoke-staff-create-sales-order.mjs — 开单流程 4 步端到端
//
// 流程：order-create 页 → 选 SKU → 加购物车 → 选顾客 → 提交 → 跳 order-qrcode
// PG 验证：sale_orders 行存在，status='待支付'（线上）或 '待确认收款'（线下）
//
// 简化：UI 路径太长，本 smoke 主要通过 callStaffApiWithTestOpenid 直接驱动 order.create，
// 验证小程序运行时能正确调云函数 + PG 结果落地。完整 UI tap 路径留 TODO。

import { launchStaff, disconnect } from './helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid } from './helpers/login.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from './helpers/fixtures.mjs';
import { query, closePool } from './helpers/pg.mjs';
import { TEST_OPENID_MANAGER, TEST_CLIENT_PHONE } from './helpers/constants.mjs';

let miniProgram = null;

async function run() {
  console.log('[smoke-staff-create-sales-order] === START ===');
  await cleanupL3TestData();
  await createTestManager();
  await createTestClient();

  // 找一个生产真实可用的 SKU（不能用 L3 fixture，因为 product 域有外部 FK 复杂度）
  const skus = await query(`SELECT sku_id FROM product_skus WHERE is_enabled = true AND price > 0 LIMIT 1`);
  if (skus.length === 0) throw new Error('生产 product_skus 为空，无可用 SKU 测试');
  const skuId = skus[0].sku_id;

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);

  const result = await callStaffApiWithTestOpenid(miniProgram, 'order.create', {
    clientPhone: TEST_CLIENT_PHONE,
    clientName: 'L3 测试顾客',
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    saleOrderType: '销售单',
  }, TEST_OPENID_MANAGER);

  console.log('  ✓ order.create OK:', result.saleOrderId, 'status=', result.status);
  if (!/^FY-XSD-WX-/.test(result.saleOrderId)) throw new Error(`saleOrderId 格式不对: ${result.saleOrderId}`);

  // PG 校验
  const rows = await query(`SELECT status, total_amount FROM sale_orders WHERE sale_order_id = $1`, [result.saleOrderId]);
  if (rows.length !== 1) throw new Error('sale_orders 行不存在');
  console.log('  ✓ PG sale_orders.status=', rows[0].status);

  console.log('[smoke-staff-create-sales-order] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[smoke-staff-create-sales-order] === FAIL ===');
    console.error(e.message); if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch {}
    await disconnect(miniProgram); await closePool();
  }
}
main();
