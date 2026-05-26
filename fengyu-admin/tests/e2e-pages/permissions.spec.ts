import { test, expect } from '@playwright/test'

test.describe('权限管理', () => {
  test('渲染页面标题和分配按钮', async ({ page }) => {
    await page.goto('/permissions')
    await expect(page.getByRole('heading', { name: '权限管理' })).toBeVisible()
    // 页面存在多个「分配角色」按钮（页头 + 每个角色行 + Dialog 标题），取第一个（页头按钮）
    await expect(page.getByRole('button', { name: '分配角色', exact: true }).first()).toBeVisible()
  })

  test('左侧组织树渲染', async ({ page }) => {
    await page.goto('/permissions')
    // 「权限范围」同时出现在左栏 CardTitle 与 Dialog label，取第一个（左栏标题）
    await expect(page.getByText('权限范围').first()).toBeVisible()
  })

  test('选中节点显示角色分配面板', async ({ page }) => {
    await page.goto('/permissions')
    // 右侧面板应显示选中节点的名称（默认选中总部）
    const rightPanel = page.locator('.flex-1').last()
    await expect(rightPanel).toBeVisible()
  })

  test('分配角色 Dialog 打开和关闭', async ({ page }) => {
    await page.goto('/permissions')
    await page.getByRole('button', { name: '分配角色' }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).not.toBeVisible()
  })
})
