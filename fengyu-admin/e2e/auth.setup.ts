import { test as setup, expect } from '@playwright/test'
import path from 'path'

const authFile = path.join(__dirname, '../.auth/user.json')

setup('认证登录', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('手机号').fill('13800138000')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: /登 录/ }).click()
  await page.waitForURL('/dashboard')
  await page.context().storageState({ path: authFile })
})
