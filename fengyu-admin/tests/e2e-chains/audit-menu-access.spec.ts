/**
 * 全角色 × 菜单可见页 的 403 体检
 *
 * 原则：menu.ts 配置的 requiredRoles 给某角色看到 sidebar 链接 → 该角色点进必须正常渲染，
 *       不能 ErrorBoundary 500 / 不能 PERMISSION_DENIED。
 *
 * 输出：每对 (role, path) 的状态码 + body 是否含 "服务异常"/"权限不足"/"500"。
 *
 * 注：只检 page.tsx 入口（GET），不模拟点按钮触发 server action（那是其他链路的事）。
 */
import { test } from '@playwright/test'
import { BASE, TEST_PHONES, login } from './_helpers/scope-helpers'

test.setTimeout(900_000)

// 按 menu.ts 严格抽出角色 → 应可见的链接（requiredRoles + readonlyRoles 并集）
const MENU: Record<string, string[]> = {
  admin: [
    '/dashboard',
    '/legacy-orders',
    '/org', '/stores', '/employees', '/products', '/mall', '/commission',
    '/coupons', '/member-benefits',
    '/points', '/card-transactions',
    '/permissions', '/settings/permission-matrix', '/messages', '/logs', '/settings',
  ],
  manager: [
    '/dashboard',
    '/orders/create', '/orders', '/legacy-orders', '/allocations',
    '/services', '/appointments', '/pickup-records', '/store-unbind', '/inventory',
    '/customers', '/cards', '/points', '/card-transactions',
  ],
  finance: [
    '/dashboard',
    '/orders',              // readonly
    '/allocations',         // readonly
    '/pickup-records',      // readonly
    '/inventory',           // readonly
    '/customers',           // readonly
    '/cards',               // readonly
    '/points',              // readonly
    '/card-transactions',   // readonly
  ],
  hr: [
    '/dashboard',
    '/org', '/stores', '/employees', '/permissions',
  ],
  product: [
    '/dashboard',
    '/products', '/mall', '/coupons',
    '/inventory',           // readonly
  ],
  customer_mgr: [
    '/dashboard',
    '/customers', '/cards',
  ],
}

// 深度链接：列表页点"详情"会跳的 sub-route 也应该对该角色可达
// 用真实 fixture id 注入
const DETAIL_LINKS: Record<string, string[]> = {
  admin: [
    '/employees/FY-TEST-MGR',   // 员工详情
    '/employees/create',         // 新增员工表单
    '/stores/store-nc01/edit',   // 门店编辑（[id]/edit 路由）
    '/stores/create',            // 新建门店
  ],
  manager: [
    '/customers/FY-FIX-CLIENT-01',
    '/orders/create',
  ],
  finance: [
    '/customers/FY-FIX-CLIENT-01',  // readonly 顾客详情
  ],
  hr: [
    '/employees/FY-TEST-MGR',
    '/employees/create',
  ],
  customer_mgr: [
    '/customers/FY-FIX-CLIENT-01',
  ],
}

const PHONE: Record<string, string> = {
  admin: TEST_PHONES.ADM,
  manager: TEST_PHONES.MGR,
  finance: TEST_PHONES.FIN,
  hr: TEST_PHONES.HR,
  product: TEST_PHONES.PRD,
  customer_mgr: TEST_PHONES.CSM,
}

// 登录重试已下沉为共享 helper login() 的标准行为（scope-helpers.ts）。
// 本 spec 在单个 test 内串行登录 6 个角色 + 探测 ~80 个页面，dev server（单 worker
// Turbopack 冷编译 + 多 browser context）偶发使「提交→middleware→/dashboard」跳转滞留
// /login —— 共享 login() 内部已用 3 次重试包裹该竞态，不弱化任何 403/500 页面断言。

async function probePage(page: import('@playwright/test').Page, path: string): Promise<{
  status: number
  errorBoundary: boolean
  permDenied: boolean
  badge: '✅' | '❌'
  detail: string
}> {
  let resp = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => null)
  await page.waitForTimeout(800)
  let status = resp?.status() ?? 0
  // status=0 = 导航被 abort / dev server 抖动（非权限拒绝）。与真正的 403/500 区分：
  // reload 一次再判定，避免把「导航抖动」误记为 ❌ 权限拒绝。
  if (status === 0) {
    console.log(`  ↻  [retry] ${path} navigation returned status=0, reloading once...`)
    resp = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => null)
    await page.waitForTimeout(800)
    status = resp?.status() ?? 0
  }
  const body = (await page.textContent('body').catch(() => '')) || ''
  // ErrorBoundary 的 marker：admin 仓库统一的 "服务异常" + "错误编号:"
  const errorBoundary = body.includes('服务异常') && body.includes('错误编号:')
  // 仅匹配可见拒绝文案
  const permDenied = /无权执行|无权限|没有权限|权限不足|访问受限/.test(body)
  const ok = !errorBoundary && !permDenied && status === 200
  return {
    status,
    errorBoundary,
    permDenied,
    badge: ok ? '✅' : '❌',
    detail: errorBoundary ? 'ErrorBoundary' : permDenied ? 'permDenied' : status === 200 ? 'OK' : `status=${status}`,
  }
}

test('audit-403：全角色 × 菜单可见页', async ({ browser }) => {
  const results: Array<{ role: string; path: string; badge: string; detail: string }> = []

  for (const role of Object.keys(MENU)) {
    console.log(`\n────────── ${role} ──────────`)
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    try {
      await login(page, PHONE[role])
      // 1) menu sidebar 可见的顶层链接
      for (const path of MENU[role]) {
        const r = await probePage(page, path)
        console.log(`  ${r.badge}  [menu] ${path.padEnd(36)} status=${r.status} ${r.detail}`)
        results.push({ role, path, badge: r.badge, detail: r.detail })
      }
      // 2) 深度链接（列表里点详情等）
      for (const path of (DETAIL_LINKS[role] || [])) {
        const r = await probePage(page, path)
        console.log(`  ${r.badge}  [deep] ${path.padEnd(36)} status=${r.status} ${r.detail}`)
        results.push({ role, path, badge: r.badge, detail: r.detail })
      }
    } finally {
      await ctx.close()
    }
  }

  console.log('\n────────── SUMMARY ──────────')
  const fails = results.filter((r) => r.badge === '❌')
  console.log(`Total: ${results.length}, Fail: ${fails.length}`)
  if (fails.length) {
    console.log('Failing:')
    for (const f of fails) console.log(`  ${f.role.padEnd(15)} ${f.path.padEnd(40)} ${f.detail}`)
  }
})
