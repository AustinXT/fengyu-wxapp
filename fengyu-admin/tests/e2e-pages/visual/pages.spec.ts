import { test, expect } from '@playwright/test'

test.describe('视觉回归', () => {
  test('登录页', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    // dev server 冷编译时首屏可能稍慢，放宽可见性等待避免非确定性 flake
    await expect(page.getByText('凤御美业管理后台')).toBeVisible({ timeout: 15000 })
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
        // 侧边栏页脚含版本号 + commit sha（每次构建变化）→ mask 否则必漂移
        page.locator('[data-testid="build-version"]'),
      ],
    })
  })
})
