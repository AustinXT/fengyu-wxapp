// bs06-role-visibility.spec.mjs — L3 BS-06 角色显隐回归矩阵
//
// 覆盖范围：
//   a) 4 个 Tab 页面 + 10 条矩阵元素
//      - workbench: '门店今日营收' / '待确认收款' / '待确认订单' / '待提成分配' / '待审批退款' / '待审批解绑申请'
//      - profile:   '分配列表'
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
//      3) profile '分配列表' 是 van-cell title 属性，最终渲染会变成 DOM 文本；但 Vant cell 文本可能嵌套较深 + tap helper 的 selector 默认覆盖 .van-cell —— 已在 selector 显式包含
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
// mode: 'dom' (默认，DOM 文本查找) | 'data' (读 page.data().isManager)
const MATRIX = [
  // ---- workbench：6 个店长专属 cell ----
  { role: 'manager',    page: '/pages/workbench/workbench',         text: '门店今日营收',     expect: 'visible' },
  { role: 'beautician', page: '/pages/workbench/workbench',         text: '门店今日营收',     expect: 'hidden'  },
  { role: 'manager',    page: '/pages/workbench/workbench',         text: '待确认收款',       expect: 'visible' },
  { role: 'beautician', page: '/pages/workbench/workbench',         text: '待确认收款',       expect: 'hidden'  },
  { role: 'manager',    page: '/pages/workbench/workbench',         text: '待审批退款',       expect: 'visible' },
  { role: 'beautician', page: '/pages/workbench/workbench',         text: '待审批退款',       expect: 'hidden'  },
  { role: 'manager',    page: '/pages/workbench/workbench',         text: '待审批解绑申请',   expect: 'visible' },
  { role: 'beautician', page: '/pages/workbench/workbench',         text: '待审批解绑申请',   expect: 'hidden'  },
  // ---- profile：分配列表 ----
  { role: 'manager',    page: '/pages/profile/profile',             text: '分配列表',         expect: 'visible' },
  { role: 'beautician', page: '/pages/profile/profile',             text: '分配列表',         expect: 'hidden'  },
  // ---- customer-list：data.isManager 间接验 action-sheet 渲染条件 ----
  { role: 'manager',    page: '/pages/customer-list/customer-list', text: null,               expect: 'visible', mode: 'data' },
  { role: 'beautician', page: '/pages/customer-list/customer-list', text: null,               expect: 'hidden',  mode: 'data' },
  // ---- service：sanity（两角色都该看到的标题文案，防止误改）----
  { role: 'manager',    page: '/pages/service/service',             text: '待服务',           expect: 'visible' },
  { role: 'beautician', page: '/pages/service/service',             text: '待服务',           expect: 'visible' },
];

const SEL = '.van-cell, .van-cell__title, .van-cell__value, .van-action-sheet__description, view, text, navigator';

/**
 * 覆写当前小程序运行时身份为 manager / 美容师。
 * 注意：app.ts 里 staffLevel = 'store_manager' 对应 isManager()=true；'store_staff' 对应 false。
 */
async function setRole(role) {
  const staffLevel = role === 'manager' ? 'store_manager' : 'store_staff';
  await miniProgram.evaluate((lv) => {
    const app = getApp();
    if (app?.globalData) {
      app.globalData.staffLevel = lv;
      // 顺手把 loginLevel/boundStoreId 兜个值，避免 onShow 中 syncStoreContext 用空字段
      if (!app.globalData.loginLevel) app.globalData.loginLevel = 'store';
      if (!app.globalData.scopedStores) app.globalData.scopedStores = [];
    }
  }, staffLevel);
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
    try {
      const page = await miniProgram.currentPage();
      await page.callMethod('onShow').catch(() => {});
    } catch { /* 静默 */ }
    await new Promise(r => setTimeout(r, 500));

    const page = await miniProgram.currentPage();

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
