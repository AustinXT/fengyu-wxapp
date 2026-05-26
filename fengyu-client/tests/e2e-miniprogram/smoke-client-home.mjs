// smoke-client-home.mjs — L3 链路连通性 hello-world
//
// 目标：验证 IDE + automator + 项目加载这条链路通畅。
// 不依赖远端 ALLOW_TEST_OPENID（无需登录即可断言公开页面渲染）。
//
// 流程：
//   1. ensureIdeReady（端口检测）
//   2. automator.launch(client miniprogram)
//   3. reLaunch('/pages/home/home')
//   4. 等首屏渲染完，evaluate 拿页面 data 做基本断言
//   5. disconnect（保留 IDE 进程）

import { launchClient, disconnect } from './helpers/automator.mjs';
import { PAGE_TIMEOUT_MS } from './helpers/constants.mjs';

let miniProgram = null;

async function run() {
  console.log('[smoke-client-home] === START ===');
  console.log('[smoke-client-home] step 1: launch client miniprogram');
  miniProgram = await launchClient();
  console.log('[smoke-client-home]   ok — miniProgram connected');

  console.log('[smoke-client-home] step 2: reLaunch to /pages/home/home');
  // reLaunch 是顶级 tabBar 页面的安全跳转方式
  await miniProgram.reLaunch('/pages/home/home');

  console.log('[smoke-client-home] step 3: waitFor page ready');
  const page = await miniProgram.currentPage();
  if (!page) throw new Error('currentPage() 返回空');
  console.log('[smoke-client-home]   currentPage path =', page.path);

  // 简单等一会让首屏组件渲染（banner / 商品列表通过网络/云函数拉，可能慢）
  await new Promise((r) => setTimeout(r, 2000));

  console.log('[smoke-client-home] step 4: evaluate global env');
  const probe = await miniProgram.evaluate(() => {
    const app = getApp();
    return {
      hasApp: !!app,
      hasGlobalData: !!(app && app.globalData),
      hasWxCloud: typeof wx !== 'undefined' && typeof wx.cloud === 'object',
      pagesStackLength: getCurrentPages().length,
      currentRoute: getCurrentPages().slice(-1)[0]?.route || null,
    };
  });
  console.log('[smoke-client-home]   probe =', JSON.stringify(probe));

  if (!probe.hasApp) throw new Error('getApp() 返回空，小程序未正确加载');
  if (!probe.hasWxCloud) throw new Error('wx.cloud 不可用，云开发未初始化');
  if (!probe.currentRoute || !probe.currentRoute.includes('home')) {
    throw new Error(`当前页路由异常: ${probe.currentRoute}`);
  }

  console.log('[smoke-client-home] step 5: read page data (非必须 — 演示)');
  try {
    const pageData = await page.data();
    const keys = Object.keys(pageData || {}).slice(0, 10);
    console.log('[smoke-client-home]   page.data keys =', keys.join(','));
  } catch (e) {
    // 不致命 — 部分页面 data getter 可能因运行时差异失败
    console.warn('[smoke-client-home]   warn: page.data() 读取失败 (非致命):', e.message);
  }

  console.log('[smoke-client-home] === PASS ===');
}

async function main() {
  try {
    await run();
    process.exit(0);
  } catch (e) {
    console.error('[smoke-client-home] === FAIL ===');
    console.error(e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  } finally {
    await disconnect(miniProgram);
  }
}

main();
