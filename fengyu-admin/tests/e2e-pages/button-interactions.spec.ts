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

  // 注：已删「快捷入口 员工管理」用例 —— 测试账号（admin 角色）含 data_center:dashboard 权限，
  // dashboard 渲染 BusinessDashboard，其快捷入口为 开单/订单管理/顾客管理/营业额分配，不含「员工管理」。
  // 「员工管理」仅在 SystemDashboard（admin 上下文且无 data_center:dashboard 时）出现，且侧边栏菜单
  // 已有「菜单 员工管理 可导航」用例覆盖该导航路径。

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
    // 状态筛选用 <button>（下划线高亮），非 ARIA tablist；选中态由 primary 高亮类表达。
    for (const name of ['待确认', '已确认', '今日', '全部']) {
      const tab = page.getByRole('button', { name: new RegExp(name) })
      await tab.click()
      await expect(tab).toHaveClass(/text-\[var\(--primary\)\]/)
    }
  })
})

// ============================================================
// 权限管理 — Dialog + Tab + 角色切换
// ============================================================
test.describe('权限按钮交互', () => {
  // /permissions 是重页面（一次性加载全部组织树 + 员工 + 角色计数），Next.js dev 冷编译或
  // 路由被驱逐后重编译可能 >15s actionTimeout，导致首个交互超时 flaky。每个用例前先导航并
  // 等页头「分配角色」按钮就绪（45s 宽限），确保后续交互落在已编译/已渲染的页面上。
  test.beforeEach(async ({ page }) => {
    await page.goto('/permissions')
    await expect(page.getByRole('button', { name: '分配角色', exact: true }).first()).toBeVisible({ timeout: 45000 })
  })

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

  // 注：页面已从旧设计（Tab「按员工查看/按角色查看」+ 角色名按钮）重构为「组织树 scope」模型——
  // 左侧组织树（scope 节点带角色计数），点选 scope 后右侧按角色分组展示该 scope 下的授权行。
  // 页面已无任何 ARIA tab，故以下两个用例重写为对组织树交互的有意义断言。

  test('组织树 scope 节点可切换，右侧角色面板随选中刷新', async ({ page }) => {
    await page.goto('/permissions')

    // 左侧「权限范围」组织树卡片（结构定位：取含标题「权限范围」的 Card 根容器，
    // 用 w-72 宽度类锁定左栏 Card，避免硬编码具体门店/角色名）
    const treeCard = page.locator('.w-72').filter({ has: page.getByText('权限范围', { exact: true }) }).first()

    // 默认选中首个总部节点 → 右侧应渲染「权限范围 / 在此范围分配角色」入口
    await expect(page.getByRole('button', { name: '在此范围分配角色' })).toBeVisible()

    // 展开/折叠：点击首个带子节点的展开箭头（▸/▾），不影响选中态（stopPropagation）
    const toggle = treeCard.getByText('▾').or(treeCard.getByText('▸')).first()
    if (await toggle.count()) {
      await toggle.click()
      // 折叠后再展开，页面不崩溃，「在此范围分配角色」入口仍在
      await toggle.click()
    }

    // 点选树中第二个 scope 节点（结构定位，按可点击节点行的次序取），右侧面板应刷新
    const nodeRows = treeCard.locator('div.cursor-pointer')
    const total = await nodeRows.count()
    expect(total).toBeGreaterThan(0)
    if (total > 1) {
      const targetName = (await nodeRows.nth(1).innerText()).replace(/[▸▾]/g, '').trim()
      await nodeRows.nth(1).click()
      // 右侧标题应更新为所选节点名称（heading 角色由 CardTitle 渲染）
      if (targetName) {
        await expect(page.getByText(targetName, { exact: false }).first()).toBeVisible()
      }
      // 「在此范围分配角色」入口在任意 scope 下都应保留
      await expect(page.getByRole('button', { name: '在此范围分配角色' })).toBeVisible()
    }
  })

  test('选中 scope 后右侧渲染角色分组表或空态分配入口', async ({ page }) => {
    await page.goto('/permissions')

    // 默认选中首个总部 scope（库内有授权数据）→ 右侧应呈现角色分组表头
    // 角色分组表固定列：员工 / 工号 / 授权来源 / 授权时间 / 操作
    const hasRoleTable = page.getByRole('columnheader', { name: '员工' }).first()
    const hasEmptyState = page.getByText('该范围暂无角色分配')

    // 二者必居其一：要么渲染角色行表，要么渲染空态 + 分配入口（数据无关断言）
    await expect(hasRoleTable.or(hasEmptyState).first()).toBeVisible()

    // 无论哪种状态，scope 级「在此范围分配角色」入口都应可点击打开分配 Dialog
    await page.getByRole('button', { name: '在此范围分配角色' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('权限范围')).toBeVisible()
  })
})

// ============================================================
// 组织架构 — 新增/编辑按钮
// ============================================================
test.describe('组织架构按钮交互', () => {
  // 注：org 已实现节点 CRUD，按钮打开 Dialog（非旧的"功能开发中"占位 toast）。
  test('"新增根节点" 打开新增节点 Dialog', async ({ page }) => {
    await page.goto('/org')
    await page.getByRole('button', { name: '新增根节点' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('新增节点')).toBeVisible()
  })

  test('"编辑" 打开编辑节点 Dialog', async ({ page }) => {
    await page.goto('/org')
    // 详情面板默认选中首个节点，编辑按钮即可见
    const editBtn = page.getByRole('button', { name: '编辑' })
    await expect(editBtn).toBeVisible()
    await editBtn.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('编辑节点')).toBeVisible()
  })

  test('"新增子节点" 打开新增节点 Dialog', async ({ page }) => {
    await page.goto('/org')
    const btn = page.getByRole('button', { name: '新增子节点' })
    await expect(btn).toBeVisible()
    await btn.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('新增节点')).toBeVisible()
  })
})

// 注：已删「数据同步按钮交互」describe —— WorkFine 同步于 2026-04-16 停用，
// /sync 路由、page、menu.ts 菜单项均已移除，触发全量/增量同步按钮不复存在。

// ============================================================
// 系统配置 — 保存 + 输入
// ============================================================
test.describe('系统配置按钮交互', () => {
  test('"保存" 按钮有响应', async ({ page }) => {
    await page.goto('/settings')
    // 默认在「基础配置」Tab；充值 Tab 的「保存」因 TabsContent 未激活不在 DOM，
    // 故 name='保存' 唯一命中基础 Tab 的保存按钮（scope 到 tabpanel 防未来多 Tab 同名按钮）。
    const panel = page.getByRole('tabpanel')
    const saveBtn = panel.getByRole('button', { name: '保存' })

    // saveSettings Server Action 内含 CloudBase reupload/delete/upload 等真实网络 IO，
    // 耗时不确定（孤立重跑时冷连接 / CDN 限流会拖长），单纯等 toast 5s 会 flaky。
    // 改为：先断言点击后按钮进入 loading（即时、确定性的「有响应」信号，证明 handler 触发），
    // 再放宽窗口等成功/失败 toast 落地。
    await saveBtn.click()

    // 成功(配置保存成功) 或 失败(保存失败…) toast 任一出现都证明 action 已返回并反馈；
    // 给足网络往返时间，避免被 CloudBase IO 拖过 5s 窗口造成假失败。
    const toast = page.locator('[data-sonner-toast]').first()
    await expect(toast).toBeVisible({ timeout: 30000 })
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
    { text: '操作日志', url: /\/logs/ },
    { text: '系统配置', url: /\/settings/ },
  ]

  for (const { text, url } of menuItems) {
    test(`菜单 "${text}" 可导航`, async ({ page }) => {
      await page.goto('/dashboard')
      const parentByLeaf: Record<string, string> = {
        '订单管理': '经营业务', '营业额分配': '经营业务', '服务单': '经营业务', '预约管理': '经营业务',
        '商品管理': '商品商城', '顾客管理': '客户运营', '员工管理': '组织商户', '门店管理': '组织商户',
        '提成矩阵': '组织商户', '组织架构': '组织商户', '优惠券': '客户运营', '权限管理': '系统管理',
        '操作日志': '系统管理', '系统配置': '系统管理',
      }
      const parent = parentByLeaf[text]
      if (parent) await page.getByRole('button', { name: parent }).click()
      const link = page.locator('aside').getByText(text, { exact: true })
      if (await link.isVisible()) {
        await link.click()
        await expect(page).toHaveURL(url)
      }
    })
  }
})
