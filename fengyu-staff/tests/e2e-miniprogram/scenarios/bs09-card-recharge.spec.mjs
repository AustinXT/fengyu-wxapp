// bs09-card-recharge.spec.mjs — BS-09 充值卡开单端到端
//
// 用户故事：店长进 card-recharge 页 → 选 SKU 档位（或自定义金额）→ 提交 → 跳 order-qrcode；
//          顾客侧扫码（本 spec 用 callStaffApiWithTestOpenid 触发 order.confirmOffline 模拟）→
//          PG 校验 sale_orders/sale_items.is_recharge_card + prepaid_cards.balance 入账。
//
// ─── 已知不确定点 / 假设（顶部 5 条）───
// 1. L3 fixtures.mjs 无 product helper（L3 默认复用生产 SKU），本 spec inline INSERT
//    product_categories + product_skus；cleanupL3TestData 不覆盖 product_*，finally 内显式删。
// 2. card.recharge 是独立路由（非 order.create），但仍生成 FY-XSD-WX-{YYMMDD}{4} 单号；
//    fixtures.mjs cleanup 按 client_user_id LIKE 'TEST_E2E_L3_%' 兜底。
// 3. UI 不 tap submit（页面 600ms setTimeout 后 redirectTo qrcode），改为 callStaffApiWithTestOpenid
//    直调 card.recharge 等价于"店长提交"；UI 仅验证导航 + 档位渲染。
// 4. confirmOffline 在 targetStatus='已支付' 时触发 prepaid_cards UPSERT(user_id) +
//    INSERT card_transactions(type='充值'); 用 pgPoll 等异步落库。
// 5. 用真实 ¥500 SKU 档位（最直接路径，RECHARGE_MIN_AMOUNT=500）；自定义金额路径 L2 已覆盖。

import { launchStaff, disconnect, waitForData, assertElementVisible } from '../helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid } from '../helpers/login.mjs';
import { installToastHook, clearToasts, autoConfirmModal } from '../helpers/toast.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { query, pgPoll, tx, closePool } from '../helpers/pg.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from '../helpers/fixtures.mjs';
import {
  TEST_OPENID_MANAGER,
  TEST_CLIENT_USER_ID,
  NAMESPACE,
} from '../helpers/constants.mjs';

// product fixture 命名空间（cleanupL3TestData 不覆盖 product_*，finally 内显式删）
const TEST_RECHARGE_CAT_ID = `${NAMESPACE}CAT_RC`;
const TEST_RECHARGE_SKU_ID = `${NAMESPACE}SKU_RC`;
const RECHARGE_FACE_VALUE = 500;

let miniProgram = null;

async function ensureRechargeSku() {
  // 一级品项 '充值卡' 在生产 seed，本 fixture 直接挂二级分类（SKU 用 is_recharge_card capability 判定）
  await tx(async (c) => {
    await c.query(
      `INSERT INTO product_categories (category_id, category_name, product_kind, sales_category, sort_order, is_valid)
       VALUES ($1, $2, '充值卡', '他销自耗'::sales_category, 0, true)
       ON CONFLICT (category_id) DO UPDATE
         SET product_kind = '充值卡', sales_category = '他销自耗'::sales_category, is_valid = true`,
      [TEST_RECHARGE_CAT_ID, `${NAMESPACE}充值卡品类`],
    );
    await c.query(
      `INSERT INTO product_skus (sku_id, category_id, product_type, spec_name, price,
                                 session_count, sort_order, service_fee, is_shengmei,
                                 is_experience, is_recharge_card, is_enabled)
       VALUES ($1, $2, '单品'::product_type, $3, $4,
               NULL, 0, 0, false,
               false, true, true)
       ON CONFLICT (sku_id) DO UPDATE
         SET category_id = EXCLUDED.category_id, price = EXCLUDED.price,
             is_recharge_card = true, is_enabled = true`,
      [TEST_RECHARGE_SKU_ID, TEST_RECHARGE_CAT_ID, `${NAMESPACE}充值卡500`, RECHARGE_FACE_VALUE],
    );
  });
}

async function cleanupRechargeFixtures() {
  try { await query(`DELETE FROM product_skus WHERE sku_id = $1`, [TEST_RECHARGE_SKU_ID]); } catch (e) {
    console.warn(`[cleanup product_skus] ${e.message}`);
  }
  try { await query(`DELETE FROM product_categories WHERE category_id = $1`, [TEST_RECHARGE_CAT_ID]); } catch (e) {
    console.warn(`[cleanup product_categories] ${e.message}`);
  }
}

async function run() {
  console.log('[bs09-card-recharge] === START ===');
  resetSnapshots();

  // ─── Setup ───
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }
  await cleanupRechargeFixtures();
  const manager = await createTestManager();
  const client = await createTestClient();
  await ensureRechargeSku();
  console.log(`  ✓ fixtures: mgr=${manager.employeeId} client=${client.userId} sku=${TEST_RECHARGE_SKU_ID} ¥${RECHARGE_FACE_VALUE}`);

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
  // 档位区块（生产 + 我们造的 ¥500 至少有 1 个）
  const data1 = await page1.data();
  if (!Array.isArray(data1.tiers) || data1.tiers.length === 0) {
    throw new Error(`card-recharge tiers 为空，rechargeSkus 路由可能未返回我们的 SKU`);
  }
  const targetTier = data1.tiers.find((t) => t.skuId === TEST_RECHARGE_SKU_ID);
  if (!targetTier) {
    throw new Error(`未找到测试 SKU ${TEST_RECHARGE_SKU_ID} 在 tiers（共 ${data1.tiers.length} 个）`);
  }
  console.log(`  ✓ Step 1: card-recharge 页加载 + ${data1.tiers.length} 个档位 + 测试 SKU 命中`);

  // ─── Step 2: 提交开单（绕 UI tap，直调 card.recharge 等价于"店长点 submit"）───
  // card-recharge.ts onSubmit 内部最终走 callStaffApi('card.recharge', payload)，本步等价。
  await clearToasts(miniProgram);
  const rechargeResp = await callStaffApiWithTestOpenid(
    miniProgram,
    'card.recharge',
    {
      clientUserId: client.userId,
      skuId: TEST_RECHARGE_SKU_ID,
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

  // ─── Step 3: PG 校验充值卡 sale_orders + sale_items.is_recharge_card 落地 ───
  const orderRow = await query(
    `SELECT status, total_amount, payment_method, client_user_id
       FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId],
  );
  if (orderRow.length !== 1) throw new Error(`sale_orders 行不存在: ${saleOrderId}`);
  if (orderRow[0].status !== '待支付') {
    throw new Error(`线下充值订单初始 status 应为 '待支付'，实际 '${orderRow[0].status}'`);
  }
  const itemRows = await query(
    `SELECT is_recharge_card, sku_id, sale_amount FROM sale_items WHERE sale_order_id = $1`,
    [saleOrderId],
  );
  if (itemRows.length !== 1) throw new Error(`sale_items 应有 1 行，实际 ${itemRows.length}`);
  if (itemRows[0].is_recharge_card !== true) {
    throw new Error(`sale_items.is_recharge_card 应为 true，实际 ${itemRows[0].is_recharge_card}`);
  }
  if (itemRows[0].sku_id !== TEST_RECHARGE_SKU_ID) {
    throw new Error(`sale_items.sku_id 应为 ${TEST_RECHARGE_SKU_ID}，实际 ${itemRows[0].sku_id}`);
  }
  console.log(`  ✓ Step 3: PG sale_items.is_recharge_card=true + sku 匹配 + status=待确认收款`);

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
    (r) => Number(r[0]?.balance || 0) >= initBalance + RECHARGE_FACE_VALUE,
    { timeoutMs: 5000 },
  );
  const newBalance = Number(cardRows[0].balance);
  const delta = newBalance - initBalance;
  if (Math.abs(delta - RECHARGE_FACE_VALUE) > 0.01) {
    throw new Error(`prepaid_cards.balance 入账差额期望 ${RECHARGE_FACE_VALUE}，实际 ${delta}（init=${initBalance} new=${newBalance}）`);
  }
  const txRows = await query(
    `SELECT type, amount FROM card_transactions
       WHERE ref_order_id = $1 AND type = '充值' LIMIT 1`,
    [saleOrderId],
  );
  if (txRows.length !== 1) {
    throw new Error(`card_transactions 应有 1 条 type='充值' for ${saleOrderId}，实际 ${txRows.length}`);
  }
  if (Math.abs(Number(txRows[0].amount) - RECHARGE_FACE_VALUE) > 0.01) {
    throw new Error(`card_transactions.amount 应为 ${RECHARGE_FACE_VALUE}，实际 ${txRows[0].amount}`);
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
    try { await cleanupRechargeFixtures(); } catch {}
    await disconnect(miniProgram);
    await closePool();
  }
}
main();
