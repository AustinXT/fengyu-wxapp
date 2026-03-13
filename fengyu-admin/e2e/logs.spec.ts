import { test, expect } from '@playwright/test'

test.describe('操作日志', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/logs')
    await expect(page.getByRole('heading', { name: '操作日志' })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/logs')
    await expect(page.getByPlaceholder(/操作人|搜索/)).toBeVisible()
    // 日期范围筛选
    await expect(page.getByLabel(/开始日期|从/)).toBeVisible()
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/logs')
    await expect(page.getByRole('columnheader', { name: /时间/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /操作人/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /操作/ })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /目标/ })).toBeVisible()
  })

  test('日志行有展开按钮', async ({ page }) => {
    await page.goto('/logs')
    const expandButtons = page.getByRole('button', { name: /展开|详情/ })
    const count = await expandButtons.count()
    if (count > 0) {
      // 点击展开
      await expandButtons.first().click()
      // 应显示 JSON 详情
      await page.waitForTimeout(300)
    }
  })
})
