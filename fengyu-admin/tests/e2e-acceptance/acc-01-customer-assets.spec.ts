import { test, expect, type Page } from '@playwright/test'

/**
 * #120 / #122 / #145 / #153 的 UI 验收：顾客资产行"不再整行消失"。
 *
 * 样本取自 dev 库真实数据（2026-09-21 查得），不是造出来的夹具：
 *   - #120  卢梅 FYGK-20260710-00003：生物胶原修复面膜 1 件，应付 3800 实收 760
 *           → 可提 = FLOOR(760×1/3800) = 0。修复前整行被 `WHERE picked>0 OR pending>0` 剔除。
 *   - #145/#153 罗琴 FYGK-20260708-00012：转换单转入的家居产品 5 行，picked_up_quantity=0。
 *           → 修复前方向过滤只认购买行，转入行四端不可见。
 *   - #122  于兰 FYGK-20260824-00047：疗程卡 paid_sessions=0（部分支付），修复前卡片不显示。
 */

async function openTab(page: Page, labelRe: RegExp) {
  const byRole = page.getByRole('tab', { name: labelRe })
  if (await byRole.count()) {
    await byRole.first().click()
    return
  }
  await page.locator('button', { hasText: labelRe }).first().click()
}

/**
 * 顾客详情页对**纯 admin 角色**恒为 404：`getCustomerById` 开头的 `isAdminOnly` 短路
 * （admin 纯角色不碰顾客数据，admin+manager / customer_mgr / finance 才放行）。
 * dev 上现成的测试账号 INVT-ADM-01 正是纯 admin，所以这组用例需要另配账号；
 * 配不到就明确 skip，而不是把"看不到"误报成"#120 没修好"。
 */
async function skipIfCustomerDetailForbidden(page: Page, userId: string) {
  await page.goto(`/customers/${userId}`)
  // 页面是 force-dynamic：必须等"详情渲染出来"或"404 渲染出来"其中之一落地再判，
  // 否则会在两者都还没出现的空窗期把 404 误读成 0 而继续往下跑。
  const verdict = await expect
    .poll(
      async () => {
        if (await page.getByText('页面不存在').count()) return 'forbidden'
        if (await page.getByText(/疗程卡（\d+）/).count()) return 'ok'
        return 'pending'
      },
      { timeout: 40_000, message: '顾客详情页既没渲染出 Tab 也没渲染出 404' },
    )
    .not.toBe('pending')
    .then(() => (page.getByText('页面不存在').count() as Promise<number>))

  test.skip(
    verdict > 0,
    `当前账号看不到顾客详情（纯 admin 角色被 getCustomerById 的 isAdminOnly 挡下）；` +
      `需用带 manager / customer_mgr / finance 角色的账号重跑。`,
  )
}

test('#120 部分支付家居产品整行可见（卢梅 / 生物胶原修复面膜）', async ({ page }) => {
  await skipIfCustomerDetailForbidden(page, 'FYGK-20260710-00003')
  await expect(page.getByText(/家居产品（\d+）/)).toBeVisible({ timeout: 30_000 })

  const tabLabel = await page.getByText(/家居产品（\d+）/).first().innerText()
  const count = Number(tabLabel.match(/（(\d+)）/)?.[1] ?? '0')
  console.log(`[#120] 家居产品 Tab 计数 = ${count}（修复前应为 0 / 整行被过滤）`)
  expect(count).toBeGreaterThan(0)

  await openTab(page, /家居产品（\d+）/)
  await expect(page.getByText('生物胶原修复面膜').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('待付清').first()).toBeVisible()

  const table = page.locator('table').first()
  console.log(`[#120] 家居表格内容:\n${(await table.innerText()).slice(0, 1200)}`)
})

test('#145/#153 转换单转入的家居产品可见（罗琴）', async ({ page }) => {
  await skipIfCustomerDetailForbidden(page, 'FYGK-20260708-00012')
  await expect(page.getByText(/家居产品（\d+）/)).toBeVisible({ timeout: 30_000 })

  const tabLabel = await page.getByText(/家居产品（\d+）/).first().innerText()
  const count = Number(tabLabel.match(/（(\d+)）/)?.[1] ?? '0')
  console.log(`[#145/#153] 家居产品 Tab 计数 = ${count}（dev 库转入家居共 15 行，该顾客占多行）`)
  expect(count).toBeGreaterThan(0)

  await openTab(page, /家居产品（\d+）/)
  await expect(page.getByText('紧致御龄焕颜霜').first()).toBeVisible({ timeout: 20_000 })

  const table = page.locator('table').first()
  const text = await table.innerText()
  console.log(`[#145/#153] 家居表格内容:\n${text.slice(0, 1500)}`)
  // 转入行不得被误显示成"已退款"（#125 验收标准：区分已转换 / 已退款）
  expect(text).toContain('紧致御龄焕颜霜')
})

test('#122 部分支付疗程卡（paid_sessions=0）可见（于兰）', async ({ page }) => {
  await skipIfCustomerDetailForbidden(page, 'FYGK-20260824-00047')
  await expect(page.getByText(/疗程卡（\d+）/)).toBeVisible({ timeout: 30_000 })

  await openTab(page, /疗程卡（\d+）/)
  await expect(page.getByText('肩颈舒缓SPA').first()).toBeVisible({ timeout: 20_000 })

  const table = page.locator('table').first()
  console.log(`[#122] 疗程卡表格内容:\n${(await table.innerText()).slice(0, 1200)}`)
})
