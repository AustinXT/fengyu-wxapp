import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://47.113.202.7:3000';
const PHONE = process.env.ADMIN_PHONE;
const PASS = process.env.ADMIN_PASS;
const OUT = '/Users/nv/proj.xt.com/fengyu-wxapp/docs/assets/手册';
mkdirSync(OUT, { recursive: true });

// name -> route. Order roughly matches the manual.
const PAGES = [
  ['01-工作台', '/dashboard'],
  ['02-组织架构', '/org'],
  ['03-门店管理-列表', '/stores'],
  ['04-门店管理-新建', '/stores/create'],
  ['05-员工管理-列表', '/employees'],
  ['06-员工管理-新建', '/employees/create'],
  ['07-权限管理', '/permissions'],
  ['08-品项分类', '/products/categories'],
  ['09-商品管理-列表', '/products'],
  ['10-商品管理-新建', '/products/create'],
  ['11-商城分类', '/mall/categories'],
  ['12-商城管理-列表', '/mall'],
  ['13-商城管理-新建', '/mall/create'],
  ['14-提成矩阵', '/commission'],
  ['15-优惠券-列表', '/coupons'],
  ['16-优惠券-新建', '/coupons/create'],
  ['17-会员权益', '/member-benefits'],
  ['18-系统配置', '/settings'],
  // 业务管理（可能需要店长角色）
  ['19-开单', '/orders/create'],
  ['20-订单管理', '/orders'],
  ['21-营业额分配', '/allocations'],
  ['22-服务单管理', '/services'],
  ['23-预约管理', '/appointments'],
  ['24-退款', '/refunds'],
  ['25-顾客管理', '/customers'],
  ['26-疗程卡管理', '/cards'],
  ['27-提货记录', '/pickup-records'],
  ['28-门店库存', '/inventory'],
  ['29-积分流水', '/points'],
  ['30-充值卡流水', '/card-transactions'],
  ['31-历史订单核对', '/legacy-orders'],
  ['32-操作日志', '/logs'],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// ---- login ----
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.getByPlaceholder('请输入手机号').fill(PHONE);
await page.getByPlaceholder('请输入密码').fill(PASS);
await page.locator('button[type=submit]').click();
await page.waitForTimeout(2500);
console.log('LOGIN -> ', page.url());
if (page.url().includes('/login')) {
  console.log('!! 登录失败，停止。');
  await browser.close();
  process.exit(2);
}

const captured = [], denied = [];
for (const [name, route] of PAGES) {
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1200);
    const url = page.url();
    if (url.includes('/login')) { denied.push(name); console.log('DENIED', name, route); continue; }
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    captured.push(name);
    console.log('OK    ', name);
  } catch (e) {
    denied.push(`${name}(err:${e.message.slice(0,40)})`);
    console.log('ERR   ', name, e.message.slice(0, 60));
  }
}

console.log('\n=== captured:', captured.length, '===');
console.log('=== denied/err:', denied.join(' | '));
await browser.close();
