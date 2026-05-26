import { test, expect } from '@playwright/test'

test.describe('门店列表', () => {
  test('渲染页面标题和新建按钮', async ({ page }) => {
    await page.goto('/stores')
    await expect(page.getByRole('heading', { name: '门店管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: '新增门店' })).toBeVisible()
  })

  test('搜索框可用', async ({ page }) => {
    await page.goto('/stores')
    const search = page.getByPlaceholder('搜索门店名称 / 电话')
    await expect(search).toBeVisible()
    await search.fill('南昌')
    await expect(search).toHaveValue('南昌')
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/stores')
    await expect(page.getByRole('columnheader', { name: '门店名称' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '所属市场' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '营业状态' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '床位数' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '联系电话' })).toBeVisible()
  })
})
