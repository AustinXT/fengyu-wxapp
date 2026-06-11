/**
 * 链路 46：组合套餐「选N项」支持同商品多次（N 按数量合计）
 *
 * 主题：选N项分组内每个 SKU 用数量步进器，可把同一 SKU 选多次；N 按"组内数量合计"统计。
 *       前端只按 SKU 传 quantity=N，后端既有 B2 拆行规则落库：
 *         - 疗程卡 quantity>1 → 拆 N 行 quantity=1，每行 session_count=sku.session_count
 *         - 家居产品 → 合 1 行
 *
 * 夹具（本 spec 自带 seed/cleanup，不污染既有 FY-FIX-BUNDLE-01）：
 *   FY-FIX-BUNDLE-02（打包价 ¥270）含一个「任选组」pick_count=3：
 *     - B2疗程卡A（疗程卡, session_count=2, bundle_price=90）
 *     - B2家居B（家居产品, bundle_price=90）
 *
 * 操作：疗程卡A 步进到 2 + 家居B 步进到 1（合计 3 == pickCount）→ 加入套餐 → 线下下单 → 确认收款。
 *
 * 关键不变量：
 *   sale_items 行数                 = 3（疗程卡拆 2 行 + 家居 1 行）
 *   疗程卡行 quantity=1 / session_count=2 / unit_real_price=45（×2 行）
 *     （unit_real_price 是「单次价」=bundle_price 90 ÷ session_count 2；sale_amount=90 才是行总额）
 *   家居行   quantity=1 / unit_real_price=90（×1 行，无 session，单次价=行总额）
 *   SUM(sale_items.sale_amount)     = 270
 *   sale_orders.total_amount        = 270
 *   sale_orders.status              = '已支付'
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'
const MANAGER_PHONE = '13900139001'
const MANAGER_PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'

const BUNDLE_ID = 'FY-FIX-BUNDLE-02'
const BUNDLE_NAME = 'Fixture 套餐选3项 ¥270'
const SKU_CARD = 'FY-FIX-SKU-B2-CARD'
const SKU_HOME = 'FY-FIX-SKU-B2-HOME'
const SPEC_CARD = 'B2疗程卡A'
const SPEC_HOME = 'B2家居B'
const BUNDLE_TOTAL = 270
// 复用已存在的分类（缦之羽 = 疗程卡分类；歆笙泰妍 = 家居产品分类）
const CAT_CARD = 'd303ac8871eafd97'
const CAT_HOME = 'cat-fyfix-xinsheng'   // 歆笙泰妍（product_kind=家居产品，e2e fixture 真实存在）
// 套餐（mall 域）复用 FY-FIX-BUNDLE-01 同款 mall 分类（products.category_id NOT NULL）
const CAT_BUNDLE = 'mall-2aca5df619b4cfc6'

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')

function psql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu_e2e -t -A -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    throw new Error(`psql: ${err.message ?? ''}\n${err.stderr ?? ''}`)
  }
}

function seedBundle(): void {
  cleanupBundle()
  // 子 SKU
  psql(`
    INSERT INTO product_skus (sku_id, category_id, product_type, spec_name, price, session_count, created_at)
    VALUES
      ('${SKU_CARD}', '${CAT_CARD}', '疗程卡', '${SPEC_CARD}', 100, 2, NOW()),
      ('${SKU_HOME}', '${CAT_HOME}', '家居产品', '${SPEC_HOME}', 100, NULL, NOW())
  `)
  // 套餐主表（is_bundle + 可见 + 无 scope 限制；category_id NOT NULL，复用 mall 分类）
  psql(`
    INSERT INTO products (product_id, category_id, name, is_bundle, price, special_price, is_visible, sort_order, created_at)
    VALUES ('${BUNDLE_ID}', '${CAT_BUNDLE}', '${BUNDLE_NAME}', true, 300, ${BUNDLE_TOTAL}, true, 999, NOW())
  `)
  // 选N项分组 pick_count=3
  psql(`
    INSERT INTO mall_bundle_groups (product_id, group_name, pick_count, sort_order, created_at)
    VALUES ('${BUNDLE_ID}', '任选组', 3, 0, NOW())
  `)
  // SKU ↔ 分组关联（bundle_price=90）
  psql(`
    INSERT INTO mall_product_skus (product_id, sku_id, bundle_group_id, bundle_price, sort_order, created_at)
    VALUES
      ('${BUNDLE_ID}', '${SKU_CARD}', (SELECT id FROM mall_bundle_groups WHERE product_id='${BUNDLE_ID}' AND group_name='任选组'), 90, 0, NOW()),
      ('${BUNDLE_ID}', '${SKU_HOME}', (SELECT id FROM mall_bundle_groups WHERE product_id='${BUNDLE_ID}' AND group_name='任选组'), 90, 1, NOW())
  `)
}

function cleanupBundle(): void {
  psql(`DELETE FROM mall_product_skus WHERE product_id='${BUNDLE_ID}'`)
  psql(`DELETE FROM mall_bundle_groups WHERE product_id='${BUNDLE_ID}'`)
  psql(`DELETE FROM products WHERE product_id='${BUNDLE_ID}'`)
  psql(`DELETE FROM product_skus WHERE sku_id IN ('${SKU_CARD}', '${SKU_HOME}')`)
}

test.setTimeout(180000)

test('链路 46：组合套餐选N项支持同商品多次（N 按数量合计）', async ({ page }) => {
  seedBundle()
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-error] ${m.text()}`) })

  let saleOrderId = ''
  try {
    // ---- 登录 ----
    await page.goto(`${BASE}/login`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
    await page.waitForTimeout(500)
    await page.locator('#phone').pressSequentially(MANAGER_PHONE, { delay: 30 })
    await page.locator('#password').pressSequentially(MANAGER_PASS, { delay: 30 })
    await page.getByRole('button', { name: /登\s*录/ }).click()
    await page.waitForURL(/\/dashboard/, { timeout: 20000 })

    // ---- Step 1: 选组合套餐 + 顾客 ----
    await page.goto(`${BASE}/orders/create`)
    await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

    const bundleKindBtn = page.getByRole('button', { name: '组合套餐', exact: true })
    await expect(bundleKindBtn).toBeVisible({ timeout: 5000 })
    await bundleKindBtn.click()

    await page.getByPlaceholder(/手机号|姓名/).fill(FIXTURE_PHONE)
    await page.getByRole('button', { name: /搜索/ }).click()
    await page.waitForFunction(() => (document.body.textContent || '').includes('找到'), { timeout: 15000 })
    await page.locator('div.space-y-1 > button').first().click()
    await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: '下一步' }).click()

    // ---- Step 2: 找 FY-FIX-BUNDLE-02 卡片 → 步进选择 ----
    await expect(page.getByText('组合套餐', { exact: false }).first()).toBeVisible({ timeout: 15000 })
    const bundleHeading = page.locator('h4', { hasText: BUNDLE_NAME }).first()
    await expect(bundleHeading).toBeVisible({ timeout: 15000 })
    // 该套餐卡容器（CardContent）。注意：不能用"含『加入套餐』按钮的最近祖先"——
    // 该按钮在卡片头部行 div 内（与标题同级），而选N项 SKU 行在头部行的兄弟 div 里，
    // 取头部行会把 SKU 行排除在 cardScope 之外。改用"含『请选』分组文案的最近祖先"，
    // 即整张 CardContent（头部行无『请选』），同时仍含「加入套餐」按钮。
    const cardScope = bundleHeading.locator(
      'xpath=ancestor::*[.//p[contains(normalize-space(.), "请选")]][1]',
    )

    // 步进：specName 行内 [−, +] 两个按钮，+ 为最后一个
    const stepUp = async (specName: string, times: number) => {
      const plus = cardScope.getByText(specName, { exact: true }).locator('xpath=..').getByRole('button').last()
      for (let i = 0; i < times; i++) await plus.click()
    }
    await stepUp(SPEC_CARD, 2) // 疗程卡A ×2
    await stepUp(SPEC_HOME, 1) // 家居B ×1

    // 合计满 3
    await expect(cardScope.getByText(/已选 3\/3/)).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-46-01-picked.png` })

    await cardScope.getByRole('button', { name: '加入套餐' }).first().click()

    // ---- Step 3: 自动跳转，线下提交 ----
    await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })
    const paySelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
    if (await paySelect.count() > 0) await paySelect.selectOption({ label: '线下支付' })

    await page.getByRole('button', { name: /提交订单/ }).click()
    await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })

    const t1 = await page.textContent('body') || ''
    const m1 = t1.match(/FY-XSD-WX-\d{10}/)
    if (m1) saleOrderId = m1[0]

    const confirmPayBtn = page.getByRole('button', { name: '确认收款' })
    await expect(confirmPayBtn).toBeVisible({ timeout: 10000 })
    await confirmPayBtn.click()
    await expect(page.getByText(/收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({ timeout: 15000 })

    if (!saleOrderId) {
      const m2 = (await page.textContent('body') || '').match(/FY-XSD-WX-\d{10}/)
      if (m2) saleOrderId = m2[0]
    }
    expect(saleOrderId).toMatch(/^FY-XSD-WX-\d{10}$/)
    console.log(`[链路46] saleOrderId=${saleOrderId}`)

    // ---- DB 验证 ----
    const verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL'; actual: string }> = []
    const push = (check: string, ok: boolean, actual: string) =>
      verdicts.push({ check, verdict: ok ? 'PASS' : 'FAIL', actual })

    const [oStatus, oTotal] = psql(
      `SELECT status, total_amount FROM sale_orders WHERE sale_order_id='${saleOrderId}'`,
    ).split('|')
    push('status = 已支付', oStatus === '已支付', oStatus)
    push(`total_amount = ${BUNDLE_TOTAL}`, Number(oTotal) === BUNDLE_TOTAL, oTotal)

    const totalRows = Number(psql(`SELECT count(*) FROM sale_items WHERE sale_order_id='${saleOrderId}'`))
    push('sale_items 行数 = 3（疗程卡拆2行+家居1行）', totalRows === 3, String(totalRows))

    // 疗程卡：2 行，每行 quantity=1 / session_count=2 / unit_real_price=45（单次价=90÷2）
    const cardAgg = psql(
      `SELECT count(*), bool_and(quantity=1), bool_and(session_count=2), bool_and(unit_real_price=45.00) FROM sale_items WHERE sale_order_id='${saleOrderId}' AND sku_id='${SKU_CARD}'`,
    )
    const [cCount, cQty1, cSess2, cPrice45] = cardAgg.split('|')
    push('疗程卡 拆成 2 行', Number(cCount) === 2, cCount)
    push('疗程卡 每行 quantity=1', cQty1 === 't', cQty1)
    push('疗程卡 每行 session_count=2', cSess2 === 't', cSess2)
    push('疗程卡 每行 unit_real_price=45（单次价=bundle_price 90÷session_count 2）', cPrice45 === 't', cPrice45)

    // 家居：1 行，quantity=1 / unit_real_price=90
    const homeAgg = psql(
      `SELECT count(*), bool_and(quantity=1), bool_and(unit_real_price=90.00) FROM sale_items WHERE sale_order_id='${saleOrderId}' AND sku_id='${SKU_HOME}'`,
    )
    const [hCount, hQty1, hPrice90] = homeAgg.split('|')
    push('家居 合成 1 行', Number(hCount) === 1, hCount)
    push('家居 quantity=1', hQty1 === 't', hQty1)
    push('家居 unit_real_price=90', hPrice90 === 't', hPrice90)

    const sumSale = Number(psql(`SELECT sum(sale_amount) FROM sale_items WHERE sale_order_id='${saleOrderId}'`))
    push(`SUM(sale_amount) = ${BUNDLE_TOTAL}`, sumSale === BUNDLE_TOTAL, String(sumSale))

    console.log('\n=== 链路 46 验证 ===')
    for (const v of verdicts) console.log(`  [${v.verdict}] ${v.check} — 实际: ${v.actual}`)
    const failed = verdicts.filter((v) => v.verdict === 'FAIL')
    expect(failed, `失败项: ${failed.map((v) => v.check).join(', ')}`).toEqual([])
  } finally {
    if (saleOrderId) cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路46]' })
    cleanupBundle()
  }
})
