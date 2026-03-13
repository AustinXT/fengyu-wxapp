import { test, expect } from '@playwright/test'

test.describe('员工列表', () => {
  test('渲染页面标题和新建按钮', async ({ page }) => {
    await page.goto('/employees')
    await expect(page.getByRole('heading', { name: '员工管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: /新增员工/ })).toBeVisible()
  })

  test('筛选器完整', async ({ page }) => {
    await page.goto('/employees')
    await expect(page.getByPlaceholder(/搜索/)).toBeVisible()
    await expect(page.getByText('全部状态')).toBeVisible()
  })

  test('表格列头完整', async ({ page }) => {
    await page.goto('/employees')
    await expect(page.getByRole('columnheader', { name: '员工编号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '姓名' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: '手机号' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: /门店/ })).toBeVisible()
  })

  test('搜索功能可用', async ({ page }) => {
    await page.goto('/employees')
    const search = page.getByPlaceholder(/搜索/)
    await search.fill('张')
    await expect(search).toHaveValue('张')
  })

  test('分页组件可见', async ({ page }) => {
    await page.goto('/employees')
    const pagination = page.locator('[class*="pagination"], nav[aria-label]')
    await expect(pagination.first()).toBeVisible()
  })
})

test.describe('员工详情', () => {
  test('渲染返回按钮', async ({ page }) => {
    await page.goto('/employees/FY-260101-0001')
    await expect(page.getByRole('button', { name: /返回/ })).toBeVisible()
  })

  test('3 个 Tab 完整', async ({ page }) => {
    await page.goto('/employees/FY-260101-0001')
    await expect(page.getByRole('tab', { name: '基本信息' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '权限角色' })).toBeVisible()
    await expect(page.getByRole('tab', { name: '管理后台' })).toBeVisible()
  })

  test('基本信息 Tab 默认激活', async ({ page }) => {
    await page.goto('/employees/FY-260101-0001')
    await expect(page.getByRole('tab', { name: '基本信息' })).toHaveAttribute('data-state', 'active')
  })

  test('切换到权限角色 Tab', async ({ page }) => {
    await page.goto('/employees/FY-260101-0001')
    await page.getByRole('tab', { name: '权限角色' }).click()
    await expect(page.getByRole('tab', { name: '权限角色' })).toHaveAttribute('data-state', 'active')
    await expect(page.getByRole('button', { name: /分配角色/ })).toBeVisible()
  })

  test('切换到管理后台 Tab', async ({ page }) => {
    await page.goto('/employees/FY-260101-0001')
    await page.getByRole('tab', { name: '管理后台' }).click()
    await expect(page.getByRole('tab', { name: '管理后台' })).toHaveAttribute('data-state', 'active')
  })

  test('基本信息包含关键字段', async ({ page }) => {
    await page.goto('/employees/FY-260101-0001')
    await expect(page.getByText('员工编号')).toBeVisible()
    await expect(page.getByText('姓名')).toBeVisible()
  })
})
