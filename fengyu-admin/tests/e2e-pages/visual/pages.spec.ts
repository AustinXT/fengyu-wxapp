import { test, expect } from '@playwright/test'

test.describe('视觉回归', () => {
  test('登录页', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByText('凤御美业管理后台')).toBeVisible()
    await expect(page).toHaveScreenshot('login.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    })
  })

  test('工作台', async ({ page }) => {
    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('dashboard.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
      mask: [
        page.locator('[data-testid="today-date"]'),
      ],
    })
  })
})
