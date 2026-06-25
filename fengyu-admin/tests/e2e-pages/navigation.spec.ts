import { test, expect } from '@playwright/test'

test.describe('全局布局', () => {
  test('Topbar 渲染品牌标识', async ({ page }) => {
    await page.goto('/dashboard')
    // Topbar 有用户名显示（fixture: FY-TEST-ADM 名为 '测试管理员'）
    await expect(page.getByText('测试管理员').first()).toBeVisible()
  })

  test('Sidebar 显示菜单分组', async ({ page }) => {
    await page.goto('/dashboard')
    // exact=true 避免 '系统管理' 误命中 '系统管理员' 角色显示
    await expect(page.getByText('业务管理', { exact: true })).toBeVisible()
    await expect(page.getByText('数据管理', { exact: true })).toBeVisible()
    await expect(page.getByText('系统管理', { exact: true })).toBeVisible()
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
    { path: '/orders/create', heading: '新建订单' },
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

    { path: '/logs', heading: '操作日志' },
    { path: '/settings', heading: '系统配置' },
  ]

  for (const { path, heading } of routes) {
    test(`${path} 页面可访问`, async ({ page }) => {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    })
  }
})

test.describe('侧边栏导航链接', () => {
  test('点击商品管理菜单项导航', async ({ page }) => {
    await page.goto('/dashboard')
    // sidebar Link components render as <a> with <span> text
    await page.locator('aside').getByText('商品管理').click()
    await expect(page).toHaveURL(/\/products/)
  })

  test('点击系统配置菜单项导航', async ({ page }) => {
    await page.goto('/dashboard')
    await page.locator('aside').getByText('系统配置').click()
    // dev 模式下 /settings 首次访问需冷编译，客户端导航期间 URL 短暂停留 /dashboard，
    // 默认 5s 超时偶发不足 → 放宽到 15s 吸收冷编译，消除时序 flaky。
    await expect(page).toHaveURL(/\/settings/, { timeout: 15_000 })
  })
})

test.describe('根路径重定向', () => {
  test('/ 重定向到 /dashboard', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/dashboard/)
  })
})
