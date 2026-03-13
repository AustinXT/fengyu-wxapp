import { test, expect } from '@playwright/test'

test.describe('门店列表', () => {
  test('渲染页面标题和新建按钮', async ({ page }) => {
    await page.goto('/stores')
    await expect(page.getByRole('heading', { name: '门店管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: /新增门店/ })).toBeVisible()
  })

  test('搜索框可用', async ({ page }) => {
    await page.goto('/stores')
    const search = page.getByPlaceholder(/搜索/)
    await expect(search).toBeVisible()
    await search.fill('南昌')
    await expect(search).toHaveValue('南昌')
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/stores')
    await expect(page.getByRole('columnheader', { name: '门店名称' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /状态/ })).toBeVisible()
  })

  test('分页组件可见', async ({ page }) => {
    await page.goto('/stores')
    // 分页区域
    const pagination = page.locator('[class*="pagination"], nav[aria-label]')
    await expect(pagination.first()).toBeVisible()
  })
})

test.describe('门店编辑', () => {
  test('渲染返回按钮和表单', async ({ page }) => {
    await page.goto('/stores/store-nc01/edit')
    await expect(page.getByRole('button', { name: /返回/ })).toBeVisible()
    await expect(page.getByText('基本信息')).toBeVisible()
  })

  test('表单分组完整', async ({ page }) => {
    await page.goto('/stores/store-nc01/edit')
    await expect(page.getByText('基本信息')).toBeVisible()
    await expect(page.getByText('地理位置')).toBeVisible()
    await expect(page.getByText('展示内容')).toBeVisible()
  })

  test('基本信息字段可编辑', async ({ page }) => {
    await page.goto('/stores/store-nc01/edit')
    const nameInput = page.getByLabel(/门店名称/)
    await expect(nameInput).toBeVisible()
  })

  test('保存和取消按钮可见', async ({ page }) => {
    await page.goto('/stores/store-nc01/edit')
    await expect(page.getByRole('button', { name: /保存/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /取消/ })).toBeVisible()
  })
})
