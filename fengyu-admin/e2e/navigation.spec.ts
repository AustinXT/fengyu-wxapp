import { test, expect } from '@playwright/test'

test.describe('侧边栏导航', () => {
  test('工作台页面可访问', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('工作台')).toBeVisible()
  })

  test('订单管理页面可访问', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByText('订单管理')).toBeVisible()
  })

  test('员工管理页面可访问', async ({ page }) => {
    await page.goto('/employees')
    await expect(page.getByText('员工管理')).toBeVisible()
  })

  test('商品管理页面可访问', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByText('商品管理')).toBeVisible()
  })

  test('权限管理页面可访问', async ({ page }) => {
    await page.goto('/permissions')
    await expect(page.getByText('权限管理')).toBeVisible()
  })
})
