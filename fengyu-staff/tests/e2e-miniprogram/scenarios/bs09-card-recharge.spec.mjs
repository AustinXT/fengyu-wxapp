// bs09-card-recharge.spec.mjs — BS-09 充值卡开单端到端
//
// 用户故事：店长进 card-recharge 页 → 选档位 / 自定义金额 → 提交 → 跳 order-qrcode；
//          顾客侧扫码（本 spec 用 callStaffApiWithTestOpenid 触发 order.confirmOffline 模拟）→
//          PG 校验 sale_orders.sale_order_type='充值单' + prepaid_cards.balance 入账。
//
// 2026-05-21 充值卡剥离 SKU 化后：
//   - 档位/边界完全来自 system_configs.recharge.*，本 spec 不再造 SKU
//   - card.recharge payload 改为 {clientUserId, faceValue, paymentMethod}，无 skuId
//   - sale_items 0 行，类型识别落在 sale_orders.sale_order_type='充值单'

import { launchStaff, disconnect, waitForData, assertElementVisible } from '../helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid } from '../helpers/login.mjs';
import { installToastHook, clearToasts, autoConfirmModal } from '../helpers/toast.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { query, pgPoll, closePool } from '../helpers/pg.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from '../helpers/fixtures.mjs';
import {
  TEST_OPENID_MANAGER,
} from '../helpers/constants.mjs';

let miniProgram = null;

async function run() {
  console.log('[bs09-card-recharge] === START ===');
  resetSnapshots();

  // ─── Setup ───
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }
  const manager = await createTestManager();
  const client = await createTestClient();
  console.log(`  ✓ fixtures: mgr=${manager.employeeId} client=${client.userId}`);

  // 顾客初始 prepaid_cards 余额（pgPoll 前后差值判定，避免历史余额污染）
  const initRows = await query(`SELECT balance FROM prepaid_cards WHERE user_id = $1`, [client.userId]);
  const initBalance = Number(initRows[0]?.balance || 0);
  console.log(`  ✓ initBalance=${initBalance}`);

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);
  await installToastHook(miniProgram);
  await autoConfirmModal(miniProgram);

  // ─── Step 1: navigate 充值卡页 + 验证档位渲染 ───
  await clearToasts(miniProgram);
  await miniProgram.navigateTo(
    `/packageOrder/card-recharge/card-recharge?clientUserId=${client.userId}&customerName=${encodeURIComponent('L3 测试顾客')}&customerPhone=${client.phone}`,
  );
  await waitForData(miniProgram, (d) => d.configLoading === false && Array.isArray(d.tiers), { timeoutMs: 8000 });
  await snapshot(miniProgram, 'bs09-step1-card-recharge-loaded');
  const page1 = await miniProgram.currentPage();
  await assertElementVisible(page1, { text: '为顾客充值' });
  // 档位区块由 system_configs.recharge.tiers 驱动（dev seed 至少 3 档）
  const data1 = await page1.data();
  if (!Array.isArray(data1.tiers) || data1.tiers.length === 0) {
    throw new Error(`card-recharge tiers 为空（system_configs.recharge.tiers 未配置？）`);
  }
  const targetTier = data1.tiers[0];
  const rechargeFaceValue = targetTier.faceValue;
  console.log(`  ✓ Step 1: card-recharge 页加载 + ${data1.tiers.length} 个档位 + 首档 face=¥${rechargeFaceValue} pay=¥${targetTier.payAmount}`);

  // ─── Step 2: 提交开单（绕 UI tap，直调 card.recharge 等价于"店长点 submit"）───
  await clearToasts(miniProgram);
  const rechargeResp = await callStaffApiWithTestOpenid(
    miniProgram,
    'card.recharge',
    {
      clientUserId: client.userId,
      faceValue: rechargeFaceValue,
      paymentMethod: '线下',
    },
    TEST_OPENID_MANAGER,
  );
  if (!rechargeResp?.saleOrderId || !/^FY-XSD-WX-/.test(rechargeResp.saleOrderId)) {
    throw new Error(`card.recharge 返回 saleOrderId 格式异常: ${JSON.stringify(rechargeResp)}`);
  }
  const saleOrderId = rechargeResp.saleOrderId;
  await snapshot(miniProgram, 'bs09-step2-after-recharge-create');
  console.log(`  ✓ Step 2: card.recharge OK saleOrderId=${saleOrderId} payAmount=${rechargeResp.payAmount}`);

  // ─── Step 3: PG 校验 sale_orders type='充值单' + 0 sale_items ───
  const orderRow = await query(
    `SELECT status, total_amount, sale_order_type, client_user_id
       FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId],
  );
  if (orderRow.length !== 1) throw new Error(`sale_orders 行不存在: ${saleOrderId}`);
  if (orderRow[0].status !== '待支付') {
    throw new Error(`线下充值订单初始 status 应为 '待支付'，实际 '${orderRow[0].status}'`);
  }
  if (orderRow[0].sale_order_type !== '充值单') {
    throw new Error(`sale_orders.sale_order_type 应为 '充值单'，实际 '${orderRow[0].sale_order_type}'`);
  }
  if (Math.abs(Number(orderRow[0].total_amount) - rechargeFaceValue) > 0.01) {
    throw new Error(`sale_orders.total_amount 应为面值 ${rechargeFaceValue}，实际 ${orderRow[0].total_amount}`);
  }
  const itemRows = await query(`SELECT count(*) AS c FROM sale_items WHERE sale_order_id = $1`, [saleOrderId]);
  if (Number(itemRows[0].c) !== 0) {
    throw new Error(`充值订单 sale_items 应为 0 行（剥离 SKU 化），实际 ${itemRows[0].c}`);
  }
  console.log(`  ✓ Step 3: sale_orders.type='充值单' total=¥${rechargeFaceValue} + 0 sale_items`);

  // ─── Step 4: 模拟顾客付款 → 触发 confirmOffline → 充值入账 ───
  await clearToasts(miniProgram);
  const confirmResp = await callStaffApiWithTestOpenid(
    miniProgram,
    'order.confirmOffline',
    { saleOrderId },
    TEST_OPENID_MANAGER,
  );
  await snapshot(miniProgram, 'bs09-step4-after-confirm-offline');
  console.log(`  ✓ Step 4: order.confirmOffline OK ${JSON.stringify(confirmResp).slice(0, 80)}`);

  // ─── Step 5: PG 校验 prepaid_cards.balance += faceValue + card_transactions(type='充值') ───
  const cardRows = await pgPoll(
    `SELECT card_id, balance FROM prepaid_cards WHERE user_id = $1`,
    [client.userId],
    (r) => Number(r[0]?.balance || 0) >= initBalance + rechargeFaceValue,
    { timeoutMs: 5000 },
  );
  const newBalance = Number(cardRows[0].balance);
  const delta = newBalance - initBalance;
  if (Math.abs(delta - rechargeFaceValue) > 0.01) {
    throw new Error(`prepaid_cards.balance 入账差额期望 ${rechargeFaceValue}，实际 ${delta}（init=${initBalance} new=${newBalance}）`);
  }
  const txRows = await query(
    `SELECT type, amount FROM card_transactions
       WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
    [saleOrderId],
  );
  if (txRows.length !== 1) {
    throw new Error(`card_transactions 应有 1 条 type='充值' for ${saleOrderId}，实际 ${txRows.length}`);
  }
  if (Math.abs(Number(txRows[0].amount) - rechargeFaceValue) > 0.01) {
    throw new Error(`card_transactions.amount 应为 ${rechargeFaceValue}，实际 ${txRows[0].amount}`);
  }
  console.log(`  ✓ Step 5: prepaid_cards.balance ${initBalance} → ${newBalance} (+${delta}) + card_transactions 充值流水落地`);

  // 订单终态校验
  const finalOrder = await query(`SELECT status FROM sale_orders WHERE sale_order_id = $1`, [saleOrderId]);
  if (finalOrder[0].status !== '已支付') {
    throw new Error(`confirmOffline 后 sale_orders.status 应为 '已支付'，实际 '${finalOrder[0].status}'`);
  }
  console.log(`  ✓ 终态: sale_orders.status='已支付'`);

  console.log('[bs09-card-recharge] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[bs09-card-recharge] === FAIL ===');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    dumpRecentSnapshots(5);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch {}
    await disconnect(miniProgram);
    await closePool();
  }
}
main();
