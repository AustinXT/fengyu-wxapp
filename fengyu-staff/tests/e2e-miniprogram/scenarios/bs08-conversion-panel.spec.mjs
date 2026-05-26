// scenarios/bs08-conversion-panel.spec.mjs — BS-08 转换单 ConversionPanel UI
// 设计文档：BUSINESS-SCENARIOS-DESIGN.md §5 BS-08
//
// 顶部不确定点（先评估再扩展）：
//   1. ConversionPanel 是深嵌子组件，automator selector 不可靠；本 spec 走"UI 验证页面可达
//      + 业务通过云函数直调驱动"的降级路径（BS-08 设计明确允许）。
//   2. "转换单"入口在结算 Step 2 的 order-type-cards 卡片里，不是顶部商品类型 4 选 1。
//   3. ConversionPanel 内部由 observer(clientUserId) 触发 customerHeldCards，本 spec
//      用 callStaffApi('order.customerHeldCards') 直接验证 panel 数据源。
//   4. L3 cleanup 不覆盖 product_skus / product_categories，需 finally 显式清理。
//   5. 源销售单走 PG 直插（status='已支付' + remaining_sessions=5 + product_type='疗程卡'
//      + store_id=manager.storeId），避免 order.create + confirmOffline 多余链路。

import { launchStaff, disconnect, waitForData } from '../helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid } from '../helpers/login.mjs';
import { installToastHook, clearToasts, autoConfirmModal } from '../helpers/toast.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { query, pgPoll, closePool } from '../helpers/pg.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from '../helpers/fixtures.mjs';
import { TEST_OPENID_MANAGER, TEST_CLIENT_PHONE, NAMESPACE } from '../helpers/constants.mjs';

const SCENARIO = 'bs08-conversion-panel';
const NS = NAMESPACE;
const SRC_CAT_ID = `${NS}P_CAT_CONV_SRC`;
const SRC_SKU_ID = `${NS}P_SKU_CONV_SRC`;
const TGT_CAT_ID = `${NS}P_CAT_CONV_TGT`;
const TGT_SKU_ID = `${NS}P_SKU_CONV_TGT`;
const SOURCE_ORDER_ID = `${NS}ORD_CONV_SRC`;
const SOURCE_ITEM_ID = `${NS}ITM_CONV_SRC`;

let miniProgram = null;

async function ensureProductFixture() {
  for (const [catId, name] of [[SRC_CAT_ID, 'L3 转换源卡品类'], [TGT_CAT_ID, 'L3 转换目标品类']]) {
    await query(
      `INSERT INTO product_categories (category_id, category_name, product_kind, sales_category, sort_order, is_valid)
       VALUES ($1, $2, '护理项目', '他销他耗'::sales_category, 0, true)
       ON CONFLICT (category_id) DO UPDATE SET is_valid = true`,
      [catId, name],
    );
  }
  await query(
    `INSERT INTO product_skus (sku_id, category_id, product_type, spec_name, price,
                               session_count, sort_order, service_fee, is_shengmei,
                               is_experience, is_enabled)
     VALUES ($1, $2, '疗程卡'::product_type, 'L3 源卡 5x500', 500,
             5, 0, 0, true, false, true)
     ON CONFLICT (sku_id) DO UPDATE SET is_enabled = true, price = EXCLUDED.price,
       session_count = EXCLUDED.session_count`,
    [SRC_SKU_ID, SRC_CAT_ID],
  );
  await query(
    `INSERT INTO product_skus (sku_id, category_id, product_type, spec_name, price,
                               session_count, sort_order, service_fee, is_shengmei,
                               is_experience, is_enabled)
     VALUES ($1, $2, '疗程卡'::product_type, 'L3 目标项目 ¥200', 200,
             1, 0, 0, true, false, true)
     ON CONFLICT (sku_id) DO UPDATE SET is_enabled = true, price = EXCLUDED.price`,
    [TGT_SKU_ID, TGT_CAT_ID],
  );
}

async function ensureSourceSaleOrder({ storeId, clientUserId, managerEmpId }) {
  await query(
    `INSERT INTO sale_orders (
       sale_order_id, status, sale_order_type, market_name, store_id,
       sale_order_datetime, client_user_id, client_phone, customer_name,
       total_amount, prepaid_card_amount, payable_amount, received,
       payment_method, opened_by, allocation_status, paid_at)
     VALUES ($1, '已支付'::order_status, '销售单'::sale_order_type, 'L3 测试市场', $2,
             NOW(), $3, $4, 'L3 测试顾客',
             500, 0, 500, 500,
             '线下'::payment_method, $5, '待分配'::allocation_status, NOW())
     ON CONFLICT (sale_order_id) DO NOTHING`,
    [SOURCE_ORDER_ID, storeId, clientUserId, TEST_CLIENT_PHONE, managerEmpId],
  );
  await query(
    `INSERT INTO sale_items (
       sale_item_id, sale_order_id, store_id, item_direction, sku_id,
       product_name, sku_spec_name, product_type,
       session_count, remaining_sessions,
       unit_price, quantity, unit_real_price, sale_amount, received,
       sales_category, is_shengmei, is_experience)
     VALUES ($1, $2, $3, '购买'::item_direction, $4,
             'L3 源卡 5x500', 'L3 源卡 5x500', '疗程卡'::product_type,
             5, 5,
             500, 1, 500, 500, 500,
             '他销他耗'::sales_category, true, false)
     ON CONFLICT (sale_item_id) DO NOTHING`,
    [SOURCE_ITEM_ID, SOURCE_ORDER_ID, storeId, SRC_SKU_ID],
  );
}

async function cleanupProductFixture() {
  try { await query(`DELETE FROM product_skus WHERE sku_id IN ($1, $2)`, [SRC_SKU_ID, TGT_SKU_ID]); } catch {}
  try { await query(`DELETE FROM product_categories WHERE category_id IN ($1, $2)`, [SRC_CAT_ID, TGT_CAT_ID]); } catch {}
}

async function run() {
  console.log(`[${SCENARIO}] === START ===`);
  resetSnapshots();

  // ── Step 1: fixture ──
  await cleanupL3TestData();
  await cleanupProductFixture();
  const manager = await createTestManager();
  const client = await createTestClient();
  await ensureProductFixture();
  await ensureSourceSaleOrder({
    storeId: manager.storeId,
    clientUserId: client.userId,
    managerEmpId: manager.employeeId,
  });
  console.log(`  ✓ fixture：源卡 ${SOURCE_ITEM_ID} (5×¥500=¥2500) + 目标 ${TGT_SKU_ID} (¥200)`);

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);
  await installToastHook(miniProgram);
  await autoConfirmModal(miniProgram);

  // ── Step 2: 进 order-create（UI 验证页面可达 + productKindChoices ready）──
  await clearToasts(miniProgram);
  await miniProgram.switchTab('/pages/order-create/order-create');
  await new Promise(r => setTimeout(r, 1200));
  await snapshot(miniProgram, `${SCENARIO}-step2-order-create`);
  const pageData = await waitForData(
    miniProgram,
    (d) => Array.isArray(d.productKindChoices) && d.productKindChoices.length > 0,
    { timeoutMs: 5000 },
  ).catch(() => null);
  if (!pageData) {
    console.warn('  ⚠ order-create 未在 5s ready；继续走云函数直调验证');
  } else {
    console.log(`  ✓ order-create ready，productKindChoices=${JSON.stringify(pageData.productKindChoices)}`);
  }

  // ── Step 3: ConversionPanel 数据源（customerHeldCards）验证 ──
  await clearToasts(miniProgram);
  const heldRes = await callStaffApiWithTestOpenid(miniProgram, 'order.customerHeldCards', {
    clientUserId: client.userId,
  }, TEST_OPENID_MANAGER);
  const cards = heldRes?.cards || [];
  const srcCard = cards.find(c => c.saleItemId === SOURCE_ITEM_ID);
  if (!srcCard) {
    throw new Error(`customerHeldCards 未返回源卡 ${SOURCE_ITEM_ID}，实际 ${cards.length} 张：${JSON.stringify(cards.map(c => c.saleItemId))}`);
  }
  if (Number(srcCard.deductibleAmount) !== 2500) throw new Error(`deductibleAmount 应=2500，实际=${srcCard.deductibleAmount}`);
  if (Number(srcCard.remainingSessions) !== 5) throw new Error(`remainingSessions 应=5，实际=${srcCard.remainingSessions}`);
  console.log(`  ✓ 源卡折抵 ¥${srcCard.deductibleAmount}，差额预期 200-2500=-2300`);
  await snapshot(miniProgram, `${SCENARIO}-step3-panel-data`);

  // ── Step 4: 提交转换单 ──
  await clearToasts(miniProgram);
  const submitRes = await callStaffApiWithTestOpenid(miniProgram, 'order.createConversion', {
    clientUserId: client.userId,
    convertOutSaleItemIds: [SOURCE_ITEM_ID],
    convertInItems: [{ skuId: TGT_SKU_ID, quantity: 1 }],
    paymentMethod: '线下',
    remark: 'L3 BS-08',
  }, TEST_OPENID_MANAGER);

  const newOrderId = submitRes?.saleOrderId;
  if (!newOrderId) throw new Error(`createConversion 未返回 saleOrderId：${JSON.stringify(submitRes)}`);
  if (Number(submitRes.priceDiff) !== -2300) throw new Error(`priceDiff 应=-2300，实际=${submitRes.priceDiff}`);
  if (Number(submitRes.prepaidCardCredit) !== 2300) throw new Error(`prepaidCardCredit 应=2300，实际=${submitRes.prepaidCardCredit}`);
  if (submitRes.status !== '已支付') throw new Error(`转换单 status 应='已支付'（负差额），实际='${submitRes.status}'`);
  console.log(`  ✓ createConversion：${newOrderId} status=${submitRes.status} diff=${submitRes.priceDiff} credit=${submitRes.prepaidCardCredit}`);
  await snapshot(miniProgram, `${SCENARIO}-step4-submitted`);

  // ── Step 5: PG 验证 ──
  const orderRows = await query(
    `SELECT sale_order_type, status FROM sale_orders WHERE sale_order_id = $1`,
    [newOrderId],
  );
  if (orderRows.length !== 1) throw new Error(`转换单主表行数=${orderRows.length}`);
  if (orderRows[0].sale_order_type !== '转换单') throw new Error(`sale_order_type='${orderRows[0].sale_order_type}'`);
  if (orderRows[0].status !== '已支付') throw new Error(`PG status='${orderRows[0].status}'`);

  const itemRows = await query(
    `SELECT item_direction, sku_id, received, ref_sale_item_id
     FROM sale_items WHERE sale_order_id = $1 ORDER BY item_direction`,
    [newOrderId],
  );
  if (itemRows.length !== 2) throw new Error(`sale_items 应=2 行，实际=${itemRows.length}`);
  const out = itemRows.find(r => r.item_direction === '转出');
  const inn = itemRows.find(r => r.item_direction === '转入');
  if (!out || Number(out.received) >= 0 || out.ref_sale_item_id !== SOURCE_ITEM_ID) {
    throw new Error(`转出行不符：${JSON.stringify(out)}`);
  }
  if (!inn || inn.sku_id !== TGT_SKU_ID || Number(inn.received) !== 200) {
    throw new Error(`转入行不符：${JSON.stringify(inn)}`);
  }

  const srcAfter = await query(
    `SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1`,
    [SOURCE_ITEM_ID],
  );
  if (Number(srcAfter[0]?.remaining_sessions) !== 0) {
    throw new Error(`源卡 remaining_sessions 应=0，实际=${srcAfter[0]?.remaining_sessions}`);
  }

  await pgPoll(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`,
    [client.userId],
    (rows) => rows.length === 1 && Number(rows[0].balance) === 2300,
    { timeoutMs: 4000 },
  );

  const txns = await query(
    `SELECT type, amount FROM card_transactions WHERE ref_order_id = $1`,
    [newOrderId],
  );
  if (txns.length !== 1) throw new Error(`card_transactions 应=1 行，实际=${txns.length}`);
  if (txns[0].type !== '充值' || Number(txns[0].amount) !== 2300) {
    throw new Error(`充值流水：type=${txns[0].type} amount=${txns[0].amount}`);
  }

  console.log(`  ✓ PG：转换单 + 转出/转入双行 + 源卡耗尽 + 储值卡 ¥2300 + 充值流水`);
  console.log(`[${SCENARIO}] === PASS ===`);
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error(`[${SCENARIO}] === FAIL ===`);
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    dumpRecentSnapshots(3);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch {}
    try { await cleanupProductFixture(); } catch {}
    await disconnect(miniProgram);
    await closePool();
  }
}

main();
