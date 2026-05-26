import { test, expect } from '@playwright/test'
import { readDetailFixtureIds } from './fixtures/seed-detail-fixtures'

/**
 * ticket 2026-04-24 退款 admin 补齐 PR-Y — 退款管理页面 smoke 测试
 *
 * 与 orders-repayment.spec.ts 一致的模式：仅做路由可达性 + 关键文案渲染断言。
 * 详情用例的退款单 id 由 playwright globalSetup 夹具工厂注入（TE2A_ 命名空间，
 * 写 .e2e-detail-fixtures.json），仍兼容手动 E2E_REFUND_ID 环境种子覆盖。
 */

// globalSetup 注入（夹具工厂）→ 临时文件；E2E_REFUND_ID 仍可手动覆盖
const REFUND_ID_SEED = readDetailFixtureIds().refundId || ''

test.describe('退款管理页 — 列表 + 详情渲染（ticket 2026-04-24）', () => {
  test('列表页可达，3 Tab 渲染', async ({ page }) => {
    await page.goto('/refunds')
    await expect(page.getByRole('heading', { name: /退款/ })).toBeVisible()
    // 3 个状态 Tab —— 用 tab role 精确定位，避免与列表行内同名徽章（如 globalSetup
    // 注入的待审批退款单行）发生 strict mode 命中多元素。
    await expect(page.getByRole('tab', { name: '待审批' })).toBeVisible()
    await expect(page.getByRole('tab', { name: /已通过|已支付/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: /已驳回|已关闭/ })).toBeVisible()
  })

  test('详情页：关键字段 + 审批按钮按状态渲染', async ({ page }) => {
    // 退款单 id 由 globalSetup 夹具工厂注入（TE2A_ 待审批退款单）；缺失才跳过
    test.skip(!REFUND_ID_SEED, '未提供退款单 id：跳过详情页交互断言')
    await page.goto(`/refunds/${REFUND_ID_SEED}`)

    // 详情页关键区块（用 heading role 精确定位，避免 strict mode 命中卡片标题/字段标签多元素）
    await expect(page.getByRole('heading', { name: '退款单详情' })).toBeVisible()
    await expect(page.getByText('退款单信息')).toBeVisible()
    // 关联原单区块
    await expect(page.getByText('原订单概要')).toBeVisible()
    // 退款明细区块
    await expect(page.getByText('退款明细')).toBeVisible()

    // 待审批退款单（夹具固定为待审批）+ admin 有审批权 → 审批通过 + 驳回按钮可见
    await expect(page.getByRole('button', { name: '审批通过' })).toBeVisible()
    await expect(page.getByRole('button', { name: '驳回' })).toBeVisible()
  })
})
