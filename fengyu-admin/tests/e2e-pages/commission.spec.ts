import { test, expect } from '@playwright/test'

test.describe('提成矩阵', () => {
  test('渲染页面标题和新增按钮', async ({ page }) => {
    await page.goto('/commission')
    await expect(page.getByRole('heading', { name: '提成矩阵' })).toBeVisible()
    await expect(page.getByRole('button', { name: '新增规则' })).toBeVisible()
  })

  test('市场筛选 select 存在', async ({ page }) => {
    await page.goto('/commission')
    // 市场切换已从 Tab 改为原生 select 下拉
    expect(await page.locator('select').count()).toBeGreaterThanOrEqual(1)
  })

  test('筛选器为原生 select', async ({ page }) => {
    await page.goto('/commission')
    expect(await page.locator('select').count()).toBeGreaterThanOrEqual(3)
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/commission')
    await expect(page.getByRole('columnheader', { name: '订单类型' })).toBeVisible()
    // 列已更名 角色类型 → 技能标签
    await expect(page.getByRole('columnheader', { name: '技能标签' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '提成比例' })).toBeVisible()
  })
})
