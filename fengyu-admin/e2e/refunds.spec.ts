import { test, expect } from '@playwright/test'

/**
 * ticket 2026-04-24 退款 admin 补齐 PR-Y — 退款管理页面 smoke 测试
 *
 * 与 orders-repayment.spec.ts 一致的模式：仅做路由可达性 + 关键文案渲染断言，
 * 不依赖具体数据库种子数据。复杂交互（创建/审批/驳回）由 vitest 单测覆盖。
 */

const REFUND_ID_SEED = process.env.E2E_REFUND_ID || ''

test.describe('退款管理页 — 列表 + 详情渲染（ticket 2026-04-24）', () => {
  test('列表页可达，3 Tab 渲染', async ({ page }) => {
    await page.goto('/refunds')
    await expect(page.getByRole('heading', { name: /退款/ })).toBeVisible()
    // 3 个状态 Tab 文案
    await expect(page.getByText('待审批')).toBeVisible()
    await expect(page.getByText(/已通过|已支付/)).toBeVisible()
    await expect(page.getByText(/已驳回|已关闭/)).toBeVisible()
  })

  test.skip(!REFUND_ID_SEED, '未提供 E2E_REFUND_ID：跳过详情页交互断言')

  test('详情页：关键字段 + 审批按钮按状态渲染', async ({ page }) => {
    await page.goto(`/refunds/${REFUND_ID_SEED}`)

    // 详情页关键文案
    await expect(page.getByText(/退款(单|金额)/)).toBeVisible()
    // 关联原单区块
    await expect(page.getByText(/原(销售)?单/)).toBeVisible()
    // 退款明细区块
    await expect(page.getByText(/退款明细|退款项/)).toBeVisible()

    // 若处于待审批状态，应有审批通过 + 驳回按钮
    const approveBtn = page.getByRole('button', { name: /审批通过|通过/ })
    const rejectBtn = page.getByRole('button', { name: /驳回/ })
    if (await approveBtn.isVisible()) {
      await expect(rejectBtn).toBeVisible()
    }
  })
})
