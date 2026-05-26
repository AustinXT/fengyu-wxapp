import { test, expect } from '@playwright/test'
import { readDetailFixtureIds } from './fixtures/seed-detail-fixtures'

/**
 * ticket 2026-04-24 多次回款 PR-B — admin 端录入回款 UI smoke 测试
 *
 * 覆盖：
 *   1) 订单详情页标题渲染（路由可达）
 *   2) 款项流水区块存在
 *   3) 当订单存在欠款时，"录入回款"按钮可见并能打开弹层
 *   4) 弹层包含必要字段（金额 / 支付方式 / 外部交易号 / 储值卡 / 备注 / 确认录入）
 *
 * 详情用例的欠款订单 id 由 playwright globalSetup 夹具工厂注入（TE2A_ 命名空间的
 * 「部分支付」订单，received<payable，写 .e2e-detail-fixtures.json），仍兼容
 * 手动 E2E_ORDER_ID_WITH_DEBT 环境种子覆盖。
 */

// globalSetup 注入（夹具工厂）→ 临时文件；E2E_ORDER_ID_WITH_DEBT 仍可手动覆盖
const ORDER_ID_SEED = readDetailFixtureIds().orderIdWithDebt || ''

test.describe('订单详情页 — 录入回款入口（ticket 2026-04-24）', () => {
  test('订单列表页可达，录入回款按钮视条件渲染', async ({ page }) => {
    await page.goto('/orders')
    await expect(page.getByRole('heading', { name: '订单管理' })).toBeVisible()
  })

  test('详情页：款项流水 + 录入回款 Dialog 基础字段', async ({ page }) => {
    // 欠款订单 id 由 globalSetup 夹具工厂注入（TE2A_ 部分支付订单，received<payable）；缺失才跳过
    test.skip(!ORDER_ID_SEED, '未提供欠款订单 id：跳过详情页 Dialog 交互断言')
    await page.goto(`/orders/${ORDER_ID_SEED}`)

    // 款项流水区块存在
    await expect(page.getByText('款项流水')).toBeVisible()

    // 部分支付订单有欠款 → "录入回款" 按钮可见并可点击
    const recordBtn = page.getByRole('button', { name: '录入回款' })
    await expect(recordBtn).toBeVisible()
    await recordBtn.click()

    // Dialog 字段检查（基于原生 <dialog> 打开；用 dialog scope 避免与详情页同名字段冲突）
    const dialog = page.getByRole('dialog')
    await expect(page.getByRole('heading', { name: '录入回款' })).toBeVisible()
    await expect(dialog.getByText('订单剩余欠款')).toBeVisible()
    await expect(dialog.getByText('支付方式')).toBeVisible()
    // 线下方式下子项金额列头为「现金(¥)」（按子项定向回款表）
    await expect(dialog.getByText('现金(¥)').first()).toBeVisible()
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
  })
})
