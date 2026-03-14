import { test, expect } from '@playwright/test'

test.describe('操作日志', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/logs')
    await expect(page.getByRole('heading', { name: '操作日志' })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/logs')
    await expect(page.getByPlaceholder('搜索操作人')).toBeVisible()
    // 操作类型 select + 日期范围 inputs
    expect(await page.locator('select').count()).toBeGreaterThanOrEqual(1)
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/logs')
    await expect(page.getByRole('columnheader', { name: '时间' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '操作人' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '操作', exact: true })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '目标' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '详情' })).toBeVisible()
  })
})
