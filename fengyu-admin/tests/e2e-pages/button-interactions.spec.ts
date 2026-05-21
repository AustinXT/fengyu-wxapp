import { test, expect } from '@playwright/test'

// Helper: 验证 toast 提示出现
async function expectToast(page: import('@playwright/test').Page, text: string | RegExp) {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible({ timeout: 5000 })
}

// ============================================================
// 工作台 — 快捷入口导航 + 待办事项
// ============================================================
test.describe('工作台按钮交互', () => {
  test('快捷入口 "开单" 导航到开单页', async ({ page }) => {
    await page.goto('/dashboard')
    const shortcuts = page.locator('text=快捷入口').locator('..')
    await shortcuts.getByText('开单').click()
    await expect(page).toHaveURL(/\/orders\/create/)
  })

  test('快捷入口 "订单管理" 导航到订单页', async ({ page }) => {
    await page.goto('/dashboard')
    const shortcuts = page.locator('text=快捷入口').locator('..')
    await shortcuts.getByText('订单管理').click()
    await expect(page).toHaveURL(/\/orders/)
  })

  test('快捷入口 "顾客管理" 导航到顾客页', async ({ page }) => {
    await page.goto('/dashboard')
    const shortcuts = page.locator('text=快捷入口').locator('..')
    await shortcuts.getByText('顾客管理').click()
    await expect(page).toHaveURL(/\/customers/)
  })

  test('快捷入口 "员工管理" 导航到员工页', async ({ page }) => {
    await page.goto('/dashboard')
    const shortcuts = page.locator('text=快捷入口').locator('..')
    await shortcuts.getByText('员工管理').click()
    await expect(page).toHaveURL(/\/employees/)
  })

  test('待办事项链接可点击并导航', async ({ page }) => {
    await page.goto('/dashboard')
    const todoSection = page.locator('text=待办事项').locator('..')
    const firstLink = todoSection.locator('a').first()
    const href = await firstLink.getAttribute('href')
    await firstLink.click()
    if (href) {
      await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  })
})

// ============================================================
// 订单 — 新建按钮 + 开单向导
// ============================================================
test.describe('订单按钮交互', () => {
  test('"新建订单" 按钮导航到开单页', async ({ page }) => {
    await page.goto('/orders')
    await page.getByText('新建订单').click()
    await expect(page).toHaveURL(/\/orders\/create/)
  })

  test('开单向导: 返回箭头导航回订单列表', async ({ page }) => {
    await page.goto('/orders/create')
    await page.locator('a[href="/orders"]').first().click()
    await expect(page).toHaveURL(/\/orders$/)
  })

  test('开单向导: 搜索按钮可点击', async ({ page }) => {
    await page.goto('/orders/create')
    const searchBtn = page.getByRole('button', { name: /搜索/ })
    await expect(searchBtn).toBeVisible()
    await searchBtn.click()
    // 页面不 crash
    await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible()
  })
})

// ============================================================
// 商品 — 导航 + 创建表单验证 + 分类 Dialog
// ============================================================
test.describe('商品按钮交互', () => {
  test('"新增商品" 导航到创建页', async ({ page }) => {
    await page.goto('/products')
    await page.getByText('新增商品').click()
    await expect(page).toHaveURL(/\/products\/create/)
  })

  test('"品项分类" 导航到分类页', async ({ page }) => {
    await page.goto('/products')
    await page.getByRole('button', { name: '品项分类' }).click()
    await expect(page).toHaveURL(/\/products\/categories/)
  })

  test('新增商品页: "返回" 按钮导航', async ({ page }) => {
    await page.goto('/products/create')
    await page.getByRole('button', { name: /返回/ }).click()
    await expect(page).not.toHaveURL(/\/products\/create/)
  })

  test('新增商品页: "取消" 按钮导航', async ({ page }) => {
    await page.goto('/products/create')
    await page.getByRole('button', { name: /取消/ }).click()
    await expect(page).not.toHaveURL(/\/products\/create/)
  })

  test('新增商品页: 空提交显示验证错误', async ({ page }) => {
    await page.goto('/products/create')
    await page.getByRole('button', { name: /创建商品/ }).click()
    await expectToast(page, /请输入/)
  })

  test('品项分类: "新增分类" 按钮打开 Dialog', async ({ page }) => {
    await page.goto('/products/categories')
    // 按钮已更名为「新增二级分类」（配套「品项一级分类管理」）
    await page.getByRole('button', { name: /新增二级分类/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('分类名称')).toBeVisible()
  })

  test('品项分类: Dialog 取消关闭', async ({ page }) => {
    await page.goto('/products/categories')
    await page.getByRole('button', { name: /新增二级分类/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('品项分类: Tab 全部可切换', async ({ page }) => {
    await page.goto('/products/categories')
    // 「组合套餐」已从 product_kind 移除（2026-04-10 baseline reset）
    for (const kind of ['护理项目', '家居产品', '充值卡', '体验卡']) {
      const tab = page.getByRole('tab', { name: new RegExp(kind) })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
    }
  })
})

// ============================================================
// 顾客 — 新增按钮 + 筛选
// ============================================================
test.describe('顾客按钮交互', () => {
  test('"新增顾客" 打开 Dialog', async ({ page }) => {
    await page.goto('/customers')
    await page.getByRole('button', { name: '新增顾客' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('手机号')).toBeVisible()
    await expect(dialog.getByText('姓名')).toBeVisible()
  })

  test('"新增顾客" Dialog 取消关闭', async ({ page }) => {
    await page.goto('/customers')
    await page.getByRole('button', { name: '新增顾客' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('筛选 select 有选项', async ({ page }) => {
    await page.goto('/customers')
    const firstSelect = page.locator('select').first()
    await expect(firstSelect).toBeVisible()
    expect(await firstSelect.locator('option').count()).toBeGreaterThanOrEqual(1)
  })

  test('搜索框可输入', async ({ page }) => {
    await page.goto('/customers')
    const search = page.getByPlaceholder('搜索姓名 / 手机号')
    await search.fill('测试搜索')
    await expect(search).toHaveValue('测试搜索')
  })
})

// ============================================================
// 员工 — 新增按钮 + 筛选
// ============================================================
test.describe('员工按钮交互', () => {
  test('"新增员工" 导航到创建页', async ({ page }) => {
    await page.goto('/employees')
    await page.getByRole('button', { name: '新增员工' }).click()
    await expect(page).toHaveURL(/\/employees\/create/)
  })

  test('在职状态筛选有 3 项', async ({ page }) => {
    await page.goto('/employees')
    const selects = page.locator('select')
    expect(await selects.count()).toBeGreaterThanOrEqual(2)
    const statusSelect = selects.nth(1)
    expect(await statusSelect.locator('option').count()).toBe(3)
  })
})

// ============================================================
// 门店 — 新增按钮导航
// ============================================================
test.describe('门店按钮交互', () => {
  test('"新增门店" 导航到创建页', async ({ page }) => {
    await page.goto('/stores')
    await page.getByRole('button', { name: '新增门店' }).click()
    await expect(page).toHaveURL(/\/stores\/create/)
  })
})

// ============================================================
// 提成矩阵 — 新增规则 Dialog + Tab
// ============================================================
test.describe('提成矩阵按钮交互', () => {
  test('"新增规则" 打开 Dialog', async ({ page }) => {
    await page.goto('/commission')
    await page.getByRole('button', { name: '新增规则' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('所属市场')).toBeVisible()
  })

  test('Dialog 取消关闭', async ({ page }) => {
    await page.goto('/commission')
    await page.getByRole('button', { name: '新增规则' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('市场 Tab 可切换', async ({ page }) => {
    await page.goto('/commission')
    const tabs = page.getByRole('tab')
    const count = await tabs.count()
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i)
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
    }
  })

  test('筛选 select 完整', async ({ page }) => {
    await page.goto('/commission')
    expect(await page.locator('select').count()).toBeGreaterThanOrEqual(3)
  })
})

// ============================================================
// 优惠券 — 导航 + 创建表单验证 + 联动
// ============================================================
test.describe('优惠券按钮交互', () => {
  test('"新增优惠券" 导航到创建页', async ({ page }) => {
    await page.goto('/coupons')
    await page.getByText('新增优惠券').click()
    await expect(page).toHaveURL(/\/coupons\/create/)
  })

  test('创建页: "返回" 按钮导航', async ({ page }) => {
    await page.goto('/coupons/create')
    await page.getByRole('button', { name: /返回/ }).click()
    await expect(page).not.toHaveURL(/\/coupons\/create/)
  })

  test('创建页: "取消" 按钮导航', async ({ page }) => {
    await page.goto('/coupons/create')
    await page.getByRole('button', { name: /取消/ }).click()
    await expect(page).not.toHaveURL(/\/coupons\/create/)
  })

  test('创建页: 空提交显示验证错误', async ({ page }) => {
    await page.goto('/coupons/create')
    await page.getByRole('button', { name: /创建优惠券/ }).click()
    await expectToast(page, /请输入|请选择/)
  })

  test('创建页: 券类型切换联动', async ({ page }) => {
    await page.goto('/coupons/create')
    const typeSelect = page.locator('select').first()
    await typeSelect.selectOption('折扣券')
    await expect(page.getByText('折扣率')).toBeVisible()
    await typeSelect.selectOption('现金券')
    await expect(page.getByText('面值')).toBeVisible()
  })

  test('创建页: 有效期模式切换联动', async ({ page }) => {
    await page.goto('/coupons/create')
    const modeSelect = page.locator('select').last()
    await modeSelect.selectOption('fixed')
    await expect(page.getByText('开始日期')).toBeVisible()
    await modeSelect.selectOption('days')
    await expect(page.getByText('有效天数')).toBeVisible()
  })
})

// ============================================================
// 预约管理 — Tab
// ============================================================
test.describe('预约按钮交互', () => {
  test('4 个 Tab 均可切换', async ({ page }) => {
    await page.goto('/appointments')
    for (const name of ['待确认', '已确认', '今日', '全部']) {
      const tab = page.getByRole('tab', { name: new RegExp(name) })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
    }
  })
})

// ============================================================
// 权限管理 — Dialog + Tab + 角色切换
// ============================================================
test.describe('权限按钮交互', () => {
  test('"分配角色" 打开 Dialog', async ({ page }) => {
    await page.goto('/permissions')
    // 页面存在多个「分配角色」按钮（页头 + 角色行），取第一个（页头按钮）
    await page.getByRole('button', { name: '分配角色', exact: true }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('Dialog 取消关闭', async ({ page }) => {
    await page.goto('/permissions')
    await page.getByRole('button', { name: '分配角色', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).not.toBeVisible()
  })

  test('Tab 切换', async ({ page }) => {
    await page.goto('/permissions')
    await page.getByRole('tab', { name: '按员工查看' }).click()
    await expect(page.getByRole('tab', { name: '按员工查看' })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: '按角色查看' }).click()
    await expect(page.getByRole('tab', { name: '按角色查看' })).toHaveAttribute('aria-selected', 'true')
  })

  test('角色按钮可点击', async ({ page }) => {
    await page.goto('/permissions')
    const roleBtn = page.getByRole('button', { name: '系统管理员' })
    await expect(roleBtn).toBeVisible()
    await roleBtn.click()
    await expect(page.getByRole('heading', { name: '权限管理' })).toBeVisible()
  })
})

// ============================================================
// 组织架构 — 新增/编辑按钮
// ============================================================
test.describe('组织架构按钮交互', () => {
  test('"新增根节点" 按钮有响应', async ({ page }) => {
    await page.goto('/org')
    await page.getByRole('button', { name: '新增根节点' }).click()
    await expectToast(page, '功能开发中')
  })

  test('"编辑" 按钮有响应', async ({ page }) => {
    await page.goto('/org')
    const editBtn = page.getByRole('button', { name: '编辑' })
    if (await editBtn.isVisible()) {
      await editBtn.click()
      await expectToast(page, '功能开发中')
    }
  })

  test('"新增子节点" 按钮有响应', async ({ page }) => {
    await page.goto('/org')
    const btn = page.getByRole('button', { name: '新增子节点' })
    if (await btn.isVisible()) {
      await btn.click()
      await expectToast(page, '功能开发中')
    }
  })
})

// ============================================================
// 数据同步 — 同步按钮
// ============================================================
test.describe('数据同步按钮交互', () => {
  test('"触发全量同步" 有响应', async ({ page }) => {
    await page.goto('/sync')
    await page.getByRole('button', { name: '触发全量同步' }).click()
    await expectToast(page, /全量同步/)
  })

  test('"触发增量同步" 有响应', async ({ page }) => {
    await page.goto('/sync')
    await page.getByRole('button', { name: '触发增量同步' }).click()
    await expectToast(page, /增量同步/)
  })
})

// ============================================================
// 系统配置 — 保存 + 输入
// ============================================================
test.describe('系统配置按钮交互', () => {
  test('"保存" 按钮有响应', async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible({ timeout: 5000 })
  })

  test('输入框可编辑', async ({ page }) => {
    await page.goto('/settings')
    // 首个输入框是 type=number（如「新会员消费门槛」），只接受数字，不能 fill 文本
    const input = page.locator('input').first()
    await input.clear()
    await input.fill('9999')
    await expect(input).toHaveValue('9999')
  })
})

// ============================================================
// 操作日志 — 筛选器
// ============================================================
test.describe('操作日志交互', () => {
  test('操作类型 select 有选项', async ({ page }) => {
    await page.goto('/logs')
    const selectEl = page.locator('select').first()
    await expect(selectEl).toBeVisible()
    expect(await selectEl.locator('option').count()).toBeGreaterThanOrEqual(1)
  })

  test('搜索框可输入', async ({ page }) => {
    await page.goto('/logs')
    const search = page.getByPlaceholder('搜索操作人')
    await search.fill('张')
    await expect(search).toHaveValue('张')
  })
})

// ============================================================
// 侧边栏菜单 — 全部可导航
// ============================================================
test.describe('侧边栏菜单导航', () => {
  const menuItems = [
    { text: '工作台', url: /\/dashboard/ },
    { text: '订单管理', url: /\/orders/ },
    { text: '营业额分配', url: /\/allocations/ },
    { text: '服务单', url: /\/services/ },
    { text: '预约管理', url: /\/appointments/ },
    { text: '商品管理', url: /\/products/ },
    { text: '顾客管理', url: /\/customers/ },
    { text: '员工管理', url: /\/employees/ },
    { text: '门店管理', url: /\/stores/ },
    { text: '提成矩阵', url: /\/commission/ },
    { text: '组织架构', url: /\/org/ },
    { text: '优惠券', url: /\/coupons/ },
    { text: '权限管理', url: /\/permissions/ },
    { text: '数据同步', url: /\/sync/ },
    { text: '操作日志', url: /\/logs/ },
    { text: '系统配置', url: /\/settings/ },
  ]

  for (const { text, url } of menuItems) {
    test(`菜单 "${text}" 可导航`, async ({ page }) => {
      await page.goto('/dashboard')
      const link = page.locator('aside').getByText(text, { exact: true })
      if (await link.isVisible()) {
        await link.click()
        await expect(page).toHaveURL(url)
      }
    })
  }
})
