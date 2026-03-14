import { test, expect } from '@playwright/test'

test.describe('权限管理', () => {
  test('渲染页面标题和分配按钮', async ({ page }) => {
    await page.goto('/permissions')
    await expect(page.getByRole('heading', { name: '权限管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: '分配角色' })).toBeVisible()
  })

  test('2 个视图 Tab 完整', async ({ page }) => {
    await page.goto('/permissions')
    await expect(page.getByRole('tab', { name: '按角色查看' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '按员工查看' })).toBeVisible()
  })

  test('按角色查看默认激活', async ({ page }) => {
    await page.goto('/permissions')
    await expect(page.getByRole('tab', { name: '按角色查看' })).toHaveAttribute('aria-selected', 'true')
  })

  test('角色列表显示', async ({ page }) => {
    await page.goto('/permissions')
    // 实际角色标签名
    await expect(page.getByRole('button', { name: '系统管理员' })).toBeVisible()
  })

  test('切换到按员工查看', async ({ page }) => {
    await page.goto('/permissions')
    await page.getByRole('tab', { name: '按员工查看' }).click()
    await expect(page.getByRole('tab', { name: '按员工查看' })).toHaveAttribute('aria-selected', 'true')
  })

  test('分配角色 Dialog 打开和关闭', async ({ page }) => {
    await page.goto('/permissions')
    await page.getByRole('button', { name: '分配角色' }).click()
    // Dialog 内容
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // 关闭
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).not.toBeVisible()
  })
})
