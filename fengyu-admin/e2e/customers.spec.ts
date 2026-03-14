import { test, expect } from '@playwright/test'

test.describe('顾客列表', () => {
  test('渲染页面标题和新建按钮', async ({ page }) => {
    await page.goto('/customers')
    await expect(page.getByRole('heading', { name: '顾客管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: '新增顾客' })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/customers')
    await expect(page.getByPlaceholder('搜索姓名 / 手机号')).toBeVisible()
    expect(await page.locator('select').count()).toBeGreaterThanOrEqual(2)
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/customers')
    await expect(page.getByRole('columnheader', { name: '姓名' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '手机号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '会员等级' })).toBeVisible()
  })

  test('搜索功能可用', async ({ page }) => {
    await page.goto('/customers')
    const search = page.getByPlaceholder('搜索姓名 / 手机号')
    await search.fill('李')
    await expect(search).toHaveValue('李')
  })
})
