import { test as setup, expect } from '@playwright/test'
import path from 'path'

// 与 playwright.config.ts 里 chromium project 的 storageState: '.auth/user.json'（相对 cwd=fengyu-admin/）对齐
const authFile = path.resolve(process.cwd(), '.auth/user.json')

setup('认证登录', async ({ page }) => {
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
})
