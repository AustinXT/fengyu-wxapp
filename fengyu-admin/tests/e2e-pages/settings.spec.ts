import { test, expect } from '@playwright/test'

test.describe('系统配置', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: '系统配置' })).toBeVisible()
  })

  test('基础配置卡片可见', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByText('基础配置')).toBeVisible()
  })

  test('配置字段完整', async ({ page }) => {
    await page.goto('/settings')
    // 标签是普通文字（非 <label>），用 getByText
    await expect(page.getByText(/新会员消费门槛/)).toBeVisible()
    await expect(page.getByText(/订单超时时间/)).toBeVisible()
  })

  test('保存按钮可见', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('button', { name: '保存' })).toBeVisible()
  })

  test('辅助说明文字可见', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByText(/自动升级为会员/)).toBeVisible()
  })
})
