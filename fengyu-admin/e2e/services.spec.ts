import { test, expect } from '@playwright/test'

test.describe('服务单列表', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/services')
    await expect(page.getByRole('heading', { name: '服务单管理' })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/services')
    // 原生 select 用 combobox/listbox 或直接检查 select 元素存在
    await expect(page.locator('select').first()).toBeVisible()
    await expect(page.getByPlaceholder('搜索服务单号/顾客/美容师')).toBeVisible()
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/services')
    await expect(page.getByRole('columnheader', { name: '服务单号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '类型' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '顾客' })).toBeVisible()
  })
})
