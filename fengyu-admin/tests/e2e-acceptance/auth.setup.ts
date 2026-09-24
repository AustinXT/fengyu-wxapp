import { test as setup, expect } from '@playwright/test'
import path from 'path'

const authFile = path.resolve(process.cwd(), '.auth/acceptance.json')

setup('登录 dev admin', async ({ page }) => {
  setup.setTimeout(180_000)

  await page.goto('/login')
  await page.getByRole('button', { name: /登 录/ }).waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  await page.locator('#phone').click()
  // dev 库里没有 e2e-pages 用的 13900139000/fengyu2026；改用库存 E2E 留下的超管测试账号
  // （INVT-ADM-01 / 19900001001，must_change=false，admin 角色），只读浏览不改数据。
  await page.locator('#phone').pressSequentially('19900001001', { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('Invt@2026', { delay: 30 })
  await page.getByRole('button', { name: /登 录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 })
  await expect
    .poll(
      async () => (await page.context().cookies()).find((c) => c.name === 'fy-admin-token')?.value ?? null,
      { timeout: 15_000, message: 'fy-admin-token cookie 未在登录后出现' },
    )
    .not.toBeNull()
  await page.context().storageState({ path: authFile })
})
