import { test, expect } from '@playwright/test'

test.describe('登录页', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('渲染标题和表单', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: '凤御美业管理后台' })).toBeVisible()
    await expect(page.getByLabel('手机号')).toBeVisible()
    await expect(page.getByLabel('密码')).toBeVisible()
    await expect(page.getByRole('button', { name: /登 录/ })).toBeVisible()
    await expect(page.getByText('首次登录？请联系管理员开通权限')).toBeVisible()
  })

  test('空提交显示验证错误', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page.getByText('请输入手机号')).toBeVisible()
  })

  test('只填手机号空密码提示错误', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('手机号').fill('13800138000')
    await page.getByRole('button', { name: /登 录/ }).click()
    await expect(page.getByText('请输入密码')).toBeVisible()
  })

  test('非法手机号格式显示错误', async ({ page }) => {
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
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 })
  })

  test('手机号输入最大 11 位', async ({ page }) => {
    await page.goto('/login')
    const phoneInput = page.getByLabel('手机号')
    await expect(phoneInput).toHaveAttribute('maxlength', '11')
  })
})

test.describe('修改密码页', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('渲染标题和表单', async ({ page }) => {
    await page.goto('/change-password')
    await expect(page.getByRole('heading', { name: '修改密码' })).toBeVisible()
    await expect(page.getByText('首次登录需要修改初始密码')).toBeVisible()
    await expect(page.getByLabel('新密码')).toBeVisible()
    await expect(page.getByLabel('确认密码')).toBeVisible()
    await expect(page.getByRole('button', { name: '确认修改' })).toBeVisible()
  })

  test('空提交显示两项错误', async ({ page }) => {
    await page.goto('/change-password')
    await page.getByRole('button', { name: '确认修改' }).click()
    await expect(page.getByText('请输入新密码')).toBeVisible()
    await expect(page.getByText('请确认新密码')).toBeVisible()
  })

  test('弱密码（纯数字）拒绝', async ({ page }) => {
    await page.goto('/change-password')
    await page.getByLabel('新密码').fill('12345678')
    await page.getByLabel('确认密码').fill('12345678')
    await page.getByRole('button', { name: '确认修改' }).click()
    await expect(page.getByText('密码至少 8 位，需包含字母和数字')).toBeVisible()
  })

  test('两次密码不一致拒绝', async ({ page }) => {
    await page.goto('/change-password')
    await page.getByLabel('新密码').fill('abc12345')
    await page.getByLabel('确认密码').fill('abc12346')
    await page.getByRole('button', { name: '确认修改' }).click()
    await expect(page.getByText('两次输入的密码不一致')).toBeVisible()
  })

  test('合法密码提交成功跳转', async ({ page }) => {
    await page.goto('/change-password')
    await page.getByLabel('新密码').fill('abc12345')
    await page.getByLabel('确认密码').fill('abc12345')
    await page.getByRole('button', { name: '确认修改' }).click()
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 })
  })
})
