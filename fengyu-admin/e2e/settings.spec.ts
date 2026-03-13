import { test, expect } from '@playwright/test'

test.describe('系统配置', () => {
  test('渲染页面标题', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: '系统配置' })).toBeVisible()
  })

  test('配置字段完整', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByLabel(/订单.*前缀/)).toBeVisible()
    await expect(page.getByLabel(/新会员.*门槛|消费门槛/)).toBeVisible()
    await expect(page.getByLabel(/超时|订单.*时间/)).toBeVisible()
  })

  test('订单前缀有默认值', async ({ page }) => {
    await page.goto('/settings')
    const prefixInput = page.getByLabel(/订单.*前缀/)
    await expect(prefixInput).toHaveValue(/FY/)
  })

  test('保存按钮可见', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.getByRole('button', { name: /保存/ })).toBeVisible()
  })

  test('字段可编辑', async ({ page }) => {
    await page.goto('/settings')
    const thresholdInput = page.getByLabel(/新会员.*门槛|消费门槛/)
    await thresholdInput.clear()
    await thresholdInput.fill('2000')
    await expect(thresholdInput).toHaveValue('2000')
  })
})
