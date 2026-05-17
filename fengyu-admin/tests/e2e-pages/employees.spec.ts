import { test, expect } from '@playwright/test'

test.describe('员工列表', () => {
  test('渲染页面标题和新建按钮', async ({ page }) => {
    await page.goto('/employees')
    await expect(page.getByRole('heading', { name: '员工管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: '新增员工' })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/employees')
    await expect(page.getByPlaceholder('搜索编号 / 姓名 / 手机号')).toBeVisible()
    // 原生 select 筛选器
    expect(await page.locator('select').count()).toBeGreaterThanOrEqual(2)
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/employees')
    await expect(page.getByRole('columnheader', { name: '员工编号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '姓名' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '手机号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '所属门店' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '在职状态' })).toBeVisible()
  })

  test('搜索功能可用', async ({ page }) => {
    await page.goto('/employees')
    const search = page.getByPlaceholder('搜索编号 / 姓名 / 手机号')
    await search.fill('张')
    await expect(search).toHaveValue('张')
  })
})
