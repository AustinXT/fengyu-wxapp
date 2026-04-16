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

      // 3) 进入 Step 2，"商品分类" 区可见（沿用 PR-B 前的旧 UI 渲染）
      await page.getByRole('button', { name: '下一步' }).click()
      await expect(page.getByText('商品分类')).toBeVisible({ timeout: 5000 })
    } else {
      // 测试库无顾客 → 走 manualPhone 路径
      await page.getByPlaceholder('输入顾客手机号').fill('13800138001')

      // 切换商品类型
      await page.getByRole('button', { name: '体验卡', exact: true }).click()
      await expect(page.getByRole('button', { name: '体验卡', exact: true })).toHaveAttribute('aria-pressed', 'true')

      await page.getByRole('button', { name: '下一步' }).click()
      await expect(page.getByText('商品分类')).toBeVisible({ timeout: 5000 })
    }
  })
})
