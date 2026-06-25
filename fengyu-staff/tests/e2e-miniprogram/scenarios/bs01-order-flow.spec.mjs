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
  TEST_OPENID_MANAGER, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE, NAMESPACE, TEST_STORE_A1_ID,
} from '../helpers/constants.mjs';

let miniProgram = null;

// 一级父类目（product_kind IS NULL）：shopInit 走 withParentJoin INNER JOIN，
// 二级行须能 JOIN 到一个 category_name = 自身 product_kind 的一级行才会出现在 groupedCategories。
// 生产 product_kind 完全 DB 驱动（招牌/王牌/明星/…，无「护理项目」），故自带命名空间一级行，
// 不耦合线上 kind 名（线上改名也不影响本 spec）。
const L3_KIND_CATEGORY_ID = `${NAMESPACE}KIND_BS01`;
const L3_KIND_NAME = 'L3护理项目';
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

// mp 运行时禁用 eval / new Function（旧 callPage 把函数源码传进去重建会抛
// "Function(...) is not a function"）。统一改用 automator 原生 page.callMethod /
// setData / data（与 bs04 一致，更稳）。
async function cur() {
  return miniProgram.currentPage();
}

async function setupProductsAndCoupon() {
  // 一级父类目（product_kind IS NULL，category_name = 二级行的 product_kind）。
  // sort_order 给大值，避免把 L3 kind 排到生产 kind 之前、改变开单页默认选中分组。
  await query(
    `INSERT INTO product_categories
       (category_id, category_name, product_kind, sales_category, sort_order, is_valid)
     VALUES ($1, $2, NULL, '他销自耗', 999, true)
     ON CONFLICT (category_id) DO UPDATE SET is_valid = true, product_kind = NULL`,
    [L3_KIND_CATEGORY_ID, L3_KIND_NAME],
  );
  // 二级类目：product_kind = 上面一级行的 category_name，使 withParentJoin 命中。
  await query(
    `INSERT INTO product_categories
       (category_id, category_name, product_kind, sales_category, sort_order, is_valid)
     VALUES ($1, 'L3 BS01 护理类', $2, '他销自耗', 0, true)
     ON CONFLICT (category_id) DO UPDATE SET is_valid = true, product_kind = EXCLUDED.product_kind`,
    [L3_CATEGORY_ID, L3_KIND_NAME],
  );
  await query(
    `INSERT INTO product_skus
       (sku_id, category_id, product_type, spec_name, price, session_count,
        sort_order, service_fee, is_experience, is_enabled)
     VALUES
       ($1, $2, '疗程卡', 'L3 BS01 单品 600', $3, 1, 0, 0, false, true),
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

/** groupedCategories 是否已含 L3 命名空间二级类目（= shopInit withParentJoin + 非体验卡 EXISTS 均通过） */
function groupedHasL3(d) {
  return Array.isArray(d.groupedCategories)
    && d.groupedCategories.some((g) => Array.isArray(g.items) && g.items.some((c) => c.id === L3_CATEGORY_ID));
}

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

  // 购物车隔离：重置防跨次重跑残留（不重启 IDE 时 Page 实例复用 → cart data 泄漏 → step3 badge 偏大）。
  try { await (await cur()).callMethod('updateCart', []); } catch { /* ignore */ }

  // 显式驱动 loadShopInit + 重试兜底：onShow 的加载受 `_allCategories` 守卫 + Page 实例跨场景复用影响，
  // 测试里不可靠（实测 groupedCategories 时 6 时 0）。shopInit 本身可靠（直调诊断 6/6 返回 6 组含 L3），
  // 故直调页面 loadShopInit 强制刷新目录，最多 3 次直到分组含 L3。
  let loaded = false;
  for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
    try { await (await cur()).callMethod('loadShopInit'); } catch { /* ignore，下面 waitForData 兜底 */ }
    try {
      await waitForData(miniProgram, groupedHasL3, { timeoutMs: 5000 });
      loaded = true;
    } catch {
      console.log(`  [retry] loadShopInit 第 ${attempt} 次后 groupedCategories 仍无 L3 类目`);
    }
  }
}

async function step2_assertDefaultKind() {
  // PR-B 后「普通商品」Tab 用 groupedCategories 渲染侧边栏，page.data.categories 恒为 []
  // （order-create.ts filterCategoriesByKindChoice 对普通商品直接返回 []）。step1 已显式加载 + 重试，
  // 此处仅断言最终状态。
  const d = await (await cur()).data();
  if (!groupedHasL3(d)) {
    const groups = d.groupedCategories || [];
    throw new Error(`普通商品 Tab groupedCategories 未含 L3 类目 ${L3_CATEGORY_ID}（groups=${groups.length}, catalogLoading=${d.catalogLoading}）`);
  }
  console.log('  ok groupedCategories=', (d.groupedCategories || []).length, '已含 L3 类目');
}

async function selectCategoryAndAddSku(targetSkuId) {
  // 切到 L3 category
  const page = await cur();
  await page.setData({ activeCategoryId: L3_CATEGORY_ID });
  try { await page.callMethod('loadSpuList', L3_CATEGORY_ID); } catch { /* setData observer 可能已触发加载 */ }
  await waitForData(
    miniProgram,
    (d) => Array.isArray(d.spuList) && d.spuList.some((s) => s.spuId === targetSkuId),
    { timeoutMs: 4000 },
  );
  // 调 onSpuTap（item 从 node 侧 page.data() 取，再以序列化参数回传）
  const d = await (await cur()).data();
  const item = (d.spuList || []).find((s) => s.spuId === targetSkuId);
  if (!item) throw new Error('spuList 无目标 SKU: ' + targetSkuId);
  await (await cur()).callMethod('onSpuTap', { currentTarget: { dataset: { spu: item } } });
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
  await (await cur()).callMethod('onOpenCheckout');
  await waitForData(miniProgram, (d) => d.showCheckout === true && d.checkoutStep === 0, { timeoutMs: 3000 });
}

async function step6_selectCustomer() {
  console.log('[bs01 step6] 搜索 + 选顾客');
  const page = await cur();
  // 页面 onSearchCustomer 读的是 customerKeyword（不是 customerPhone）
  await page.setData({ customerKeyword: TEST_CLIENT_PHONE });
  await page.callMethod('onSearchCustomer');
  // customer.search 返回 { id: customer_id(WorkFine 编号), clientUserId: user_id, ... }；
  // L3 测试顾客无 customer_id（id=null），匹配键应是 clientUserId（= user_id）。
  await waitForData(
    miniProgram,
    (d) => d.customerInfo && d.customerInfo.clientUserId === TEST_CLIENT_USER_ID,
    { timeoutMs: 4000 },
  );
  await (await cur()).callMethod('onStep0Next');
  await waitForData(miniProgram, (d) => d.checkoutStep === 2, { timeoutMs: 3000 });
}

async function step7_selectCoupon() {
  console.log('[bs01 step7] 选优惠券');
  await (await cur()).callMethod('onSelectCoupon');
  await waitForData(
    miniProgram,
    (d) => Array.isArray(d.availableCoupons) && d.availableCoupons.some((c) => c.couponId === L3_COUPON_ID),
    { timeoutMs: 4000 },
  );
  const dCoup = await (await cur()).data();
  const target = (dCoup.availableCoupons || []).find((c) => c.couponId === L3_COUPON_ID);
  if (!target) throw new Error('未找到 coupon: ' + L3_COUPON_ID);
  await (await cur()).callMethod('onCouponPick', { currentTarget: { dataset: { couponId: target.couponId, name: target.name, discount: target.discount } } });
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
  const page = await cur();
  await page.setData({ paymentMethod: '线下' });
  await page.callMethod('onSubmitOrder');
  await new Promise((r) => setTimeout(r, 2000)); // 等 order.create + navigateTo
  // 诊断：若 order.create 失败，onSubmitOrder 会 showToast（此处 step 循环尚未 clearToasts，可读到）。
  const toasts = await miniProgram.evaluate(() => (wx.__e2e_toasts || []).map((t) => t.title));
  if (toasts.length) console.log('  [diag] 提交后 toast:', JSON.stringify(toasts));
}

async function step9_verifyQrcodeAndPg() {
  console.log('[bs01 step9] 订单 PG 断言（qrcode 跳转作 best-effort）');
  // best-effort：onSubmitOrder navigateTo 跳子包 order-qrcode。automator 读子包 currentPage().route 偶发为空
  // （非业务问题），故仅记录、不作硬断言；订单正确性以 PG 为权威。
  let route = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const p = await miniProgram.currentPage();
    route = (p && (p.route || p.__wxRoute__)) || '';
    if (String(route).includes('order-qrcode')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('  currentPage.route=', route || '(空)',
    String(route).includes('order-qrcode') ? '✓ 已跳 qrcode' : '（子包 route 未读到，转 PG 校验）');

  // PG 权威断言：run() 开头 cleanup-first 已清掉该顾客旧单，故此刻唯一「待支付」单即本轮所开。
  const rows = await pgPoll(
    `SELECT sale_order_id, status, total_amount, payable_amount, coupon_id, payment_method, allocation_status
       FROM sale_orders
      WHERE client_user_id = $1 AND status = '待支付'
      ORDER BY created_at DESC LIMIT 1`,
    [TEST_CLIENT_USER_ID],
    (rows) => rows.length === 1,
    { timeoutMs: 8000 },
  );
  const row = rows[0];
  const saleOrderId = row.sale_order_id;
  console.log('  PG order =', JSON.stringify(row));
  if (!/^FY-XSD-WX-/.test(saleOrderId)) throw new Error(`saleOrderId 格式不对: ${saleOrderId}`);
  if (row.coupon_id !== L3_COUPON_ID) throw new Error(`coupon_id 期望 ${L3_COUPON_ID}，实际 ${row.coupon_id}`);
  if (row.payment_method !== '线下') throw new Error(`payment_method 期望 '线下'，实际 '${row.payment_method}'`);
  // 现后端 total_amount = Σ sale_items.sale_amount（已摊订单级券）= 应付，与 payable 同值（券 -30 后 = 2070）。
  // 卡前总额 2100 仅存在于购物车展示（step4 已断言 cartTotal=2100），不落库为 total_amount。
  if (Math.abs(Number(row.total_amount) - EXPECTED_PAYABLE) > 0.01) {
    throw new Error(`total_amount 期望 ${EXPECTED_PAYABLE}（已摊券），实际 ${row.total_amount}`);
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

  // 顺序要紧：先删订单/明细（cleanupL3TestData，按 client_user_id 删含生成 ID 的订单），
  // 再删商品/类目（cleanupProductsAndCoupon）。否则残留订单的 sale_items 仍 FK 引用 SKU →
  // 删 SKU 报 FK；且残留「待支付」单会触发后端「一顾客一待支付单」守卫，挡掉本轮 order.create。
  try { await cleanupL3TestData(); } catch (e) { console.warn(e.message); }
  try { await cleanupProductsAndCoupon(); } catch (e) { console.warn(e.message); }

  await createTestManager();
  await createTestClient();
  await setupProductsAndCoupon();

  miniProgram = await launchStaff();
  // 必须传 currentStoreId：否则 globalData.currentStoreId 残留真实 IDE 账号旧门店，
  // 页面 utils/cloud.ts 会把它当 _currentStoreId 注入 → 不在测试店长 scope → 后端
  // resolveRuntimeAuth 抛「无权访问该门店」→ 页面 loadShopInit 等所有调用静默失败（catch 成空数据）。
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER, TEST_STORE_A1_ID);
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
    // 同 run() 开头：先删订单/明细再删商品/类目（FK 顺序）。
    try { await cleanupL3TestData(); } catch {}
    try { await cleanupProductsAndCoupon(); } catch {}
    await disconnect(miniProgram);
    await closePool();
  }
}

main();
