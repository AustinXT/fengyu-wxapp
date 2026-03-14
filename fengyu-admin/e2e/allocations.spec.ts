import { test, expect } from '@playwright/test'

test.describe('营业额分配列表', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/allocations')
    await expect(page.getByRole('heading', { name: '营业额分配' })).toBeVisible()
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/allocations')
    await expect(page.getByRole('columnheader', { name: '订单号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '分配状态' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '顾客' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '订单金额' })).toBeVisible()
  })
})
