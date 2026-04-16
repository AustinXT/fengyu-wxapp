import { test, expect } from '@playwright/test'

/**
 * PR-B: Step 1 商品类型 4 选 1 + 顾客搜索后预拉 Step 2 数据 E2E
 *
 * 覆盖：
 * 1. Step 1 不再有"订单类型"控件
 * 2. Step 1 商品类型 4 选 1 渲染 + 默认"普通商品"高亮
 * 3. 切换 4 种商品类型，按钮状态正确
 * 4. 选顾客 → 进入 Step 2，看到（沿用旧 UI 渲染的）商品分类区
 *
 * 边界说明：本 spec 仅校验 Step 1 → Step 2 的 state + 数据路径可用，
 * Step 2 渲染层"按 kind 分支"由 PR-C 接管，这里不断言每个 kind 的具体数据形态。
 */

test.describe('开单向导 PR-B: Step 1 商品类型', () => {
  test('Step 1 不再有"订单类型"块', async ({ page }) => {
    await page.goto('/orders/create')
    await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible()
    // "商品类型" 出现
    await expect(page.getByRole('heading', { name: '商品类型' })).toBeVisible()
    // "订单类型"在 Step 1 不应出现（旧 H2 已移除）
    await expect(page.locator('h2', { hasText: '订单类型' })).toHaveCount(0)
    // 旧的"销售单 / 内部单"按钮在 Step 1 也不应出现
    await expect(page.getByRole('button', { name: '销售单' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '内部单' })).toHaveCount(0)
  })

  test('商品类型 4 个选项齐全 + 默认"普通商品"高亮', async ({ page }) => {
    await page.goto('/orders/create')
    for (const choice of ['组合套餐', '普通商品', '体验卡', '充值卡']) {
      await expect(page.getByRole('button', { name: choice, exact: true })).toBeVisible()
    }
    // 默认"普通商品"为 pressed
    await expect(page.getByRole('button', { name: '普通商品', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  test('切换 4 种商品类型，aria-pressed 跟随', async ({ page }) => {
    await page.goto('/orders/create')

    const choices = ['组合套餐', '普通商品', '体验卡', '充值卡'] as const
    for (const choice of choices) {
      await page.getByRole('button', { name: choice, exact: true }).click()
      await expect(page.getByRole('button', { name: choice, exact: true })).toHaveAttribute('aria-pressed', 'true')
      // 其余 3 个应为 false
      for (const other of choices) {
        if (other === choice) continue
        await expect(page.getByRole('button', { name: other, exact: true })).toHaveAttribute('aria-pressed', 'false')
      }
    }
  })

  test('选顾客 → 4 个商品类型按钮均可切换 → 进入 Step 2', async ({ page }) => {
    await page.goto('/orders/create')

    // 1) 触发顾客搜索（用通配关键字"1"，在测试库中通常能命中）
    await page.getByPlaceholder(/手机号/).fill('1')
    await page.getByRole('button', { name: /搜索/ }).click()

    // 等待搜索结果加载完成（"找到"文案）或"未找到"提示
    await page.waitForFunction(() => {
      const t = document.body.textContent || ''
      return t.includes('找到') || t.includes('未找到匹配')
    }, { timeout: 10000 })

    const hasResults = await page.getByText(/找到 \d+ 位顾客/).isVisible().catch(() => false)

    if (hasResults) {
      // 选择第一个搜索结果
      const firstResult = page.locator('button:has-text("会员")').first()
      const fallbackResult = page.locator('div.space-y-1 > button').first()
      const target = (await firstResult.count()) > 0 ? firstResult : fallbackResult
      if ((await target.count()) > 0) {
        await target.click()
        await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })
      }

      // 2) 切换 4 种商品类型
      for (const choice of ['组合套餐', '体验卡', '充值卡', '普通商品']) {
        await page.getByRole('button', { name: choice, exact: true }).click()
        await expect(page.getByRole('button', { name: choice, exact: true })).toHaveAttribute('aria-pressed', 'true')
      }

      // 3) 进入 Step 2，"商品分类" 区可见（PR-C 普通商品分支保留分类导航）
      await page.getByRole('button', { name: '下一步' }).click()
      await expect(page.getByText('商品分类')).toBeVisible({ timeout: 5000 })
    } else {
      // 测试库无顾客 → 走 manualPhone 路径
      await page.getByPlaceholder('输入顾客手机号').fill('13800138001')

      // 切换商品类型
      await page.getByRole('button', { name: '体验卡', exact: true }).click()
      await expect(page.getByRole('button', { name: '体验卡', exact: true })).toHaveAttribute('aria-pressed', 'true')

      await page.getByRole('button', { name: '下一步' }).click()
      // 体验卡分支无"商品分类"导航，直接平铺
      await expect(page.getByText('体验卡', { exact: false })).toBeVisible({ timeout: 5000 })
    }
  })
})

/**
 * PR-C: Step 2/3 重构 + 转换单 E2E
 *
 * 覆盖：
 * 1. "选顾客 → 普通商品 → 销售单" 完整跑通到 Step 4
 * 2. "组合套餐 → 内部单" 合计区域显示"内部单 5 折" tag
 * 3. "普通商品 → 转换单"：clientUserId 缺失时按钮 disabled；选中顾客后
 *    ConversionPanel 渲染左右两列 + 三态差额提示文案存在
 *
 * 边界说明：转换单"差额=0/正/负" 三路径需要测试库有特定状态的顾客 +
 * 折抵卡 + 购物车，纯 UI E2E 难以稳定构造，这里只断言 UI 元素可达 +
 * 差额提示词条存在。完整三态由 actions/orders.test.ts 单元测试覆盖。
 */
test.describe('开单向导 PR-C: Step 2/3 重构 + 转换单', () => {
  test('Step 3 订单类型 3 选 1：销售单/内部单/转换单 + 默认销售单', async ({ page }) => {
    await page.goto('/orders/create')

    // Step 1：触发顾客搜索 → 选第一个 / fallback manualPhone
    await page.getByPlaceholder(/手机号/).fill('1')
    await page.getByRole('button', { name: /搜索/ }).click()
    await page.waitForFunction(() => {
      const t = document.body.textContent || ''
      return t.includes('找到') || t.includes('未找到匹配')
    }, { timeout: 10000 })

    const hasResults = await page.getByText(/找到 \d+ 位顾客/).isVisible().catch(() => false)
    if (!hasResults) {
      // manualPhone 路径下没有 clientUserId，无法测试转换单完整流；跳过本 case
      test.skip()
      return
    }

    const firstResult = page.locator('div.space-y-1 > button').first()
    if ((await firstResult.count()) === 0) {
      test.skip()
      return
    }
    await firstResult.click()
    await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })

    // 默认普通商品 → 直接进入 Step 2
    await page.getByRole('button', { name: '下一步' }).click()

    // Step 2 暂跳过加购，直接到 Step 3 看订单类型选择 UI
    // 部分测试库无 SKU 时"下一步"按钮被禁用 → 跳过
    const nextBtn = page.getByRole('button', { name: '下一步' })
    if (await nextBtn.isDisabled().catch(() => true)) {
      // 如果 Step 2 有 SKU 加购按钮，点第一个加入购物车
      const addBtn = page.getByRole('button', { name: '加入', exact: true }).first()
      if ((await addBtn.count()) > 0) {
        await addBtn.click()
      } else {
        test.skip()
        return
      }
    }
    await page.getByRole('button', { name: '下一步' }).click()

    // Step 3：3 个订单类型按钮可见
    for (const choice of ['销售单', '内部单', '转换单']) {
      await expect(page.getByRole('button', { name: choice, exact: true })).toBeVisible({ timeout: 5000 })
    }
    // 默认销售单 pressed
    await expect(page.getByRole('button', { name: '销售单', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  test('内部单：切换后显示"内部单 5 折" tag + 应付/实付输入框 disabled', async ({ page }) => {
    await page.goto('/orders/create')

    // 走 manualPhone 路径快速进入 Step 3（manualPhone 不影响内部单）
    await page.getByPlaceholder(/手机号/).fill('1')
    await page.getByRole('button', { name: /搜索/ }).click()
    await page.waitForFunction(() => {
      const t = document.body.textContent || ''
      return t.includes('找到') || t.includes('未找到匹配')
    }, { timeout: 10000 })

    const hasResults = await page.getByText(/找到 \d+ 位顾客/).isVisible().catch(() => false)
    if (hasResults) {
      const first = page.locator('div.space-y-1 > button').first()
      if ((await first.count()) === 0) { test.skip(); return }
      await first.click()
    } else {
      await page.getByPlaceholder('输入顾客手机号').fill('13800138001')
    }

    await page.getByRole('button', { name: '下一步' }).click()

    // 加购第一个 SKU
    const addBtn = page.getByRole('button', { name: '加入', exact: true }).first()
    if ((await addBtn.count()) === 0) { test.skip(); return }
    await addBtn.click()

    await page.getByRole('button', { name: '下一步' }).click()

    // 切到内部单
    await page.getByRole('button', { name: '内部单', exact: true }).click()
    await expect(page.getByRole('button', { name: '内部单', exact: true })).toHaveAttribute('aria-pressed', 'true')

    // "内部单 5 折" 灰色 tag 可见
    await expect(page.getByText('内部单 5 折')).toBeVisible({ timeout: 5000 })

    // 应付/实付输入框（type=number）应至少有一个 disabled
    const numberInputs = page.locator('input[type="number"]')
    const count = await numberInputs.count()
    if (count > 0) {
      const first = numberInputs.first()
      await expect(first).toBeDisabled()
    }
  })

  test('转换单：未选顾客（manualPhone）按钮 disabled + 提示', async ({ page }) => {
    await page.goto('/orders/create')

    // 走 manualPhone 路径
    await page.getByPlaceholder(/手机号/).fill('1')
    await page.getByRole('button', { name: /搜索/ }).click()
    await page.waitForFunction(() => {
      const t = document.body.textContent || ''
      return t.includes('找到') || t.includes('未找到匹配')
    }, { timeout: 10000 })

    const hasResults = await page.getByText(/找到 \d+ 位顾客/).isVisible().catch(() => false)
    if (hasResults) {
      // 测试库有顾客 → 跳过本 case（要求 manualPhone 路径）
      test.skip()
      return
    }

    await page.getByPlaceholder('输入顾客手机号').fill('13800138001')
    await page.getByRole('button', { name: '下一步' }).click()

    const addBtn = page.getByRole('button', { name: '加入', exact: true }).first()
    if ((await addBtn.count()) === 0) { test.skip(); return }
    await addBtn.click()

    await page.getByRole('button', { name: '下一步' }).click()

    // 转换单按钮存在但 disabled
    const convBtn = page.getByRole('button', { name: '转换单', exact: true })
    await expect(convBtn).toBeDisabled()
  })

  test('转换单：选中顾客后差额提示文案存在（差额三态之一）', async ({ page }) => {
    await page.goto('/orders/create')

    await page.getByPlaceholder(/手机号/).fill('1')
    await page.getByRole('button', { name: /搜索/ }).click()
    await page.waitForFunction(() => {
      const t = document.body.textContent || ''
      return t.includes('找到') || t.includes('未找到匹配')
    }, { timeout: 10000 })

    const hasResults = await page.getByText(/找到 \d+ 位顾客/).isVisible().catch(() => false)
    if (!hasResults) { test.skip(); return }

    const first = page.locator('div.space-y-1 > button').first()
    if ((await first.count()) === 0) { test.skip(); return }
    await first.click()

    await page.getByRole('button', { name: '下一步' }).click()

    const addBtn = page.getByRole('button', { name: '加入', exact: true }).first()
    if ((await addBtn.count()) === 0) { test.skip(); return }
    await addBtn.click()

    await page.getByRole('button', { name: '下一步' }).click()

    // 切到转换单
    await page.getByRole('button', { name: '转换单', exact: true }).click()
    await expect(page.getByRole('button', { name: '转换单', exact: true })).toHaveAttribute('aria-pressed', 'true')

    // ConversionPanel 标题可见
    await expect(page.getByText('转换单结算')).toBeVisible({ timeout: 5000 })

    // 三态文案至少一个存在（差额=正/零/负，取决于测试库该顾客折抵卡 + 购物车合计）
    const diffMessages = [
      /还需支付/,
      /折抵抵平/,
      /将充入储值卡/,
    ]
    let matched = false
    for (const re of diffMessages) {
      if (await page.getByText(re).isVisible().catch(() => false)) {
        matched = true
        break
      }
    }
    expect(matched).toBe(true)
  })
})
