import { test, expect } from '@playwright/test'

test.describe('登录页', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('空提交显示验证错误', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page.getByText('请输入手机号')).toBeVisible()
  })

  test('非法手机号显示错误', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('手机号').fill('123')
    await page.getByLabel('密码').fill('admin123')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page.getByText('请输入正确的手机号')).toBeVisible()
  })

  test('错误密码显示提示', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('手机号').fill('13800138000')
    await page.getByLabel('密码').fill('wrongpassword')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page.getByText('手机号或密码错误')).toBeVisible()
  })

  test('正确登录跳转到工作台', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('手机号').fill('13800138000')
    await page.getByLabel('密码').fill('admin123')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page).toHaveURL(/\/dashboard/)
  })
})
