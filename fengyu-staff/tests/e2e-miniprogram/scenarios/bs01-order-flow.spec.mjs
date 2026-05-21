// scenarios/bs01-order-flow.spec.mjs
// BS-01 完整开单链路 P0 E2E（参考 BUSINESS-SCENARIOS-DESIGN.md §4 BS-01）
//
// 用户故事：店长在 order-create 页给顾客小王开单（2 SKU + 优惠券 + 线下支付），
// 提交后跳 qrcode 页；PG 落 sale_orders + sale_items + coupon_id。
//
// === 关键假设 / 与设计文档差异（串行验证时重点排查）===
// 1) wxml 实际 Tab 是 ['组合套餐','普通商品','体验卡','充值卡']（PR-B 重构后），
//    没有"疗程卡"/"单品"。本 spec 不切大类，全程留在默认 '普通商品' Tab，
//    在该 Tab 下加 2 个 L3 SKU（一个 ¥600 单品 + 一个 ¥1500 疗程卡）。
// 2) "加入购物车"不是按钮——onSpuTap 直接 +1。直接 tap .spu-card 在 Vant + scroll-view 嵌套下脆性高，
//    本 spec 用 page.evaluate 直接调 onSpuTap 模拟点击（更稳）。
// 3) 提交按钮文字是 "生成付款码"（不是设计的"提交"），且 navigateTo 跳子包 packageOrder/order-qrcode。
// 4) 线下 + paidAmount>0 时 sale_orders.status = '待支付'（route/order.js line 587），
//    本 fixture 顾客无储值卡余额，paidAmount = payable，所以期望 '待支付'（非 '待支付'）。
// 5) L3 命名空间临时造 product_categories + 2 SKU + coupon_template + user_coupon，
//    比 smoke 那种"找第一个生产 SKU"更可控；cleanup 在 finally 双删。
//
// === 不确定点（串行测时盯一下）===
//  A. shopInit 的 EXISTS 过滤可能把 L3 category 过滤掉（要求该 category 下有
//     "is_enabled + 非卡类 + 非bundle" SKU）— 我们造的 2 个 SKU 都符合，理论上能出现。
//     若失败：page.data.spuList 空 → 退化到 callStaffApi('order.create') 兜底验 PG。
//  B. currentPage().route 字段名在 IDE 版本差异下可能是 '__wxRoute__'；本 spec 两个都判。
//  C. coupon_templates.discount_value numeric 类型，传 number 30 应被 PG cast 成 '30.00'；
//     payable_amount 期望 2070.00。
//  D. ALLOW_TEST_OPENID=true 必须开（cloudbaserc 已含）。

import {
  launchStaff, disconnect, navigateToTab, waitForData,
} from '../helpers/automator.mjs';
import { loginStaffWithTestOpenid } from '../helpers/login.mjs';
import { installToastHook, clearToasts, autoConfirmModal } from '../helpers/toast.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { query, pgPoll, closePool } from '../helpers/pg.mjs';
import { createTestManager, createTestClient, cleanupL3TestData } from '../helpers/fixtures.mjs';
import {
  TEST_OPENID_MANAGER, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, NAMESPACE,
} from '../helpers/constants.mjs';

let miniProgram = null;

const L3_CATEGORY_ID = `${NAMESPACE}CAT_BS01`;
const L3_SKU_A_ID = `${NAMESPACE}SKU_BS01_A`;
const L3_SKU_B_ID = `${NAMESPACE}SKU_BS01_B`;
const L3_COUPON_TPL_ID = `${NAMESPACE}CPN_TPL_BS01`;
const L3_COUPON_ID = `${NAMESPACE}CPN_BS01`;

const SKU_A_PRICE = 600;
const SKU_B_PRICE = 1500;
const EXPECTED_CART_TOTAL = SKU_A_PRICE + SKU_B_PRICE; // 2100
const COUPON_DISCOUNT = 30;
const EXPECTED_PAYABLE = EXPECTED_CART_TOTAL - COUPON_DISCOUNT; // 2070

// 在小程序内执行任意 page 函数（避免依赖 wxml selector 脆性）
async function callPage(fn, ...args) {
  return miniProgram.evaluate(function (fnStr, argsJson) {
    const pages = getCurrentPages();
    const page = pages[pages.length - 1];
    // eslint-disable-next-line no-new-func
    return (new Function('page', 'args', `return (${fnStr})(page, ...args)`))(page, JSON.parse(argsJson));
  }, fn.toString(), JSON.stringify(args));
}

async function setupProductsAndCoupon() {
  await query(
    `INSERT INTO product_categories
       (category_id, category_name, product_kind, sales_category, sort_order, is_valid)
     VALUES ($1, 'L3 BS01 护理类', '护理项目', '他销自耗', 0, true)
     ON CONFLICT (category_id) DO UPDATE SET is_valid = true`,
    [L3_CATEGORY_ID],
  );
  await query(
    `INSERT INTO product_skus
       (sku_id, category_id, product_type, spec_name, price, session_count,
        sort_order, service_fee, is_experience, is_enabled)
     VALUES
       ($1, $2, '单品', 'L3 BS01 单品 600', $3, 1, 0, 0, false, true),
       ($4, $2, '疗程卡', 'L3 BS01 疗程卡 1500x5', $5, 5, 0, 0, false, true)
     ON CONFLICT (sku_id) DO UPDATE SET is_enabled = true, price = EXCLUDED.price`,
    [L3_SKU_A_ID, L3_CATEGORY_ID, SKU_A_PRICE, L3_SKU_B_ID, SKU_B_PRICE],
  );
  await query(
    `INSERT INTO coupon_templates
       (template_id, name, coupon_type, discount_value, min_spend, is_active, validity_mode)
     VALUES ($1, 'L3 BS01 现金券 30', '现金券', $2, 200, true, 'fixed')
     ON CONFLICT (template_id) DO UPDATE SET is_active = true`,
    [L3_COUPON_TPL_ID, COUPON_DISCOUNT],
  );
  await query(
    `INSERT INTO user_coupons (coupon_id, template_id, user_id, status, expire_at)
     VALUES ($1, $2, $3, '未使用', NOW() + INTERVAL '30 days')
     ON CONFLICT (coupon_id) DO UPDATE
       SET status = '未使用', expire_at = NOW() + INTERVAL '30 days'`,
    [L3_COUPON_ID, L3_COUPON_TPL_ID, TEST_CLIENT_USER_ID],
  );
}

async function cleanupProductsAndCoupon() {
  for (const [sql, params] of [
    [`DELETE FROM user_coupons WHERE coupon_id LIKE $1`, [`${NAMESPACE}%`]],
    [`DELETE FROM coupon_templates WHERE template_id LIKE $1`, [`${NAMESPACE}%`]],
    [`DELETE FROM product_skus WHERE sku_id LIKE $1`, [`${NAMESPACE}%`]],
    [`DELETE FROM product_categories WHERE category_id LIKE $1`, [`${NAMESPACE}%`]],
  ]) {
    try { await query(sql, params); } catch (e) { console.warn(`[bs01 cleanup] ${e.message}`); }
  }
}

// =========================================================================
// Steps（每个 step 函数纯执行 + 断言；step 编号对齐设计文档 §4 BS-01 矩阵）
// =========================================================================

async function step1_navigateOrderCreate() {
  console.log('[bs01 step1] navigateToTab → order-create');
  await navigateToTab(miniProgram, '/pages/order-create/order-create');
  await waitForData(
    miniProgram,
    (d) => Array.isArray(d.productKindChoices) && d.productKindChoices.length === 4,
    { timeoutMs: 8000 },
  );
  const d = await (await miniProgram.currentPage()).data();
  if (d.productKindChoice !== '普通商品') throw new Error(`默认 Tab 期望 '普通商品'，实际 '${d.productKindChoice}'`);
}

async function step2_assertDefaultKind() {
  const d = await (await miniProgram.currentPage()).data();
  if (!Array.isArray(d.categories) || d.categories.length === 0) {
    throw new Error('普通商品 Tab 下 categories 为空（shopInit EXISTS 过滤可能没保留 L3 category）');
  }
  console.log('  ok categories=', d.categories.length, 'spuList=', d.spuList.length);
}

async function selectCategoryAndAddSku(targetSkuId) {
  // 切到 L3 category
  await callPage(function (page, args) {
    page.setData({ activeCategoryId: args[0] });
    if (typeof page.loadSpuList === 'function') page.loadSpuList(args[0]);
  }, L3_CATEGORY_ID);
  await waitForData(
    miniProgram,
    (d) => Array.isArray(d.spuList) && d.spuList.some((s) => s.spuId === targetSkuId),
    { timeoutMs: 4000 },
  );
  // 调 onSpuTap
  await callPage(function (page, args) {
    const item = (page.data.spuList || []).find((s) => s.spuId === args[0]);
    if (!item) throw new Error('spuList 无目标 SKU: ' + args[0]);
    page.onSpuTap({ currentTarget: { dataset: { spu: item } } });
  }, targetSkuId);
}

async function step3_addSkuA() {
  console.log('[bs01 step3] 加 SKU A (¥600)');
  await selectCategoryAndAddSku(L3_SKU_A_ID);
  await waitForData(miniProgram, (d) => d.cart && d.cart.length >= 1, { timeoutMs: 4000 });
  const d = await (await miniProgram.currentPage()).data();
  if (d.cartCount !== 1) throw new Error(`badge 期望 1，实际 ${d.cartCount}`);
}

async function step4_addSkuB() {
  console.log('[bs01 step4] 加 SKU B (¥1500)');
  await selectCategoryAndAddSku(L3_SKU_B_ID);
  await waitForData(miniProgram, (d) => d.cart && d.cart.length >= 2, { timeoutMs: 4000 });
  const d = await (await miniProgram.currentPage()).data();
  const total = parseFloat(d.cartTotal);
  if (Math.abs(total - EXPECTED_CART_TOTAL) > 0.01) {
    throw new Error(`cartTotal 期望 ${EXPECTED_CART_TOTAL}，实际 ${d.cartTotal}`);
  }
  console.log('  ok cartTotal=', d.cartTotal);
}

async function step5_openCheckout() {
  console.log('[bs01 step5] 打开结算弹层');
  await callPage(function (page) { page.onOpenCheckout(); });
  await waitForData(miniProgram, (d) => d.showCheckout === true && d.checkoutStep === 0, { timeoutMs: 3000 });
}

async function step6_selectCustomer() {
  console.log('[bs01 step6] 搜索 + 选顾客');
  await callPage(function (page, args) {
    page.setData({ customerPhone: args[0] });
    return page.onSearchCustomer();
  }, TEST_CLIENT_PHONE);
  await waitForData(
    miniProgram,
    (d) => d.customerInfo && d.customerInfo.id === TEST_CLIENT_USER_ID,
    { timeoutMs: 4000 },
  );
  await callPage(function (page) { page.onStep0Next(); });
  await waitForData(miniProgram, (d) => d.checkoutStep === 2, { timeoutMs: 3000 });
}

async function step7_selectCoupon() {
  console.log('[bs01 step7] 选优惠券');
  await callPage(function (page) { return page.onSelectCoupon(); });
  await waitForData(
    miniProgram,
    (d) => Array.isArray(d.availableCoupons) && d.availableCoupons.some((c) => c.couponId === L3_COUPON_ID),
    { timeoutMs: 4000 },
  );
  await callPage(function (page, args) {
    const target = (page.data.availableCoupons || []).find((c) => c.couponId === args[0]);
    if (!target) throw new Error('未找到 coupon: ' + args[0]);
    page.onCouponPick({ currentTarget: { dataset: { couponId: target.couponId, name: target.name, discount: target.discount } } });
  }, L3_COUPON_ID);
  await waitForData(miniProgram, (d) => Number(d.couponDiscount) === COUPON_DISCOUNT, { timeoutMs: 3000 });
  const d = await (await miniProgram.currentPage()).data();
  const payable = parseFloat(d.couponTotal);
  if (Math.abs(payable - EXPECTED_PAYABLE) > 0.01) {
    throw new Error(`couponTotal 期望 ${EXPECTED_PAYABLE}，实际 ${d.couponTotal}`);
  }
  console.log('  ok couponDiscount=', d.couponDiscount, 'couponTotal=', d.couponTotal);
}

async function step8_submitOffline() {
  console.log('[bs01 step8] 切线下 + 提交');
  await callPage(function (page) { page.setData({ paymentMethod: '线下' }); });
  await callPage(function (page) { return page.onSubmitOrder(); });
  await new Promise((r) => setTimeout(r, 1500)); // navigateTo 异步
}

async function step9_verifyQrcodeAndPg() {
  console.log('[bs01 step9] qrcode 页 + PG 断言');
  const page = await miniProgram.currentPage();
  const route = page.route || page.__wxRoute__ || '';
  console.log('  currentPage.route=', route);
  if (!String(route).includes('order-qrcode')) {
    throw new Error(`期望跳到 order-qrcode，实际 route=${route}`);
  }
  await waitForData(miniProgram, (d) => !!d.saleOrderId, { timeoutMs: 6000 });
  const qd = await (await miniProgram.currentPage()).data();
  const saleOrderId = qd.saleOrderId;
  console.log('  saleOrderId=', saleOrderId);
  if (!/^FY-XSD-WX-/.test(saleOrderId)) throw new Error(`saleOrderId 格式不对: ${saleOrderId}`);

  // PG 断言（pgPoll，留出 setData / commit 的延迟）
  const rows = await pgPoll(
    `SELECT status, total_amount, payable_amount, coupon_id, payment_method, allocation_status
       FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId],
    (rows) => rows.length === 1 && rows[0].status === '待支付',
    { timeoutMs: 4000 },
  );
  const row = rows[0];
  console.log('  PG order =', JSON.stringify(row));
  if (row.coupon_id !== L3_COUPON_ID) throw new Error(`coupon_id 期望 ${L3_COUPON_ID}，实际 ${row.coupon_id}`);
  if (row.payment_method !== '线下') throw new Error(`payment_method 期望 '线下'，实际 '${row.payment_method}'`);
  if (Math.abs(Number(row.total_amount) - EXPECTED_CART_TOTAL) > 0.01) {
    throw new Error(`total_amount 期望 ${EXPECTED_CART_TOTAL}，实际 ${row.total_amount}`);
  }
  if (Math.abs(Number(row.payable_amount) - EXPECTED_PAYABLE) > 0.01) {
    throw new Error(`payable_amount 期望 ${EXPECTED_PAYABLE}，实际 ${row.payable_amount}`);
  }
  const items = await query(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [saleOrderId]);
  if (items.length !== 2) throw new Error(`sale_items 期望 2 行，实际 ${items.length}`);
  console.log('  ok sale_items=2  allocation_status=', row.allocation_status);
}

// =========================================================================
// Main
// =========================================================================

async function run() {
  console.log('[bs01-order-flow] === START ===');
  resetSnapshots();

  try { await cleanupProductsAndCoupon(); } catch (e) { console.warn(e.message); }
  try { await cleanupL3TestData(); } catch (e) { console.warn(e.message); }

  await createTestManager();
  await createTestClient();
  await setupProductsAndCoupon();

  miniProgram = await launchStaff();
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);
  await installToastHook(miniProgram);
  await autoConfirmModal(miniProgram, { confirm: true });

  const steps = [
    ['step1', step1_navigateOrderCreate],
    ['step2', step2_assertDefaultKind],
    ['step3', step3_addSkuA],
    ['step4', step4_addSkuB],
    ['step5', step5_openCheckout],
    ['step6', step6_selectCustomer],
    ['step7', step7_selectCoupon],
    ['step8', step8_submitOffline],
    ['step9', step9_verifyQrcodeAndPg],
  ];
  for (const [label, fn] of steps) {
    await clearToasts(miniProgram);
    await fn();
    await snapshot(miniProgram, `bs01-${label}`);
  }

  console.log('[bs01-order-flow] === PASS ===');
}

async function main() {
  try {
    await run();
    process.exit(0);
  } catch (e) {
    console.error('[bs01-order-flow] === FAIL ===');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    dumpRecentSnapshots(3);
    process.exit(1);
  } finally {
    try { await cleanupProductsAndCoupon(); } catch {}
    try { await cleanupL3TestData(); } catch {}
    await disconnect(miniProgram);
    await closePool();
  }
}

main();
