import { test, expect } from '@playwright/test'

test.describe('数据同步', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/sync')
    await expect(page.getByRole('heading', { name: '数据同步' })).toBeVisible()
  })

  test('同步按钮可见', async ({ page }) => {
    await page.goto('/sync')
    await expect(page.getByRole('button', { name: '触发全量同步' })).toBeVisible()
    await expect(page.getByRole('button', { name: '触发增量同步' })).toBeVisible()
  })

  test('最近同步信息显示', async ({ page }) => {
    await page.goto('/sync')
    await expect(page.getByText('最近同步')).toBeVisible()
  })

  test('WorkFine 依赖提示可见', async ({ page }) => {
    await page.goto('/sync')
    await expect(page.getByText(/WorkFine/)).toBeVisible()
  })

  test('同步历史卡片可见', async ({ page }) => {
    await page.goto('/sync')
    await expect(page.getByText('同步历史', { exact: true })).toBeVisible()
  })
})
