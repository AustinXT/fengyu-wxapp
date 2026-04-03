import { test, expect } from '@playwright/test'

test.describe('商品列表', () => {
  test('渲染页面标题和操作按钮', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByRole('heading', { name: '商品管理' })).toBeVisible()
    await expect(page.getByText('新增商品')).toBeVisible()
    await expect(page.getByRole('button', { name: '品项分类' })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByPlaceholder(/搜索/)).toBeVisible()
    expect(await page.locator('select').count()).toBeGreaterThanOrEqual(1)
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByRole('columnheader', { name: /商品名称/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /标价/ })).toBeVisible()
  })

  test('品项分类导航', async ({ page }) => {
    await page.goto('/products')
    await page.getByRole('button', { name: '品项分类' }).click()
    await expect(page).toHaveURL(/\/products\/categories/)
  })
})

test.describe('品项分类', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/products/categories')
    await expect(page.getByRole('heading', { name: /品项分类/ })).toBeVisible()
  })

  test('5 个 product_kind Tab 完整', async ({ page }) => {
    await page.goto('/products/categories')
    await expect(page.getByRole('tab', { name: /组合套餐/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /护理项目/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /家居产品/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /充值卡/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /体验卡/ })).toBeVisible()
  })

  test('Tab 切换正常', async ({ page }) => {
    await page.goto('/products/categories')
    await page.getByRole('tab', { name: /护理项目/ }).click()
    await expect(page.getByRole('tab', { name: /护理项目/ })).toHaveAttribute('aria-selected', 'true')
  })

  test('新增分类按钮可见', async ({ page }) => {
    await page.goto('/products/categories')
    await expect(page.getByRole('button', { name: /新增分类/ })).toBeVisible()
  })
})

test.describe('新增商品', () => {
  test('渲染返回按钮和表单', async ({ page }) => {
    await page.goto('/products/create')
    await expect(page.getByRole('button', { name: /返回/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /新增商品/ })).toBeVisible()
  })

  test('表单分组完整', async ({ page }) => {
    await page.goto('/products/create')
    await expect(page.getByText('基本信息')).toBeVisible()
    await expect(page.getByText(/价格/)).toBeVisible()
  })

  test('提交按钮可见', async ({ page }) => {
    await page.goto('/products/create')
    await expect(page.getByRole('button', { name: /创建商品/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /取消/ })).toBeVisible()
  })
})
