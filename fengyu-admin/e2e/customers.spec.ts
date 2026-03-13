import { test, expect } from '@playwright/test'

test.describe('顾客列表', () => {
  test('渲染页面标题和新建按钮', async ({ page }) => {
    await page.goto('/customers')
    await expect(page.getByRole('heading', { name: '顾客管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: /新增顾客/ })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/customers')
    await expect(page.getByPlaceholder(/搜索/)).toBeVisible()
    await expect(page.getByText('全部等级')).toBeVisible()
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/customers')
    await expect(page.getByRole('columnheader', { name: '姓名' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '手机号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /会员等级/ })).toBeVisible()
  })

  test('搜索功能可用', async ({ page }) => {
    await page.goto('/customers')
    const search = page.getByPlaceholder(/搜索/)
    await search.fill('李')
    await expect(search).toHaveValue('李')
  })
})

test.describe('顾客详情', () => {
  test('渲染返回按钮', async ({ page }) => {
    await page.goto('/customers/mock-user-001')
    await expect(page.getByRole('button', { name: /返回/ })).toBeVisible()
  })

  test('4 个 Tab 完整', async ({ page }) => {
    await page.goto('/customers/mock-user-001')
    await expect(page.getByRole('tab', { name: '基本档案' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '消费记录' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '疗程卡余次' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '预约记录' })).toBeVisible()
  })

  test('基本档案 Tab 默认激活', async ({ page }) => {
    await page.goto('/customers/mock-user-001')
    await expect(page.getByRole('tab', { name: '基本档案' })).toHaveAttribute('data-state', 'active')
  })

  test('切换到消费记录 Tab', async ({ page }) => {
    await page.goto('/customers/mock-user-001')
    await page.getByRole('tab', { name: '消费记录' }).click()
    await expect(page.getByRole('tab', { name: '消费记录' })).toHaveAttribute('data-state', 'active')
  })

  test('切换到疗程卡余次 Tab', async ({ page }) => {
    await page.goto('/customers/mock-user-001')
    await page.getByRole('tab', { name: '疗程卡余次' }).click()
    await expect(page.getByRole('tab', { name: '疗程卡余次' })).toHaveAttribute('data-state', 'active')
  })

  test('切换到预约记录 Tab', async ({ page }) => {
    await page.goto('/customers/mock-user-001')
    await page.getByRole('tab', { name: '预约记录' }).click()
    await expect(page.getByRole('tab', { name: '预约记录' })).toHaveAttribute('data-state', 'active')
  })

  test('基本档案包含关键字段', async ({ page }) => {
    await page.goto('/customers/mock-user-001')
    await expect(page.getByText('姓名')).toBeVisible()
    await expect(page.getByText('手机号')).toBeVisible()
  })
})
