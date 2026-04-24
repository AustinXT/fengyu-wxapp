import { test, expect } from '@playwright/test'

/**
 * 2026-04-24 ticket — 开单强制顾客已注册小程序且绑定门店
 *
 * 覆盖 Step 0 UI 收紧后的可观察变更：
 * 1. 搜索未注册手机号 → 出现灰色指引卡（不再有 manualPhone 输入框）
 * 2. 按钮 "下一步" 在未选中顾客时始终 disabled
 * 3. 搜索页不再渲染"输入顾客手机号"的 Input
 *
 * 正向路径（命中 + 选中顾客 → 可进入 Step 2）由 orders-create-flow.spec.ts 已覆盖。
 */
test.describe('开单向导 — 必须选择已注册 + 已绑定门店顾客', () => {
  test('搜索不存在的手机号 → 显示灰色指引卡 + 下一步 disabled', async ({ page }) => {
    await page.goto('/orders/create')

    // 使用一个测试库几乎不可能命中的手机号
    await page.getByPlaceholder(/手机号/).fill('19999999999')
    await page.getByRole('button', { name: /搜索/ }).click()

    // 等待搜索完成（灰色指引卡或"找到 X 位顾客"出现）
    await page.waitForFunction(() => {
      const t = document.body.textContent || ''
      return t.includes('未找到已注册顾客') || t.includes('找到')
    }, { timeout: 10000 })

    // 指引卡文案出现
    await expect(page.getByText('未找到已注册顾客')).toBeVisible()
    await expect(page.getByText(/已在凤御小程序登录并绑定门店/)).toBeVisible()

    // manualPhone 输入框不再出现
    await expect(page.getByPlaceholder('输入顾客手机号')).toHaveCount(0)

    // 下一步按钮 disabled
    await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled()
  })

  test('未搜索任何关键字时 → 下一步默认 disabled', async ({ page }) => {
    await page.goto('/orders/create')
    await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled()
  })
})
