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

  test('分配状态筛选改写 URL 且跨 Tab 保留', async ({ page }) => {
    await page.goto('/allocations')

    const statusSelect = page.locator('select').first()
    await statusSelect.selectOption('待分配')
    await expect(page).toHaveURL(/allocStatus=%E5%BE%85%E5%88%86%E9%85%8D|allocStatus=待分配/)

    // 切到服务提成 Tab，allocStatus 应保留
    await page.getByRole('tab', { name: '服务提成' }).click()
    await expect(page).toHaveURL(/tab=service/)
    await expect(page).toHaveURL(/allocStatus=%E5%BE%85%E5%88%86%E9%85%8D|allocStatus=待分配/)
    await expect(page.getByRole('columnheader', { name: '服务单号' })).toBeVisible()
  })
})
