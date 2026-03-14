import { test, expect } from '@playwright/test'

test.describe('工作台', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()
  })

  test('显示欢迎文字', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('欢迎使用凤御美业管理后台')).toBeVisible()
  })

  test('显示 4 个核心指标卡片', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('今日客流')).toBeVisible()
    await expect(page.getByText('今日业绩')).toBeVisible()
    await expect(page.getByText('待处理订单')).toBeVisible()
    await expect(page.getByText('待确认预约')).toBeVisible()
  })

  test('显示待办事项区域', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('待办事项')).toBeVisible()
  })

  test('显示快捷入口区域', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('快捷入口')).toBeVisible()
  })

  test('快捷入口包含 4 个按钮', async ({ page }) => {
    await page.goto('/dashboard')
    const shortcuts = page.locator('text=快捷入口').locator('..')
    await expect(shortcuts.getByText('开单')).toBeVisible()
    await expect(shortcuts.getByText('订单管理')).toBeVisible()
    await expect(shortcuts.getByText('顾客管理')).toBeVisible()
    await expect(shortcuts.getByText('员工管理')).toBeVisible()
  })
})
