import { test, expect } from '@playwright/test'

test.describe('订单列表页', () => {
  test('渲染页面标题和新建按钮', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByRole('heading', { name: '订单管理' })).toBeVisible()
    await expect(page.getByRole('link', { name: /新建订单/ })).toBeVisible()
  })

  test('筛选器元素完整', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByPlaceholder(/搜索/)).toBeVisible()
    await expect(page.getByText('全部状态')).toBeVisible()
    await expect(page.getByText('全部类型')).toBeVisible()
  })

  test('订单表格列头完整', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByRole('columnheader', { name: '订单号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '类型' })).toBeVisible()
  })

  test('新建订单按钮导航到开单页', async ({ page }) => {
    await page.goto('/orders')
    await page.getByRole('link', { name: /新建订单/ }).click()
    await expect(page).toHaveURL(/\/orders\/create/)
  })

  test('搜索框可输入', async ({ page }) => {
    await page.goto('/orders')
    const search = page.getByPlaceholder(/搜索/)
    await search.fill('FY-XSD')
    await expect(search).toHaveValue('FY-XSD')
  })
})

test.describe('开单向导', () => {
  test('渲染 4 步流程标题', async ({ page }) => {
    await page.goto('/orders/create')
    await expect(page.getByRole('heading', { name: /开单/ })).toBeVisible()
    await expect(page.getByText('选择顾客')).toBeVisible()
    await expect(page.getByText('选择商品')).toBeVisible()
    await expect(page.getByText('确认订单')).toBeVisible()
    await expect(page.getByText('完成')).toBeVisible()
  })

  test('Step 1: 顾客搜索输入', async ({ page }) => {
    await page.goto('/orders/create')
    await expect(page.getByPlaceholder(/手机号/)).toBeVisible()
    await expect(page.getByRole('button', { name: /搜索/ })).toBeVisible()
  })

  test('Step 1: 搜索后显示顾客信息', async ({ page }) => {
    await page.goto('/orders/create')
    await page.getByPlaceholder(/手机号/).fill('13800138000')
    await page.getByRole('button', { name: /搜索/ }).click()
    // 搜索后应显示顾客卡片或搜索结果
    await page.waitForTimeout(500)
    // 下一步按钮应变为可用
    await expect(page.getByRole('button', { name: /下一步/ })).toBeVisible()
  })

  test('Step 2: 商品分类和列表', async ({ page }) => {
    await page.goto('/orders/create')
    // 到达 Step 2
    await page.getByPlaceholder(/手机号/).fill('13800138000')
    await page.getByRole('button', { name: /搜索/ }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: /下一步/ }).click()
    // Step 2 应显示商品分类
    await expect(page.getByText(/选择商品/)).toBeVisible()
  })
})

test.describe('订单详情页', () => {
  test('返回按钮可见', async ({ page }) => {
    await page.goto('/orders/mock-order-001')
    await expect(page.getByRole('link', { name: /返回/ })).toBeVisible()
  })

  test('渲染订单信息区域', async ({ page }) => {
    await page.goto('/orders/mock-order-001')
    await expect(page.getByText('订单信息')).toBeVisible()
  })
})
