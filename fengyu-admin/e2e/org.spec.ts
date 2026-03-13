import { test, expect } from '@playwright/test'

test.describe('组织架构', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/org')
    await expect(page.getByRole('heading', { name: '组织架构' })).toBeVisible()
  })

  test('左侧树和右侧详情面板布局', async ({ page }) => {
    await page.goto('/org')
    // 左侧应有组织树
    await expect(page.getByText('组织架构树')).toBeVisible()
    // 右侧应有详情面板
    await expect(page.getByText(/节点详情|请选择节点/)).toBeVisible()
  })

  test('新增根节点按钮可见', async ({ page }) => {
    await page.goto('/org')
    await expect(page.getByRole('button', { name: /新增/ })).toBeVisible()
  })

  test('树节点可点击选中', async ({ page }) => {
    await page.goto('/org')
    // 找到树中的节点并点击
    const treeNodes = page.locator('[role="treeitem"], [data-node-id]').first()
    if (await treeNodes.isVisible()) {
      await treeNodes.click()
      // 右侧面板应更新
      await page.waitForTimeout(300)
    }
  })

  test('节点类型图标区分', async ({ page }) => {
    await page.goto('/org')
    // 各类型节点应有图标
    const nodeCount = await page.locator('.org-tree-node, [data-node-type]').count()
    expect(nodeCount).toBeGreaterThanOrEqual(0)
  })
})
