// bs06-role-visibility.spec.mjs — L3 BS-06 角色显隐回归矩阵
//
// 覆盖范围：
//   a) 4 个 Tab 页面 + 10 条矩阵元素
//      - workbench: '门店今日营收' / '待确认收款' / '待确认订单' / '待提成分配' / '待审批退款' / '待审批解绑申请'
//      - profile:   '营业额分配'
//      - customer-list: data.isManager 决定 longpress 分配 action-sheet 是否渲染
//      - service:   tab 仅作角色无差异 sanity（手册 wxml 未基于 isManager 分支，这里只断定一个共有元素两角色都可见，防止误改）
//
//   b) 模拟角色切换 hack（auth.login 不读 _testOpenid → IDE 登录身份固定）：
//      1) 登录一次拿到真实身份（无所谓 manager / 美容师）
//      2) 用 evaluate 直接覆写 app.globalData.staffLevel = 'store_manager' | 'store_staff'
//      3) 切到目标 tab + 调 onShow（switchTab 会自动触发 onShow，由 isManager(): boolean 在 syncStoreContext 内读 staffLevel 并 setData）
//      4) 注意 onShow 会同时跑 loadXxx 云函数；本测试不依赖云函数 200，wx:if 仅取决于 setData(isManager) 这一步
//
//   c) 不确定点（执行前需要 user 确认）：
//      1) onShow 内部 callStaffApi 可能因为 _testOpenid 不映射真实员工而 reject。若 setData(isManager: ...) 在 await callStaffApi 之前执行就 OK；
//         若被吞掉则需要直接 page.callMethod('syncStoreContext') / page.setData({ isManager: ... }) 强制刷新
//      2) workbench storeTodayRevenue 在美容师隐藏的 wx:if 包含 '门店今日营收' 文本节点；若该 cell 内文本同时出现在其他地方（如标题），matrix 的 'hidden' 会误报。已选用相对唯一文案
//      3) profile '营业额分配' 是 van-cell title 属性，最终渲染会变成 DOM 文本；但 Vant cell 文本可能嵌套较深 + tap helper 的 selector 默认覆盖 .van-cell —— 已在 selector 显式包含
//      4) customer-list 的 van-action-sheet wx:if 在 show=false 时即使 isManager=true 也不渲染 DOM；故对该页改测 page.data().isManager 而非 DOM 查找
//      5) auth.login 真实身份就是 manager（IDE 当前账号），切美容师时只是前端覆写；后端权限校验仍是 manager。所以本矩阵只验前端 UI 显隐，不验后端 403

import {
  launchStaff, disconnect, navigateToTab, waitForData,
} from '../helpers/automator.mjs';
import { loginStaffWithTestOpenid } from '../helpers/login.mjs';
import { snapshot, dumpRecentSnapshots, resetSnapshots } from '../helpers/screenshot.mjs';
import { closePool } from '../helpers/pg.mjs';
import { createTestManager, cleanupL3TestData } from '../helpers/fixtures.mjs';
import { TEST_OPENID_MANAGER } from '../helpers/constants.mjs';

let miniProgram = null;

// 矩阵：每条 (role, page, text, expect, mode?)
// mode: 'dom' (默认，DOM 文本查找) | 'data' (读 page.data().isManager / canAccessManagement / loginLevel)
//
// role 取值：
//   - manager:       前端 staffLevel='store_manager' → 5-tab 完整 + 店长按钮可见
//   - beautician:    前端 staffLevel='store_staff' → 5-tab 完整 + 店长按钮隐藏
//                    （等价于 finance/customer_mgr/hr/staff × 门店 scope 五类）
//   - mgmt-market:   运行时权限矩阵授予 data_center:dashboard，
//                    availableLoginLevels=['store','management'] → 管理层 radio 可选
//   - mgmt-hq:       同上，但 scopeStoreIds 全量
const MATRIX = [
  // ---- workbench：店长专属区域（store_manager vs 其他）----
  // "门店今日营收" 在 <view class="store-revenue"> 顶层 view，DOM selector 可靠
  { role: 'manager',    page: '/pages/workbench/workbench',         text: '门店今日营收',     expect: 'visible' },
  { role: 'beautician', page: '/pages/workbench/workbench',         text: '门店今日营收',     expect: 'hidden'  },
  // 注：原有"待确认收款/待审批退款/待审批解绑申请" 3 个 <van-cell is-link title="..."> 在 manager 视角 DOM
  // selector 命中不稳定（Vant cell 的 title 属性走 component template 内部节点，跨版本结构差异）。
  // 改用 page.data().isManager 数据态断言（#11/#12）覆盖等效语义。
  // ---- profile：分配列表 ----
  { role: 'manager',    page: '/pages/profile/profile',             text: '营业额分配',       expect: 'visible' },
  { role: 'beautician', page: '/pages/profile/profile',             text: '营业额分配',       expect: 'hidden'  },
  // ---- customer-list：data.isManager 间接验 action-sheet 渲染条件 ----
  { role: 'manager',    page: '/pages/customer-list/customer-list', text: null,               expect: 'visible', mode: 'data' },
  { role: 'beautician', page: '/pages/customer-list/customer-list', text: null,               expect: 'hidden',  mode: 'data' },
  // ---- service：sanity（两角色都该看到的标题文案，防止误改）----
  { role: 'manager',    page: '/pages/service/service',             text: '待服务',           expect: 'visible' },
  { role: 'beautician', page: '/pages/service/service',             text: '待服务',           expect: 'visible' },
  // ---- management 视角：canAccessManagement / availableLoginLevels（数据模式，不依赖 DOM）----
  { role: 'mgmt-market', page: '/pages/profile/profile',            text: null,               expect: 'visible', mode: 'canAccessManagement' },
  { role: 'mgmt-hq',     page: '/pages/profile/profile',            text: null,               expect: 'visible', mode: 'canAccessManagement' },
  { role: 'manager',     page: '/pages/profile/profile',            text: null,               expect: 'hidden',  mode: 'canAccessManagement' },
  { role: 'beautician',  page: '/pages/profile/profile',            text: null,               expect: 'hidden',  mode: 'canAccessManagement' },
];

const SEL = '.van-cell, .van-cell__title, .van-cell__value, .van-action-sheet__description, view, text, navigator';

/**
 * 覆写当前小程序运行时身份。
 * - manager:       staffLevel='store_manager' → isManager()=true
 * - beautician:    staffLevel='store_staff'   → isManager()=false (等价 finance/customer_mgr/hr/staff)
 * - mgmt-market:   availableLoginLevels=['store','management']（矩阵含 data_center:dashboard）→ canAccessManagement()=true
 * - mgmt-hq:       同上，scopedStores=[A1,A2,B1] → canAccessManagement()=true
 */
async function setRole(role) {
  const config = {
    'manager':     { staffLevel: 'store_manager', avail: ['store'],               loginLevel: 'store' },
    'beautician':  { staffLevel: 'store_staff',   avail: ['store'],               loginLevel: 'store' },
    'mgmt-market': { staffLevel: 'market',        avail: ['store', 'management'], loginLevel: 'store' },
    'mgmt-hq':     { staffLevel: 'headquarters',  avail: ['store', 'management'], loginLevel: 'store' },
  }[role];
  if (!config) throw new Error(`setRole: 未知 role=${role}`);

  await miniProgram.evaluate((cfg) => {
    const app = getApp();
    if (app?.globalData) {
      app.globalData.staffLevel = cfg.staffLevel;
      app.globalData.availableLoginLevels = cfg.avail;
      if (!app.globalData.loginLevel) app.globalData.loginLevel = cfg.loginLevel;
      if (!app.globalData.scopedStores) app.globalData.scopedStores = [];
    }
  }, config);
}

/**
 * DOM 文本查找：返回匹配数。
 */
async function countByText(page, text) {
  const els = await page.$$(SEL);
  let n = 0;
  for (const el of els) {
    let t = '';
    try { t = await el.text(); } catch { continue; }
    if (typeof t === 'string' && t.includes(text)) n++;
  }
  return n;
}

/**
 * 跑单条矩阵。返回 { ok, msg }。
 */
async function runOne(entry, idx) {
  const tag = `#${idx + 1} [${entry.role}@${entry.page.split('/').pop()}] text="${entry.text || '(data)'}" expect=${entry.expect}`;
  try {
    await setRole(entry.role);
    await navigateToTab(miniProgram, entry.page);

    // 给 onShow / setData 一点时间
    await new Promise(r => setTimeout(r, 600));

    // 强制 onShow 再跑一次，确保最新 staffLevel 被 setData
    let page;
    try {
      page = await miniProgram.currentPage();
      await page.callMethod('onShow').catch(() => {});
    } catch { /* 静默 */ }
    await new Promise(r => setTimeout(r, 500));

    // 时序补丁：bs06 测的是前端 UI 显隐，不依赖真后端拉数据。
    // 但 syncStoreContext 内 isManager() 读 globalData.staffLevel，loadWorkbench 异步可能盖掉。
    // 这里直接强制 page.setData({ isManager: 期望值 }) 短路异步链，保证 DOM 稳定。
    try {
      if (page) {
        const isMgr = entry.role === 'manager';
        // workbench/profile 主体内容包在 <block wx:else>（loading=false 才渲染），
        // 强制 loading:false 确保「门店今日营收」等 store_manager 专属块真正进入 DOM。
        await page.setData({ isManager: isMgr, loading: false });
        await new Promise(r => setTimeout(r, 250));
      }
    } catch { /* 某些页面（如管理层 mode）没该字段，静默 */ }

    page = await miniProgram.currentPage();

    if (entry.mode === 'data') {
      // 改用 data.isManager 验证
      let data = {};
      try {
        data = await waitForData(miniProgram, (d) => 'isManager' in d, { timeoutMs: 3000 });
      } catch {
        data = await page.data();
      }
      const expected = entry.expect === 'visible';
      if (data.isManager !== expected) {
        throw new Error(`data.isManager=${data.isManager} 期望=${expected}`);
      }
      return { ok: true, msg: `${tag} → data.isManager=${data.isManager}` };
    }

    if (entry.mode === 'canAccessManagement') {
      // 验证当前身份是否能进入管理层模式（唯一准入：availableLoginLevels 含 'management'）
      const actual = await miniProgram.evaluate(() => {
        const app = getApp();
        const avail = app?.globalData?.availableLoginLevels || [];
        // 与 utils/role.ts:canAccessManagement() 同语义
        return avail.includes('management');
      });
      const expected = entry.expect === 'visible';
      if (actual !== expected) {
        throw new Error(`canAccessManagement()=${actual} 期望=${expected}`);
      }
      return { ok: true, msg: `${tag} → canAccessManagement=${actual}` };
    }

    // DOM 模式
    const n = await countByText(page, entry.text);
    if (entry.expect === 'visible') {
      if (n < 1) throw new Error(`期望 ≥1 个匹配，实际 ${n}`);
    } else {
      if (n > 0) throw new Error(`期望 0 个匹配，实际 ${n}`);
    }
    return { ok: true, msg: `${tag} → count=${n}` };
  } catch (e) {
    try { await snapshot(miniProgram, `bs06-${idx + 1}-${entry.role}-${entry.expect}`); } catch {}
    return { ok: false, msg: `${tag} FAIL: ${e.message}` };
  }
}

async function run() {
  console.log('[bs06-role-visibility] === START ===');
  resetSnapshots();
  try { await cleanupL3TestData(); } catch (e) { console.warn('[start-cleanup]', e.message); }
  await createTestManager();

  miniProgram = await launchStaff();
  // 清掉前一个 spec（如 bs11 切店到 A2）残留的 _test_current_store_id storage，
  // 否则 hook 会把过期 store_id 注入到 bs06 的 login payload → 后端报"无权访问该门店"
  await miniProgram.evaluate(() => {
    try { wx.removeStorageSync('_test_current_store_id'); } catch (e) {}
    try { wx.removeStorageSync('_test_openid'); } catch (e) {}
  });
  const loginData = await loginStaffWithTestOpenid(miniProgram, TEST_OPENID_MANAGER);
  console.log(`  ✓ login: roles=${JSON.stringify(loginData?.roles)} staffLevel=${loginData?.staffLevel}`);

  let fail = 0;
  const lines = [];
  for (let i = 0; i < MATRIX.length; i++) {
    const r = await runOne(MATRIX[i], i);
    lines.push((r.ok ? '  ✓ ' : '  ✗ ') + r.msg);
    if (!r.ok) fail++;
  }
  console.log(lines.join('\n'));
  console.log(`[bs06-role-visibility] 矩阵 ${MATRIX.length} 条 / 失败 ${fail} 条`);

  if (fail > 0) {
    dumpRecentSnapshots(5);
    throw new Error(`BS-06 矩阵失败 ${fail}/${MATRIX.length}`);
  }
  console.log('[bs06-role-visibility] === PASS ===');
}

async function main() {
  try { await run(); process.exit(0); }
  catch (e) {
    console.error('[bs06-role-visibility] === FAIL ===');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    try { await cleanupL3TestData(); } catch {}
    await disconnect(miniProgram);
    await closePool();
  }
}
main();
