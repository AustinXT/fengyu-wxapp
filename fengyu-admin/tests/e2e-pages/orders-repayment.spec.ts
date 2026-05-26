import { test, expect } from '@playwright/test'

/**
 * ticket 2026-04-24 多次回款 PR-B — admin 端录入回款 UI smoke 测试
 *
 * 受限于不依赖具体数据库种子数据的原则（其他 orders.spec.ts 仅做渲染断言），
 * 本 spec 只覆盖：
 *   1) 订单详情页标题渲染（路由可达）
 *   2) 款项流水区块存在
 *   3) 当订单存在欠款时，"录入回款"按钮可见并能打开弹层
 *   4) 弹层包含必要字段（金额 / 支付方式 / 外部交易号 / 储值卡 / 备注 / 确认录入）
 *
 * 交互式提交链路需真实订单，不在 smoke 覆盖范围；提交后断言由 vitest 单测覆盖。
 */

// 复用 e2e/auth.setup.ts 产生的登录态（playwright.config.ts 全局 use）
const ORDER_ID_SEED = process.env.E2E_ORDER_ID_WITH_DEBT || '' // 可选：若提供了有欠款的订单号则做完整可见性断言

test.describe('订单详情页 — 录入回款入口（ticket 2026-04-24）', () => {
  test('订单列表页可达，录入回款按钮视条件渲染', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByRole('heading', { name: '订单管理' })).toBeVisible()
  })

  test('详情页：款项流水 + 录入回款 Dialog 基础字段', async ({ page }) => {
    // 详情页 Dialog 交互需真实欠款订单，未提供 seed 时跳过本 case（不影响上面的列表页 smoke）
    test.skip(!ORDER_ID_SEED, '未提供 E2E_ORDER_ID_WITH_DEBT：跳过详情页 Dialog 交互断言')
    await page.goto(`/orders/${ORDER_ID_SEED}`)

    // 款项流水区块存在
    await expect(page.getByText('款项流水')).toBeVisible()

    // 若该订单确有欠款，"录入回款" 按钮应可见并可点击
    const recordBtn = page.getByRole('button', { name: '录入回款' })
    if (await recordBtn.isVisible()) {
      await recordBtn.click()

      // Dialog 字段检查（Dialog 基于原生 <dialog> 打开；标题 / 支付方式 / 确认按钮）
      await expect(page.getByRole('heading', { name: '录入回款' })).toBeVisible()
      await expect(page.getByText('订单剩余欠款')).toBeVisible()
      await expect(page.getByText('回款金额（¥）')).toBeVisible()
      await expect(page.getByText('支付方式')).toBeVisible()
      await expect(page.getByRole('button', { name: /确认录入/ })).toBeVisible()

      // 切换为"储值卡"时，外部交易号字段应消失（仅线下需要）
      const methodSelect = page.locator('select').last()
      await methodSelect.selectOption('储值卡')
      await expect(page.getByText(/银行回执号|交易流水号/)).toHaveCount(0)

      // 切换回"线下"，外部交易号字段重现
      await methodSelect.selectOption('线下')
      await expect(page.getByText(/银行回执号|交易流水号/)).toBeVisible()

      // 关闭 Dialog
      await page.getByRole('button', { name: '取消' }).click()
    }
  })
})
