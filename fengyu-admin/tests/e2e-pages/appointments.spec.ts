import { test, expect } from '@playwright/test'

test.describe('预约管理', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/appointments')
    await expect(page.getByRole('heading', { name: '预约管理' })).toBeVisible()
  })

  // 注：状态筛选用 <button>（下划线高亮），非 ARIA tablist；选择器按实现走 button。
  test('4 个状态 Tab 完整', async ({ page }) => {
    await page.goto('/appointments')
    await expect(page.getByRole('button', { name: /待确认/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /已确认/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /今日/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /全部/ })).toBeVisible()
  })

  test('Tab 可切换', async ({ page }) => {
    await page.goto('/appointments')
    const confirmedTab = page.getByRole('button', { name: /已确认/ })
    await confirmedTab.click()
    // 选中态由 primary 高亮类表达（text-[var(--primary)]）
    await expect(confirmedTab).toHaveClass(/text-\[var\(--primary\)\]/)
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/appointments')
    await page.getByRole('button', { name: /全部/ }).click()
    await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '顾客' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '预约时间' })).toBeVisible()
  })
})
