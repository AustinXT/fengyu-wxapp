import { test as setup, expect } from '@playwright/test'
import path from 'path'

// 与 playwright.config.ts 里 chromium project 的 storageState: '.auth/user.json'（相对 cwd=fengyu-admin/）对齐
const authFile = path.resolve(process.cwd(), '.auth/user.json')

setup('认证登录 + 路由预热', async ({ page }) => {
  // 预热需逐条触发 next dev 按需编译，给足时长（登录 ~20s + 各路由首次编译）
  setup.setTimeout(600_000)

  await page.goto('/login')
  // 等待按钮可交互（确认 hydration 完成）
  await page.getByRole('button', { name: /登 录/ }).waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  // 使用 type 逐字输入，兼容 React 受控组件
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially('13900139000', { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('fengyu2026', { delay: 30 })
  await page.getByRole('button', { name: /登 录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 15000 })
  // 等待 fy-admin-token cookie 出现（Server Action 的 Set-Cookie 与 client navigation 异步）
  await expect.poll(
    async () => (await page.context().cookies()).find((c) => c.name === 'fy-admin-token')?.value ?? null,
    { timeout: 10000, message: 'fy-admin-token cookie 未在登录后出现' },
  ).not.toBeNull()
  await page.context().storageState({ path: authFile })

  // ── 路由预热（route pre-warm）──
  // next dev 按需编译：用例首次访问未编译路由会触发 >15s navigationTimeout/actionTimeout，
  // e2e-pages 全并行时哪条用例先撞到冷路由是非确定的 → 零星 nav 用例随机 flaky。
  // 这里用已登录页**顺序**访问各路由，提前在运行中的 dev server 里把它们编译好，后续所有
  // chromium 用例（依赖本 setup）即落在已编译页面上。
  // 注意：必须顺序而非并行——并行会让 dev 编译器同时被多路由争抢、反而放大超时（即要消除的现象）。
  // 预热失败不致命（不 throw，仅 warn），避免单个慢路由拖垮整个 setup。
  const warmRoutes = [
    '/dashboard', '/orders', '/orders/create', '/orders/create-deposit',
    '/allocations', '/services', '/appointments',
    '/products', '/products/create', '/products/categories',
    '/customers', '/employees', '/employees/create',
    '/stores', '/stores/create', '/commission', '/org',
    '/coupons', '/coupons/create', '/permissions', '/refunds',
    '/logs', '/settings',
  ]
  for (const route of warmRoutes) {
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    } catch (e) {
      console.warn(`[warm] ${route} 预热失败（忽略）: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  console.log(`[warm] 路由预热完成：${warmRoutes.length} 条`)
})
