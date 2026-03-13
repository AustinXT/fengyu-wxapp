import { test, expect } from '@playwright/test'

test.describe('服务单列表', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/services')
    await expect(page.getByRole('heading', { name: '服务单管理' })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/services')
    await expect(page.getByText('全部状态')).toBeVisible()
    await expect(page.getByPlaceholder(/搜索/)).toBeVisible()
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/services')
    await expect(page.getByRole('columnheader', { name: /服务单/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible()
  })
})

test.describe('服务单详情', () => {
  test('渲染返回按钮和基本信息', async ({ page }) => {
    await page.goto('/services/mock-service-001')
    await expect(page.getByRole('link', { name: /返回/ })).toBeVisible()
    await expect(page.getByText('服务单信息')).toBeVisible()
  })
})
