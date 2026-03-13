import { test, expect } from '@playwright/test'

test.describe('商品列表', () => {
  test('渲染页面标题和操作按钮', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByRole('heading', { name: '商品管理' })).toBeVisible()
    await expect(page.getByRole('link', { name: /新增商品/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /品项分类/ })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByPlaceholder(/搜索/)).toBeVisible()
    await expect(page.getByText('全部类型')).toBeVisible()
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByRole('columnheader', { name: /商品名称/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /标价/ })).toBeVisible()
  })

  test('新增商品导航', async ({ page }) => {
    await page.goto('/products')
    await page.getByRole('link', { name: /新增商品/ }).click()
    await expect(page).toHaveURL(/\/products\/create/)
  })

  test('品项分类导航', async ({ page }) => {
    await page.goto('/products')
    await page.getByRole('link', { name: /品项分类/ }).click()
    await expect(page).toHaveURL(/\/products\/categories/)
  })
})

test.describe('品项分类', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/products/categories')
    await expect(page.getByRole('heading', { name: /品项分类/ })).toBeVisible()
  })

  test('4 个 product_kind Tab 完整', async ({ page }) => {
    await page.goto('/products/categories')
    await expect(page.getByRole('tab', { name: /福利活动/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /护理项目/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /家居产品/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /充值卡/ })).toBeVisible()
  })

  test('Tab 切换正常', async ({ page }) => {
    await page.goto('/products/categories')
    await page.getByRole('tab', { name: /护理项目/ }).click()
    await expect(page.getByRole('tab', { name: /护理项目/ })).toHaveAttribute('data-state', 'active')
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
    await expect(page.getByText('展示')).toBeVisible()
    await expect(page.getByText('有效期')).toBeVisible()
  })

  test('必填字段可见', async ({ page }) => {
    await page.goto('/products/create')
    await expect(page.getByLabel(/商品名称/)).toBeVisible()
  })

  test('提交按钮可见', async ({ page }) => {
    await page.goto('/products/create')
    await expect(page.getByRole('button', { name: /创建商品/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /取消/ })).toBeVisible()
  })
})

test.describe('商品详情/编辑', () => {
  test('渲染返回按钮', async ({ page }) => {
    await page.goto('/products/mock-product-001')
    await expect(page.getByRole('button', { name: /返回/ })).toBeVisible()
  })

  test('SKU 列表区域可见', async ({ page }) => {
    await page.goto('/products/mock-product-001')
    await expect(page.getByText(/SKU/)).toBeVisible()
  })

  test('添加 SKU 按钮可见', async ({ page }) => {
    await page.goto('/products/mock-product-001')
    await expect(page.getByRole('button', { name: /新增 SKU|添加 SKU/ })).toBeVisible()
  })

  test('保存按钮可见', async ({ page }) => {
    await page.goto('/products/mock-product-001')
    await expect(page.getByRole('button', { name: /保存/ })).toBeVisible()
  })
})
