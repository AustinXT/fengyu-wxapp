import { test, expect } from '@playwright/test'

test.describe('订单列表页', () => {
  test('渲染页面标题和新建按钮', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByRole('heading', { name: '订单管理' })).toBeVisible()
    await expect(page.getByText('新建订单')).toBeVisible()
  })

  test('筛选器元素完整', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByPlaceholder('搜索订单号/顾客/手机号')).toBeVisible()
    // 原生 select 元素（全部状态/全部类型/全部门店）
    const selects = page.locator('select')
    expect(await selects.count()).toBeGreaterThanOrEqual(2)
  })

  test('订单表格列头完整', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByRole('columnheader', { name: '订单号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '类型' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '顾客' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '订单金额' })).toBeVisible()
  })

  test('搜索框可输入', async ({ page }) => {
    await page.goto('/orders')
    const search = page.getByPlaceholder('搜索订单号/顾客/手机号')
    await search.fill('FY-XSD')
    await expect(search).toHaveValue('FY-XSD')
  })
})

test.describe('开单向导', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/orders/create')
    await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible()
  })

  test('Step 指示器显示', async ({ page }) => {
    await page.goto('/orders/create')
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
})
