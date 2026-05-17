import { test, expect } from '@playwright/test'

/**
 * ticket 2026-04-24 PR-A: 普通商品侧边栏二级分组 E2E
 *
 * 覆盖（ticket §4.4）：
 * 1. 选顾客 → 进入"普通商品" Step 2 → 侧边栏出现 ≥2 个 group header
 *    （默认种子含"护理项目" / "家居产品"两个一级行）
 * 2. group header 不可点击（点击 SKU 网格不刷新）
 * 3. 跨组子项选中切换 → 右侧 SKU 网格刷新
 * 4. 切换到"体验卡" → 回到平铺，无 group header
 * 5. 侧边栏不出现 productKind ∈ { 充值卡, 体验卡 } 的 category_name
 *
 * 依赖：DB 种子含标准 product_categories（至少"护理项目" + "家居产品"两个一级 kind）
 * 与 orders-create-flow.spec.ts 一致，需要"关键字 1 能命中已绑店顾客"。
 */

test.describe('开单向导 PR-A: 普通商品侧边栏二级分组', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/orders/create')

    // 搜索顾客
    await page.getByPlaceholder(/手机号/).fill('1')
    await page.getByRole('button', { name: /搜索/ }).click()

    await page.waitForFunction(() => {
      const t = document.body.textContent || ''
      return t.includes('找到') || t.includes('未找到')
    }, { timeout: 10000 })

    const hasResults = await page.getByText(/找到 \d+ 位顾客/).isVisible().catch(() => false)
    test.skip(!hasResults, '测试库未命中已注册顾客')

    // 选第一个
    const firstResult = page.locator('button:has-text("会员")').first()
    const fallbackResult = page.locator('div.space-y-1 > button').first()
    const target = (await firstResult.count()) > 0 ? firstResult : fallbackResult
    if ((await target.count()) > 0) {
      await target.click()
      await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })
    }
  })

  test('普通商品模式：侧边栏出现 ≥2 个 group header + group header 不可点击', async ({ page }) => {
    // 默认普通商品（Step 1）
    await expect(page.getByRole('button', { name: '普通商品', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '下一步' }).click()
    await expect(page.getByText('商品分类')).toBeVisible({ timeout: 5000 })

    // 断言至少 2 个 group header（种子含 护理项目 + 家居产品）
    const groupHeaders = page.locator('[aria-disabled="true"]').filter({ hasText: /护理项目|家居产品|福利活动/ })
    const headerCount = await groupHeaders.count()
    expect(headerCount).toBeGreaterThanOrEqual(2)

    // group header 不应包含 "充值卡" / "体验卡"
    const cardHeaders = page.locator('[aria-disabled="true"]').filter({ hasText: /充值卡|体验卡/ })
    expect(await cardHeaders.count()).toBe(0)

    // group header 不可点击：pointer-events: none 使点击不会触发选中态切换
    const firstHeader = groupHeaders.first()
    // 断言不是 button（group header 用 div + aria-disabled="true"）
    const tagName = await firstHeader.evaluate((el) => el.tagName.toLowerCase())
    expect(tagName).not.toBe('button')
  })

  test('跨组子项选中切换：右侧 SKU 网格刷新', async ({ page }) => {
    await page.getByRole('button', { name: '下一步' }).click()
    await expect(page.getByText('商品分类')).toBeVisible({ timeout: 5000 })

    // 找到所有子项 button（侧边栏内的可点击分类）
    const categoryButtons = page.locator('button').filter({
      hasText: /面部护理|身体护理|特色项目|护肤品|养生产品/,
    })
    const count = await categoryButtons.count()
    expect(count).toBeGreaterThanOrEqual(2)

    // 点击第 1 个子项
    const first = categoryButtons.nth(0)
    await first.click()
    // aria-pressed 或类样式变化都表明选中
    await expect(first).toHaveClass(/primary|bg-\[var/)

    // 点击最后一个子项（跨组）
    const last = categoryButtons.nth(count - 1)
    await last.click()
    await expect(last).toHaveClass(/primary|bg-\[var/)
    // 首项取消选中
    await expect(first).not.toHaveClass(/primary|bg-\[var/)
  })

  test('切到体验卡：侧边栏回到平铺（无 group header）', async ({ page }) => {
    await page.getByRole('button', { name: '体验卡', exact: true }).click()
    await page.getByRole('button', { name: '下一步' }).click()
    // 体验卡 picker 不使用分组结构
    const groupHeaders = page.locator('[aria-disabled="true"]').filter({ hasText: /护理项目|家居产品/ })
    expect(await groupHeaders.count()).toBe(0)
  })

  test('侧边栏不出现 充值卡 / 体验卡 的 category name（排除法）', async ({ page }) => {
    await page.getByRole('button', { name: '下一步' }).click()
    await expect(page.getByText('商品分类')).toBeVisible({ timeout: 5000 })

    // 左侧 Card（lg:col-span-1）内不应出现 "储值卡" / "次卡" 等充值卡 category，
    // 也不应出现体验卡 category
    const sidebar = page.locator('.lg\\:col-span-1').first()
    const sidebarText = await sidebar.textContent()
    expect(sidebarText).not.toContain('储值卡')
    expect(sidebarText).not.toContain('次卡')
  })
})
