import { test, expect } from '@playwright/test'

test.describe('组织架构', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/org')
    await expect(page.getByRole('heading', { name: '组织架构' })).toBeVisible()
  })

  test('左侧组织树面板', async ({ page }) => {
    await page.goto('/org')
    await expect(page.getByText('组织树')).toBeVisible()
  })

  test('右侧详情面板', async ({ page }) => {
    await page.goto('/org')
    await expect(page.getByText('节点详情')).toBeVisible()
  })

  test('新增根节点按钮可见', async ({ page }) => {
    await page.goto('/org')
    await expect(page.getByRole('button', { name: '新增根节点' })).toBeVisible()
  })

  test('节点详情面板显示内容', async ({ page }) => {
    await page.goto('/org')
    // 有数据时默认选中第一个节点，显示详情；无数据时显示提示
    const hasData = await page.getByText('节点名称').isVisible().catch(() => false)
    if (hasData) {
      await expect(page.getByText('节点名称')).toBeVisible()
      await expect(page.getByText('节点类型')).toBeVisible()
    } else {
      await expect(page.getByText('请在左侧选择一个节点')).toBeVisible()
    }
  })
})
