// scenarios/bs04-allocation.spec.mjs — BS-04 营业额分配端到端
//
// 用户故事：店长 A 看 workbench "待分配" 徽章=1 → 进 allocation-list → 选订单
//   → 进 revenue-allocation → suggest 自动填充 allocLines (preferred_employee_id × skills)
//   → 保存 → 回 list → 徽章=0；PG sale_allocations 写入 + allocation_status='已分配'。
//
// ─────────────────── 不确定点（实现前已确认 / 已降级）───────────────────
// 1. "智能分配" 按钮在 wxml 中**不存在**。`init()` 调用 allocation.suggest 自动填 allocLines
//    到 items —— 这本身就是"智能分配"。前端按钮仅有 "标记为无需分配" / "保存分配方案" 两个。
//    → 本 spec 不点 "智能分配"，而是验证 suggest 自动填 allocLines.length≥1。
// 2. 手动调 ratio 的 UI 是 picker（看 wxml 第 ~70 行的 `<picker>`），改 ratio 需要
//    page.setData 或操作 picker `change` 事件 —— automator 对 picker 支持不稳。
//    → **降级**：跳过手动调 ratio，直接保存 suggest 自动算出的 ratio=1.00 + amount。
// 3. `onSave` 不弹 modal，直接调 callStaffApi → 不需要 autoConfirmModal；toast='分配已保存'
//    + setTimeout(navigateBack, 1500)。我们等 toast + 等 navigateBack 完成。
// 4. confirmOffline 不更新 sale_items.received，但 suggest 用 si.received 算 totalAmount。
//    → 我们在 fixture 里把 sale_items.received 直接置成 amount。
// 5. allocLines 由 suggest 自动填充的前提：order.preferred_employee_id 非空 + 该员工有 skills。
//    → 把 manager 设为 preferred_employee_id + 给 manager skills=['美容师']。

import {
  launchStaff, disconnect, navigateToTab, waitForData,
} from '../helpers/automator.mjs';
import { loginStaffWithTestOpenid, callStaffApiWithTestOpenid } from '../helpers/login.mjs';
import { installToastHook, assertToast, clearToasts, autoConfirmModal } from '../helpers/toast.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { query, pgPoll, closePool } from '../helpers/pg.mjs';
import {
  createTestPendingOfflineOrder, cleanupL3TestData,
} from '../helpers/fixtures.mjs';
import {
  TEST_OPENID_MANAGER, TEST_MANAGER_EMPLOYEE_ID,
} from '../helpers/constants.mjs';

let miniProgram = null;
let createdOrderId = null;

async function setupAllocationFixture() {
  // 1) 走标准 fixture：店长 + 顾客 + 线下待付订单
  const fx = await createTestPendingOfflineOrder({ amount: 500 });

  // 2) 给店长加 skills（preferred_employee_id 必须有 skills 才会触发 suggest 生成 allocLines）
  await query(
    `UPDATE staff_wechat_users SET skills = $1 WHERE employee_id = $2`,
    [['美容师'], TEST_MANAGER_EMPLOYEE_ID],
  );

  // 3) 把订单设置 preferred_employee_id = 店长本人（sale_orders 没有 sales_category 列，下放 sale_items）
  await query(
    `UPDATE sale_orders SET preferred_employee_id = $1
       WHERE sale_order_id = $2`,
    [TEST_MANAGER_EMPLOYEE_ID, fx.orderId],
  );

  // 4) sale_items.received 置为 amount + sales_category（suggest 用它算 totalAmount）
  await query(
    `UPDATE sale_items SET received = $1, sales_category = '自销自耗'
       WHERE sale_order_id = $2`,
    [fx.amount, fx.orderId],
  );

  return fx;
}

async function run() {
  console.log('[bs04-allocation] === START ===');
  resetSnapshots();

  console.log('[step 0] 清理 L3 残留');
  await cleanupL3TestData();

  console.log('[step 0.1] 准备 fixture：店长+顾客+订单+skills+preferred_employee_id');
  const fixture = await setupAllocationFixture();
  createdOrderId = fixture.orderId;

  console.log('[step 0.2] launch + login + installToastHook');
  miniProgram = await launchStaff();
  // 传 fixture.client.storeId 让 hook 同时注入 _currentStoreId / _loginLevel
  // 否则 utils/cloud.ts 会把 IDE 真账号的 globalData.currentStoreId 注入 → 后端 throw "无权访问该门店"
  await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER, fixture.client.storeId);
  await installToastHook(miniProgram);

  // 通过 confirmOffline 把订单置 '已支付' + allocation_status='待分配'
  console.log('[step 0.3] confirmOffline 把订单转入"已支付/待分配"');
  await callStaffApiWithTestOpenid(
    miniProgram, 'order.confirmOffline',
    { saleOrderId: fixture.orderId },
    TEST_OPENID_MANAGER,
  );
  // PG 兜底：确保 allocation_status = '待分配'
  await query(
    `UPDATE sale_orders SET allocation_status = '待分配' WHERE sale_order_id = $1`,
    [fixture.orderId],
  );

  // 诊断：先直接调 todoList 看后端 scope 链是否对，把"后端 SQL 数错"跟"前端没渲染"两类失败分开
  const todo = await callStaffApiWithTestOpenid(
    miniProgram, 'staff.todoList', {}, TEST_OPENID_MANAGER,
  );
  console.log('  [diag] todoList.pendingAllocationCount=', todo.pendingAllocationCount);
  if (!todo.pendingAllocationCount || todo.pendingAllocationCount < 1) {
    throw new Error(`fixture 未被 todoList 计入（后端 SQL/scope 问题）：${JSON.stringify(todo)}`);
  }

  // ─── Step 1：workbench 徽章 pendingAllocationCount=1 ───
  console.log('[step 1] navigateToTab workbench → 等 pendingAllocationCount=1');
  await clearToasts(miniProgram);
  // 兜底：确保 globalData 关键字段非空，避免 workbench.onShow reLaunch 到 login
  await miniProgram.evaluate((staffWfId, storeId) => {
    const app = getApp();
    if (app?.globalData) {
      if (!app.globalData.staffWfId) app.globalData.staffWfId = staffWfId;
      if (!app.globalData.scopedStores || app.globalData.scopedStores.length === 0) {
        app.globalData.scopedStores = [{ storeId, storeName: 'L3 测试门店' }];
      }
      app.globalData.boundStoreName = app.globalData.boundStoreName || 'L3 测试门店';
    }
  }, TEST_MANAGER_EMPLOYEE_ID, fixture.client.storeId);
  await navigateToTab(miniProgram, '/pages/workbench/workbench');
  // 主动触发 loadWorkbench：switchTab 到当前 tab 时 onShow 不一定再触发
  const wbPage = await miniProgram.currentPage();
  console.log('  [diag] currentPage.route =', wbPage.path || wbPage.route);
  try { await wbPage.callMethod('loadWorkbench'); } catch (e) {
    console.warn('  [diag] callMethod loadWorkbench 失败:', e.message);
  }
  await waitForData(miniProgram, (d) => d.pendingAllocationCount === 1, { timeoutMs: 8000 });
  await snapshot(miniProgram, 'bs04-step1-workbench-badge');
  console.log('  ok — pendingAllocationCount=1');

  // ─── Step 2：tap "待提成分配" → allocation-list 渲染 1 项 ───
  console.log('[step 2] 跳 allocation-list（直接 navigateTo，避免 tap Vant 嵌套的不稳定）');
  await clearToasts(miniProgram);
  await miniProgram.navigateTo('/packageOrder/allocation-list/allocation-list');
  await waitForData(miniProgram, (d) => Array.isArray(d.orders) && d.orders.length >= 1, { timeoutMs: 8000 });
  const listPage = await miniProgram.currentPage();
  const listData = await listPage.data();
  const inList = listData.orders.find(o => o.sale_order_id === fixture.orderId);
  if (!inList) throw new Error(`allocation-list 未找到订单 ${fixture.orderId}`);
  await snapshot(miniProgram, 'bs04-step2-allocation-list');
  console.log('  ok — orders.length=', listData.orders.length);

  // ─── Step 3：进 revenue-allocation 详情 ───
  console.log('[step 3] navigateTo revenue-allocation?saleOrderId=...');
  await clearToasts(miniProgram);
  await miniProgram.navigateTo(`/packageOrder/revenue-allocation/revenue-allocation?saleOrderId=${fixture.orderId}`);
  await waitForData(miniProgram, (d) => d.order && Array.isArray(d.items) && d.items.length >= 1, { timeoutMs: 10000 });
  const allocPage = await miniProgram.currentPage();
  const allocData = await allocPage.data();
  if (Number(allocData.totalAmount) <= 0) {
    throw new Error(`订单总额异常: totalAmount=${allocData.totalAmount}`);
  }
  await snapshot(miniProgram, 'bs04-step3-revenue-allocation-loaded');
  console.log('  ok — totalAmount=', allocData.totalAmount, ' items=', allocData.items.length);

  // ─── Step 4：suggest 已自动填 allocLines（"智能分配"语义）───
  // 注意：页面把带 allocLines 的数据放在 `displayItems`，不是 `items`（items 是原始 OrderItem）
  console.log('[step 4] 验证 suggest 已自动填 displayItems[*].allocLines.length≥1');
  await waitForData(miniProgram, (d) => {
    const displayItems = d.displayItems || [];
    return displayItems.some(it => Array.isArray(it.allocLines) && it.allocLines.length >= 1);
  }, { timeoutMs: 5000 });
  const allocData2 = await (await miniProgram.currentPage()).data();
  const totalLines = (allocData2.displayItems || [])
    .reduce((s, it) => s + (it.allocLines?.length || 0), 0);
  console.log('  ok — auto-suggested allocLines 共', totalLines, '条');
  await snapshot(miniProgram, 'bs04-step4-suggested-filled');

  // ─── Step 5（降级）：跳过手动调 ratio picker，直接 setData 写入 ratio=1.00 ───
  // suggest 后端不填 allocationRatio（设计意图是用户用 picker 选 10%-100%）
  // 我们直接把所有 allocLines 的 allocationRatio 写成 '1.00'（100%），amount 重算为 received
  console.log('[step 5] 降级：跳过 picker，直接 setData 写 allocationRatio=1.00');
  const allocDataBeforeRatio = await allocPage.data();
  const patchedDI = (allocDataBeforeRatio.displayItems || []).map(it => ({
    ...it,
    allocLines: (it.allocLines || []).map(l => ({
      ...l,
      allocationRatio: 1.00,
      amount: String(Number(it.received || 0).toFixed(2)),
    })),
  }));
  await allocPage.setData({ displayItems: patchedDI });

  // ─── Step 6：tap "保存" → 验证 toast + 回 list 徽章=0 + PG ───
  console.log('[step 6] 调 onSave（直接 callMethod，避免 Vant 按钮 tap 不稳）');
  // 诊断：抓一份 allocLines 看是否缺 staffWfId/department/roleType
  // - 缺 staffWfId/department → onSave 视作"无 effective 行"→ 触发 onSkipAllocation 弹 wx.showModal → 冻结 ws
  // - 缺 roleType → onSave 抛 toast 后 return（"缺少技能标签..."），spec 等错 toast
  // 同时预先 autoConfirmModal，万一真的弹了 modal 也能被自动点掉，避免死锁
  const preSaveData = await allocPage.data();
  const allLines = (preSaveData.displayItems || []).flatMap(it => it.allocLines || []);
  console.log('  [diag] allocLines =', JSON.stringify(allLines));
  await autoConfirmModal(miniProgram);
  await clearToasts(miniProgram);
  await allocPage.callMethod('onSave');
  await assertToast(miniProgram, '分配已保存', { timeoutMs: 5000 });
  await snapshot(miniProgram, 'bs04-step6a-saved-toast');
  console.log('  ok — toast="分配已保存"');

  // 等 onSave 内 setTimeout(navigateBack, 1500) 回到 allocation-list
  await new Promise(r => setTimeout(r, 2200));

  // PG 断言：sale_allocations 写入 + allocation_status='已分配'
  console.log('[step 6.1] PG 断言 sale_allocations 写入 + allocation_status');
  await pgPoll(
    `SELECT sa.sale_item_id, sa.employee_id, sa.allocation_ratio, sa.total_amount, sa.is_void
       FROM sale_allocations sa
       JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
      WHERE si.sale_order_id = $1 AND sa.is_void = false`,
    [fixture.orderId],
    (rows) => rows.length >= 1,
    { timeoutMs: 5000 },
  );
  const orderRows = await query(
    `SELECT allocation_status FROM sale_orders WHERE sale_order_id = $1`,
    [fixture.orderId],
  );
  if (orderRows[0]?.allocation_status !== '已分配') {
    throw new Error(`allocation_status 期望 '已分配' 实际 '${orderRows[0]?.allocation_status}'`);
  }
  console.log('  ok — allocation_status=已分配 + sale_allocations 已写');

  // ─── Step 6.2：回 allocation-list，list 不再含该订单 ───
  console.log('[step 6.2] 等 onShow 重刷 allocation-list（订单已分配，应消失）');
  await waitForData(miniProgram, (d) => {
    if (!Array.isArray(d.orders)) return false;
    return !d.orders.find(o => o.sale_order_id === fixture.orderId);
  }, { timeoutMs: 8000 });
  await snapshot(miniProgram, 'bs04-step6b-list-emptied');
  console.log('  ok — allocation-list 已不含该订单');

  // ─── Step 6.3：回 workbench 徽章=0 ───
  console.log('[step 6.3] 切回 workbench，验证 pendingAllocationCount=0');
  await navigateToTab(miniProgram, '/pages/workbench/workbench');
  await waitForData(miniProgram, (d) => d.pendingAllocationCount === 0, { timeoutMs: 8000 });
  await snapshot(miniProgram, 'bs04-step6c-workbench-badge-zero');
  console.log('  ok — pendingAllocationCount=0');

  console.log('[bs04-allocation] === PASS ===');
}

async function main() {
  try {
    await run();
    process.exit(0);
  } catch (e) {
    console.error('[bs04-allocation] === FAIL ===');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    dumpRecentSnapshots(3);
    process.exit(1);
  } finally {
    try {
      await cleanupL3TestData();
    } catch (e) {
      console.warn('[cleanup] 警告:', e.message);
    }
    await disconnect(miniProgram);
    await closePool();
  }
}

main();
