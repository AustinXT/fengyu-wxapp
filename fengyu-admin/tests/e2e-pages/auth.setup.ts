import { test as setup, expect } from '@playwright/test'
import path from 'path'

const authFile = path.join(__dirname, '../.auth/user.json')

setup('认证登录', async ({ page }) => {
  await page.goto('/login')
  // 等待按钮可交互（确认 hydration 完成）
  await page.getByRole('button', { name: /登 录/ }).waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  // 使用 type 逐字输入，兼容 React 受控组件
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially('13800138000', { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('admin123', { delay: 30 })
  await page.getByRole('button', { name: /登 录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 15000 })
  await page.context().storageState({ path: authFile })
})
