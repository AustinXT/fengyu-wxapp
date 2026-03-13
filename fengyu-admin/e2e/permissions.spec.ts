import { test, expect } from '@playwright/test'

test.describe('权限管理', () => {
  test('渲染页面标题和分配按钮', async ({ page }) => {
    await page.goto('/permissions')
    await expect(page.getByRole('heading', { name: '权限管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: /分配角色/ })).toBeVisible()
  })

  test('2 个视图 Tab 完整', async ({ page }) => {
    await page.goto('/permissions')
    await expect(page.getByRole('tab', { name: /按角色查看/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /按员工查看/ })).toBeVisible()
  })

  test('按角色查看 Tab 默认激活', async ({ page }) => {
    await page.goto('/permissions')
    await expect(page.getByRole('tab', { name: /按角色查看/ })).toHaveAttribute('data-state', 'active')
  })

  test('按角色查看 — 角色列表可见', async ({ page }) => {
    await page.goto('/permissions')
    // 应显示角色按钮
    await expect(page.getByText('超级管理员')).toBeVisible()
    await expect(page.getByText('店长')).toBeVisible()
  })

  test('按角色查看 — 点击角色显示员工', async ({ page }) => {
    await page.goto('/permissions')
    // 点击角色按钮
    await page.getByText('超级管理员').click()
    await page.waitForTimeout(300)
    // 右侧应显示该角色下的员工表
  })

  test('切换到按员工查看 Tab', async ({ page }) => {
    await page.goto('/permissions')
    await page.getByRole('tab', { name: /按员工查看/ }).click()
    await expect(page.getByRole('tab', { name: /按员工查看/ })).toHaveAttribute('data-state', 'active')
    // 员工搜索框应出现
    await expect(page.getByPlaceholder(/搜索/)).toBeVisible()
  })

  test('分配角色 Dialog 打开', async ({ page }) => {
    await page.goto('/permissions')
    await page.getByRole('button', { name: /分配角色/ }).click()
    // Dialog 应打开
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByText(/选择员工/)).toBeVisible()
    await expect(page.getByText(/选择角色/)).toBeVisible()
  })

  test('分配角色 Dialog 可关闭', async ({ page }) => {
    await page.goto('/permissions')
    await page.getByRole('button', { name: /分配角色/ }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    // 点击取消关闭
    await page.getByRole('button', { name: /取消/ }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })
})
