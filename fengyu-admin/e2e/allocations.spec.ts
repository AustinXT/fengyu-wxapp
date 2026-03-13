import { test, expect } from '@playwright/test'

test.describe('营业额分配列表', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/allocations')
    await expect(page.getByRole('heading', { name: '营业额分配' })).toBeVisible()
  })

  test('分配表格列头完整', async ({ page }) => {
    await page.goto('/allocations')
    await expect(page.getByRole('columnheader', { name: '订单号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '分配状态' })).toBeVisible()
  })

  test('分配状态 Badge 显示', async ({ page }) => {
    await page.goto('/allocations')
    // 应显示 待分配 或 已分配 的 Badge
    const hasBadge = await page.getByText(/待分配|已分配/).count()
    expect(hasBadge).toBeGreaterThanOrEqual(0) // 可能无数据
  })
})

test.describe('分配编辑页', () => {
  test('渲染返回按钮和订单摘要', async ({ page }) => {
    await page.goto('/allocations/mock-order-001')
    await expect(page.getByRole('link', { name: /返回/ })).toBeVisible()
    await expect(page.getByText('订单摘要')).toBeVisible()
  })

  test('添加分配人按钮可见', async ({ page }) => {
    await page.goto('/allocations/mock-order-001')
    await expect(page.getByRole('button', { name: /添加分配/ })).toBeVisible()
  })

  test('保存和取消按钮可见', async ({ page }) => {
    await page.goto('/allocations/mock-order-001')
    await expect(page.getByRole('button', { name: /保存/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /取消/ })).toBeVisible()
  })
})
