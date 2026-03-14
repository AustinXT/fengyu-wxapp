import { test, expect } from '@playwright/test'

test.describe('数据中心', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/data-center')
    await expect(page.getByRole('heading', { name: '数据中心' })).toBeVisible()
  })

  test('副标题说明 P2 阶段', async ({ page }) => {
    await page.goto('/data-center')
    await expect(page.getByText('P2 阶段功能')).toBeVisible()
  })

  test('5 个分析 Tab 完整', async ({ page }) => {
    await page.goto('/data-center')
    await expect(page.getByRole('tab', { name: '客户回店率' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '品项占比' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '经营动线' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '人效分析' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '排行榜' })).toBeVisible()
  })

  test('Tab 切换正常', async ({ page }) => {
    await page.goto('/data-center')
    await page.getByRole('tab', { name: '品项占比' }).click()
    await expect(page.getByRole('tab', { name: '品项占比' })).toHaveAttribute('aria-selected', 'true')
  })

  test('显示敬请期待提示', async ({ page }) => {
    await page.goto('/data-center')
    await expect(page.getByText('敬请期待')).toBeVisible()
  })
})
