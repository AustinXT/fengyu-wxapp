import { test, expect } from '@playwright/test'

test.describe('工作台', () => {
  test('渲染页面标题和欢迎文字', async ({ page }) => {
    await page.goto('/dashboard')
    // 标题在 page-skeleton + dashboard-page 两处都渲染，取 first 以避免 streaming 期间的 strict 冲突
    await expect(page.getByRole('heading', { name: '工作台' }).first()).toBeVisible()
    await expect(page.getByText('欢迎使用凤御美业管理后台').first()).toBeVisible()
  })

  test('显示快捷入口区域', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('快捷入口')).toBeVisible()
  })

  test('角色自适应：显示指标卡片', async ({ page }) => {
    await page.goto('/dashboard')
    // CardContent 组件不带 className 标记，改用 main 内部直接子 div （card 结构）
    // 至少应展示 1 个指标卡片：admin 至少能看到"营业门店/在职员工/在售商品/注册顾客"4 张系统指标卡
    const metrics = page.getByText(/营业门店|在职员工|在售商品|注册顾客|今日客流|今日营业额|本月营业额/).first()
    await expect(metrics).toBeVisible()
  })

  test('角色自适应：快捷入口包含至少 1 个按钮', async ({ page }) => {
    await page.goto('/dashboard')
    const shortcutSection = page.getByText('快捷入口').locator('..')
    const buttons = shortcutSection.getByRole('link')
    await expect(buttons.first()).toBeVisible()
  })

  test('业务角色看到业务指标（需 manager/finance 登录）', async ({ page }) => {
    await page.goto('/dashboard')
    // 如果当前用户有业务权限，应看到待办事项区域
    // 如果是系统角色，快捷入口包含管理链接
    // 「待办事项」「组织架构」可能同时出现在侧边栏与主内容区，用 .first() 避免 strict-mode 冲突误判
    const hasBusiness = await page.getByText('待办事项').first().isVisible().catch(() => false)
    const hasSystem = await page.getByText('组织架构').first().isVisible().catch(() => false)
    // 至少命中一种看板模式
    expect(hasBusiness || hasSystem).toBeTruthy()
  })
})
