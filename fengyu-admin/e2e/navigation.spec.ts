import { test, expect } from '@playwright/test'

test.describe('全局布局', () => {
  test('Topbar 渲染品牌文字和用户菜单', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('凤御美业管理后台')).toBeVisible()
    // 用户头像/下拉应可见
    await expect(page.getByText('张明')).toBeVisible()
  })

  test('Sidebar 显示菜单分组', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('业务管理')).toBeVisible()
    await expect(page.getByText('数据管理')).toBeVisible()
    await expect(page.getByText('系统管理')).toBeVisible()
  })

  test('面包屑导航正确', async ({ page }) => {
    await page.goto('/orders')
    const breadcrumb = page.getByLabel('面包屑导航')
    await expect(breadcrumb.getByText('订单管理')).toBeVisible()
  })
})

test.describe('页面路由可达性', () => {
  const routes = [
    { path: '/dashboard', heading: '工作台' },
    { path: '/orders', heading: '订单管理' },
    { path: '/orders/create', heading: /开单/ },
    { path: '/allocations', heading: '营业额分配' },
    { path: '/services', heading: '服务单管理' },
    { path: '/appointments', heading: '预约管理' },
    { path: '/org', heading: '组织架构' },
    { path: '/stores', heading: '门店管理' },
    { path: '/employees', heading: '员工管理' },
    { path: '/products', heading: '商品管理' },
    { path: '/products/categories', heading: /品项分类/ },
    { path: '/commission', heading: '提成矩阵' },
    { path: '/customers', heading: '顾客管理' },
    { path: '/coupons', heading: /优惠券管理/ },
    { path: '/permissions', heading: '权限管理' },
    { path: '/sync', heading: '数据同步' },
    { path: '/logs', heading: '操作日志' },
    { path: '/settings', heading: '系统配置' },
    { path: '/data-center', heading: /数据中心|经营数据/ },
  ]

  for (const { path, heading } of routes) {
    test(`${path} 页面可访问`, async ({ page }) => {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    })
  }
})

test.describe('侧边栏导航链接', () => {
  test('点击订单管理菜单项导航', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('link', { name: '订单管理' }).click()
    await expect(page).toHaveURL(/\/orders$/)
  })

  test('点击员工管理菜单项导航', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('link', { name: '员工管理' }).click()
    await expect(page).toHaveURL(/\/employees/)
  })

  test('点击商品管理菜单项导航', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('link', { name: '商品管理' }).click()
    await expect(page).toHaveURL(/\/products/)
  })

  test('点击系统配置菜单项导航', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('link', { name: '系统配置' }).click()
    await expect(page).toHaveURL(/\/settings/)
  })
})

test.describe('根路径重定向', () => {
  test('/ 重定向到 /dashboard', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/dashboard/)
  })
})
