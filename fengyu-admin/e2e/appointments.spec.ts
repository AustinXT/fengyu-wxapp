import { test, expect } from '@playwright/test'

test.describe('预约管理', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/appointments')
    await expect(page.getByRole('heading', { name: '预约管理' })).toBeVisible()
  })

  test('4 个状态 Tab 完整', async ({ page }) => {
    await page.goto('/appointments')
    await expect(page.getByRole('tab', { name: /待确认/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /已确认/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /今日/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /全部/ })).toBeVisible()
  })

  test('Tab 切换正常', async ({ page }) => {
    await page.goto('/appointments')
    await page.getByRole('tab', { name: /已确认/ }).click()
    await expect(page.getByRole('tab', { name: /已确认/ })).toHaveAttribute('data-state', 'active')
  })

  test('全部 Tab 显示表格', async ({ page }) => {
    await page.goto('/appointments')
    await page.getByRole('tab', { name: /全部/ }).click()
    await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '顾客' })).toBeVisible()
  })
})
