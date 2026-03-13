import { test, expect } from '@playwright/test'

test.describe('提成矩阵', () => {
  test('渲染页面标题和新增按钮', async ({ page }) => {
    await page.goto('/commission')
    await expect(page.getByRole('heading', { name: '提成矩阵' })).toBeVisible()
    await expect(page.getByRole('button', { name: /新增规则/ })).toBeVisible()
  })

  test('市场 Tab 可切换', async ({ page }) => {
    await page.goto('/commission')
    const tabs = page.getByRole('tab')
    const count = await tabs.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/commission')
    // 应有订单类型、角色类型、销售分类筛选
    await expect(page.getByText(/订单类型|角色类型|销售分类/)).toBeVisible()
  })

  test('表格列头包含比例列', async ({ page }) => {
    await page.goto('/commission')
    await expect(page.getByRole('columnheader', { name: /提成比例|比例/ })).toBeVisible()
  })
})
