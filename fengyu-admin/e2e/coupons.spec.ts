import { test, expect } from '@playwright/test'

test.describe('优惠券列表', () => {
  test('渲染页面标题和新建按钮', async ({ page }) => {
    await page.goto('/coupons')
    await expect(page.getByRole('heading', { name: /优惠券管理/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /新增优惠券/ })).toBeVisible()
  })

  test('搜索框可用', async ({ page }) => {
    await page.goto('/coupons')
    const search = page.getByPlaceholder(/搜索/)
    await expect(search).toBeVisible()
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/coupons')
    await expect(page.getByRole('columnheader', { name: /券名称|名称/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /类型/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /状态/ })).toBeVisible()
  })

  test('新增按钮导航', async ({ page }) => {
    await page.goto('/coupons')
    await page.getByRole('link', { name: /新增优惠券/ }).click()
    await expect(page).toHaveURL(/\/coupons\/create/)
  })
})

test.describe('新增优惠券', () => {
  test('渲染返回按钮和表单', async ({ page }) => {
    await page.goto('/coupons/create')
    await expect(page.getByRole('button', { name: /返回/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: /新增优惠券/ })).toBeVisible()
  })

  test('表单分组完整', async ({ page }) => {
    await page.goto('/coupons/create')
    await expect(page.getByText('基本信息')).toBeVisible()
    await expect(page.getByText('有效期')).toBeVisible()
  })

  test('券类型影响表单字段', async ({ page }) => {
    await page.goto('/coupons/create')
    // 券类型选择应该可见
    await expect(page.getByLabel(/券类型|类型/)).toBeVisible()
  })

  test('提交和取消按钮可见', async ({ page }) => {
    await page.goto('/coupons/create')
    await expect(page.getByRole('button', { name: /创建优惠券/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /取消/ })).toBeVisible()
  })
})

test.describe('优惠券详情', () => {
  test('渲染返回按钮', async ({ page }) => {
    await page.goto('/coupons/mock-coupon-001')
    await expect(page.getByRole('button', { name: /返回/ })).toBeVisible()
  })

  test('模板信息区域可见', async ({ page }) => {
    await page.goto('/coupons/mock-coupon-001')
    await expect(page.getByText(/模板信息|优惠券信息/)).toBeVisible()
  })

  test('发放按钮可见', async ({ page }) => {
    await page.goto('/coupons/mock-coupon-001')
    await expect(page.getByRole('button', { name: /发放/ })).toBeVisible()
  })
})
