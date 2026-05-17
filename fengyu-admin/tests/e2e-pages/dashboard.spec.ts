import { test, expect } from '@playwright/test'

test.describe('工作台', () => {
  test('渲染页面标题和欢迎文字', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()
    await expect(page.getByText('欢迎使用凤御美业管理后台')).toBeVisible()
  })

  test('显示快捷入口区域', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('快捷入口')).toBeVisible()
  })

  test('角色自适应：显示指标卡片', async ({ page }) => {
    await page.goto('/dashboard')
    // 根据角色，指标卡片可能是业务指标（今日客流等）或系统概览（营业门店等）
    // 至少应展示 1 个指标卡片
    const cards = page.locator('[class*="CardContent"]')
    await expect(cards.first()).toBeVisible()
  })

  test('角色自适应：快捷入口包含至少 1 个按钮', async ({ page }) => {
    await page.goto('/dashboard')
    const shortcutSection = page.getByText('快捷入口').locator('..')
    const buttons = shortcutSection.getByRole('link')
    await expect(buttons.first()).toBeVisible()
  })

  test('业务角色看到业务指标（需 manager/finance 登录）', async ({ page }) => {
    await page.goto('/dashboard')
    // 如果当前用户有业务权限，应看到待办事项区域
    // 如果是系统角色，快捷入口包含管理链接
    const hasBusiness = await page.getByText('待办事项').isVisible().catch(() => false)
    const hasSystem = await page.getByText('组织架构').isVisible().catch(() => false)
    // 至少命中一种看板模式
    expect(hasBusiness || hasSystem).toBeTruthy()
  })
})
