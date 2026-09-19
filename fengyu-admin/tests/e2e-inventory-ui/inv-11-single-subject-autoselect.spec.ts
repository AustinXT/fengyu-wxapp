/**
 * INV-11：候选唯一的库存主体自动选中并只读展示（#189）。
 *
 * 断言写成**数据无关的不变量**，不假设「总部只有一个」—— dev 库现在就有两个 active
 * 总部（`ORG-HQ` 品牌总部 + e2e 残留的 `TE2LS_HQ_ORG`），`org_nodes` 也没有任何
 * 约束保证唯一。不变量是：**主体字段不会出现「只有一个候选却还要你手动选」**。
 *   - 候选唯一 → 只读 `<output data-fixed-subject>`，且值已经落到表单里
 *   - 候选多个 → 仍是可选下拉（占位项 + ≥2 个候选）
 *
 * 两个方向都要覆盖，否则「把所有主体下拉都做没了」也能让测试转绿：
 *   - ADM（scope 不受限，看得到多总部 / 5 市场 / 36 门店）→ 覆盖「仍可选」
 *   - SC / MK（库存 scope 不展开后代，只看得到自己那一个主体）→ 覆盖「只读固定」
 *
 * ⚠️ 默认 skip：套件打的是**已部署的 dev 实例**，而本 spec 断言的是尚未部署的行为。
 * 目标实例部署 #189 后跑一次，绿了就把下面那行 test.skip 删掉，让它进常规套件。
 * 本地验证：
 *   ADMIN_BASE_URL=http://localhost:3010 INVT_189=1 bunx playwright test \
 *     --config=tests/e2e-inventory-ui/playwright.inventory.config.ts \
 *     tests/e2e-inventory-ui/inv-11-*.spec.ts
 */

import { test, expect, type Page } from '@playwright/test'
import { BASE, INVT_ACCOUNTS, INVT_PASS, login } from './_helpers/env'
import { labelled, openOperation } from './_helpers/ui'

test.skip(process.env.INVT_189 !== '1', '待目标实例部署 #189 后启用（设 INVT_189=1）')

test.setTimeout(180_000)

/**
 * ⚠️ `labelled()` 是 `^label` 前缀匹配，`'市场'` 会同时命中明细行的「市场批次」——
 * 一律取第一个 label（表单头部那个主体字段），否则 `toHaveCount(0)` 会被批次下拉带红。
 */
function subjectField(page: Page, labelText: string) {
  return labelled(page, labelText).first()
}

/** 核心不变量：字段要么已固定（唯一候选），要么给出真正需要做的选择（≥2 个候选）。 */
async function expectNoRedundantChoice(page: Page, labelText: string): Promise<'fixed' | 'selectable'> {
  const field = subjectField(page, labelText)
  const fixed = field.locator('[data-fixed-subject]')
  const select = field.locator('select')
  await expect(fixed.or(select).first()).toBeVisible({ timeout: 20_000 })

  if (await fixed.count() > 0) {
    await expect(select).toHaveCount(0)                      // 不留空壳下拉
    await expect(fixed.first()).not.toBeEmpty()              // 只读也要看得见主体名
    const value = await fixed.first().getAttribute('data-fixed-subject')
    expect(value?.length ?? 0).toBeGreaterThan(0)            // 值确实落到了表单
    return 'fixed'
  }
  // option 数 = 1 个占位 + N 个候选；N=1 就是本 issue 要消灭的那种冗余选择。
  expect(await select.first().locator('option').count()).toBeGreaterThanOrEqual(3)
  return 'selectable'
}

async function expectFixedTo(page: Page, labelText: string, value: string) {
  const fixed = subjectField(page, labelText).locator('[data-fixed-subject]').first()
  await expect(fixed).toBeVisible({ timeout: 20_000 })
  await expect(fixed).toHaveAttribute('data-fixed-subject', value)
}

/** 值由上游字段派生的主体：上游没选时不许自作主张固定一个（#189 评审 B-1）。 */
async function expectAwaitsUpstream(page: Page, labelText: string) {
  const field = subjectField(page, labelText)
  await expect(field.locator('select')).toHaveCount(1)
  await expect(field.locator('[data-fixed-subject]')).toHaveCount(0)
}

test.describe('INV-11 候选唯一即自动选中', () => {
  test('ADM（scope 不受限）：每个主体字段要么已固定，要么候选真的多于一个', async ({ page }) => {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    const cases: Array<[string, string, string[]]> = [
      ['supply-chain', '品项公司报货需求', ['供应链库存主体']],
      ['supply-chain', '创建采购订单', ['供应链库存主体']],
      ['supply-chain', '供应链采购订单', ['供应链库存主体']],
      ['supply-chain', '供应链采购入库', ['供应链库存主体']],
      // 这一处的 value 是 orgNodeId 而非 locationId（总部两者同值，别处不一定）。
      ['supply-chain', '品项公司发货', ['发货总部']],
      ['supply-chain', '非凤御市场出库', ['供应链库存主体']],
      ['supply-chain', '供应链员工购', ['供应链总部']],
      ['supply-chain', '供应链库存转换', ['转换库存主体']],
      ['market', '市场汇总报货', ['市场', '供应链库存主体']],
      ['market', '分院配货', ['配货市场']],
      ['market', '市场退货申请', ['退货主体']],
      ['market', '市场员工购', ['市场']],
      ['market', '自采产品入库', ['入库市场']],
      ['market', '市场库存转换', ['转换库存主体']],
      ['store', '门店报货', ['报货门店']],
      ['store', '门店退货申请', ['退货主体']],
      ['store', '门店库存转换', ['转换库存主体']],
    ]

    for (const [level, title, labels] of cases) {
      await openOperation(page, level, title)
      for (const label of labels) {
        await expectNoRedundantChoice(page, label)
      }
    }
  })

  test('派生字段在上游未选时不被自作主张固定（门店退货不会预填总部）', async ({ page }) => {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)

    // 「回库主体」的候选在未选退货主体时退化成 headquarters；若它自动选中唯一总部，
    // 用户会看到一个不可改的「品牌总部」—— 而门店退货只能退回父市场。
    await openOperation(page, 'store', '门店退货申请')
    await expectAwaitsUpstream(page, '回库主体')

    await openOperation(page, 'market', '市场退货申请')
    await expectAwaitsUpstream(page, '回库主体')

    // 「所属市场」同理：它的值由报货门店带出。
    await openOperation(page, 'store', '门店报货')
    await expectAwaitsUpstream(page, '所属市场')
  })

  test('SC（库存 scope 只含总部）：总部字段只读固定，异步联动照常触发', async ({ page }) => {
    await login(page, INVT_ACCOUNTS.SC.phone, INVT_PASS)

    await openOperation(page, 'supply-chain', '品项公司报货需求')
    expect(await expectNoRedundantChoice(page, '供应链库存主体')).toBe('fixed')
    await expectFixedTo(page, '供应链库存主体', INVT_ACCOUNTS.SC.scopeId)

    await openOperation(page, 'supply-chain', '品项公司发货')
    await expectFixedTo(page, '发货总部', INVT_ACCOUNTS.SC.scopeId)

    await openOperation(page, 'supply-chain', '供应链库存转换')
    await expectFixedTo(page, '转换库存主体', INVT_ACCOUNTS.SC.scopeId)

    // 最硬的一条：自动选中必须经表单自己的 onChange 走。供应链员工购的 onChange 是
    // 异步的（按主体去拉员工列表），组件若把值自己吞了，这里会一直停在
    // 「请先选择供应链总部」且下拉禁用。
    await openOperation(page, 'supply-chain', '供应链员工购')
    await expectFixedTo(page, '供应链总部', INVT_ACCOUNTS.SC.scopeId)
    const employees = labelled(page, '购买员工').locator('select').first()
    await expect(employees).toBeEnabled({ timeout: 30_000 })
    await expect(employees.locator('option').first()).not.toHaveText('请先选择供应链总部')
  })

  test('MK（库存 scope 只含一个市场）：市场字段只读固定', async ({ page }) => {
    await login(page, INVT_ACCOUNTS.MK.phone, INVT_PASS)

    await openOperation(page, 'market', '市场汇总报货')
    await expectFixedTo(page, '市场', INVT_ACCOUNTS.MK.scopeId)

    await openOperation(page, 'market', '市场员工购')
    await expectFixedTo(page, '市场', INVT_ACCOUNTS.MK.scopeId)
    // 市场员工购的 onChange 同样是异步拉员工，验证联动没被吞。
    await expect(labelled(page, '购买员工').locator('select').first()).toBeEnabled({ timeout: 30_000 })

    await openOperation(page, 'market', '市场库存转换')
    await expectFixedTo(page, '转换库存主体', INVT_ACCOUNTS.MK.scopeId)
  })

  test('库存查询：候选唯一的层级不渲染下拉，但保住无障碍名', async ({ page }) => {
    await login(page, INVT_ACCOUNTS.SC.phone, INVT_PASS)
    await page.goto(`${BASE}/inventory/stocks`)
    await page.waitForLoadState('networkidle')
    // 供应链 scope 只有总部本级：两级都没有选择余地，但字段名仍要念得出来。
    await expect(page.locator('select[aria-label="库存市场层级"]')).toHaveCount(0)
    await expect(page.locator('select[aria-label="库存门店层级"]')).toHaveCount(0)
    await expect(page.getByLabel('库存市场层级')).toHaveAttribute('data-fixed-subject', /.+/)
    await expect(page.getByLabel('库存门店层级')).toHaveAttribute('data-fixed-subject', /.+/)
  })

  test('库存查询：ADM 的一级仍可切换，总部视角二级降级只读', async ({ page }) => {
    await login(page, INVT_ACCOUNTS.ADM.phone, INVT_PASS)
    await page.goto(`${BASE}/inventory/stocks`)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('select[aria-label="库存市场层级"]')).toHaveCount(1)
    // 选中总部时二级只剩「供应链库存」一项。
    await expect(page.locator('select[aria-label="库存门店层级"]')).toHaveCount(0)
    await expect(page.getByLabel('库存门店层级')).toHaveText('供应链库存')
  })
})
