import { test, expect } from '@playwright/test'

test.describe('工作台', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible()
  })

  test('显示 4 个核心指标卡片', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('今日客流')).toBeVisible()
    await expect(page.getByText('今日业绩')).toBeVisible()
    await expect(page.getByText('待处理订单')).toBeVisible()
    await expect(page.getByText('待确认预约')).toBeVisible()
  })

  test('显示待办事项', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText(/订单待分配/)).toBeVisible()
    await expect(page.getByText(/预约待确认/)).toBeVisible()
    await expect(page.getByText(/服务单进行中/)).toBeVisible()
  })

  test('待办事项链接可点击', async ({ page }) => {
    await page.goto('/dashboard')
    const allocLink = page.getByRole('link', { name: /订单待分配/ })
    await expect(allocLink).toHaveAttribute('href', '/allocations')
  })

  test('快捷入口按钮可见', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('link', { name: '开单' })).toBeVisible()
    await expect(page.getByRole('link', { name: '订单管理' })).toBeVisible()
    await expect(page.getByRole('link', { name: '顾客管理' })).toBeVisible()
    await expect(page.getByRole('link', { name: '员工管理' })).toBeVisible()
  })

  test('快捷入口导航正确', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('link', { name: '开单' }).click()
    await expect(page).toHaveURL(/\/orders\/create/)
  })

  test('指标卡片显示趋势', async ({ page }) => {
    await page.goto('/dashboard')
    // 趋势箭头 / 较昨日变化
    await expect(page.getByText(/较昨日/)).toBeVisible()
  })
})
