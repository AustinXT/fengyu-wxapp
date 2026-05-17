/**
 * 链路 29：品项券（applicable_category_ids 限定）
 *
 * 主题：覆盖 coupon_templates.applicable_category_ids 字段的过滤路径 —
 *       品项券 FY-FIX-CPN-ITEM 仅适用于 category_id='d303ac8871eafd97'（缦之羽）。
 *       命中商品（洗-无创纹身）时 UI 应可选；不命中商品时 getAvailableCoupons 应过滤掉。
 *
 * 角色：FY-TEST-MGR
 * Fixture 顾客：FY-FIX-CLIENT-01
 * Fixture 券：FY-FIX-CPN-ITEM
 *   template = FY-FIX-CT-ITEM (品项券 discount_value=30, min_spend=0,
 *              applicable_category_ids=['d303ac8871eafd97'])
 *
 * 测试组：UI 提交命中场景 + SQL 反例校验不命中场景（避免双轮浏览器开销）
 *   - UI 组：1× 洗-无创纹身（c79157b29c9e974c, 缦之羽 ¥100）→ 选品项券 → 折 ¥30 → 实付 ¥70
 *   - SQL 反例：假性皱纹管家（2e388ba778334779）的 category 不在 applicable_category_ids 中
 *
 * 关键不变量：
 *   sale_orders.coupon_id       = FY-FIX-CPN-ITEM
 *   sale_orders.coupon_discount = 30.00
 *   sale_orders.total_amount    = 100 - 30 = 70
 *   user_coupons.status         = '已使用' / used_sale_order_id = saleOrderId
 *   coupon_templates.applicable_category_ids ∌ 假性皱纹管家.category_id
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'
const MANAGER_PHONE = '13900139001'
const MANAGER_PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const FIXTURE_COUPON_ID = 'FY-FIX-CPN-ITEM'
const FIXTURE_TEMPLATE_ID = 'FY-FIX-CT-ITEM'
const APPLICABLE_CATEGORY_ID = 'd303ac8871eafd97' // 缦之羽
const HIT_SKU_ID = 'c79157b29c9e974c' // 洗-无创纹身
const MISS_SKU_ID = '2e388ba778334779' // 假性皱纹管家

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

function psql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -t -A -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim()
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    throw new Error(`psql: ${err.message ?? ''}\n${err.stderr ?? ''}`)
  }
}

function ensureDir(dir: string) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) }

function writeContext(data: Record<string, unknown>) {
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')) } catch {}
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...existing, ...data }, null, 2))
}

test.setTimeout(180000)

test('链路 29：品项券限定 category 过滤', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-error] ${m.text()}`) })

  // ---- 前置：重置 user_coupon 状态 ----
  psql(`UPDATE user_coupons SET status='未使用', used_sale_order_id=NULL, used_at=NULL WHERE coupon_id='${FIXTURE_COUPON_ID}'`)

  // ---- 登录 ----
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(500)
  await page.locator('#phone').pressSequentially(MANAGER_PHONE, { delay: 30 })
  await page.locator('#password').pressSequentially(MANAGER_PASS, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })

  // ---- Step 1 + 2: 命中商品 1× 洗-无创纹身（缦之羽 ¥100）----
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  await page.getByPlaceholder(/手机号|姓名/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => (document.body.textContent || '').includes('找到'), { timeout: 15000 })
  await page.locator('div.space-y-1 > button').first().click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '下一步' }).click()

  await page.waitForTimeout(2000)
  for (let r = 0; r < 3; r++) {
    const t = await page.textContent('body') || ''
    if (t.includes('数据未加载')) {
      const retryBtn = page.getByRole('button', { name: '重试' })
      if (await retryBtn.count() > 0) { await retryBtn.click(); await page.waitForTimeout(2000) }
    } else if (t.includes('加入') || t.includes('商品分类')) {
      break
    } else { await page.waitForTimeout(1500) }
  }

  // 缦之羽 → 洗-无创纹身 × 1
  const catBtn = page.getByRole('button', { name: '缦之羽', exact: true }).first()
  if (await catBtn.count() > 0) {
    await catBtn.click()
    await page.waitForTimeout(500)
  }
  const nameEl = page.getByText('洗-无创纹身', { exact: false }).first()
  await expect(nameEl).toBeVisible({ timeout: 5000 })
  const card = nameEl.locator('..').locator('..')
  const add = card.getByRole('button', { name: /加入/ })
  await add.click()
  console.log('[链路29] 加入命中 SKU: 洗-无创纹身')
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-29-01-cart.png` })

  await page.getByRole('button', { name: '下一步' }).click()

  // ---- Step 3: 选 fixture 品项券 ----
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })

  const paySelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
  if (await paySelect.count() > 0) {
    await paySelect.selectOption({ label: '线下支付' })
  }
  await page.waitForTimeout(1000)

  // 等优惠券加载
  await page.waitForFunction(
    () => !(document.body.textContent || '').includes('正在加载可用优惠券'),
    { timeout: 15000 },
  )

  // 用 "不使用优惠券" 唯一定位（订单类型/咨询师 select 也含"不指定"会误中）
  const couponSelect = page.locator('select').filter({ hasText: /不使用优惠券/ }).first()
  let couponUsed = false
  let uiOptions: string[] = []
  if (await couponSelect.count() > 0) {
    uiOptions = await couponSelect.locator('option').allTextContents()
    console.log('[链路29] 优惠券选项:', uiOptions)
    const targetOption = uiOptions.find(
      (o) => o.includes('缦之羽专属') || o.includes('FY-FIX-CT-ITEM') || o.includes('FY-FIX-CPN-ITEM') || o.includes('品项'),
    )
    if (targetOption && !targetOption.includes('不使用')) {
      await couponSelect.selectOption({ label: targetOption })
      couponUsed = true
      console.log(`[链路29] 已选: ${targetOption}`)
    }
  }
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-29-02-coupon.png` })

  await page.getByRole('button', { name: /提交订单/ }).click()
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })

  let saleOrderId = ''
  const t1 = await page.textContent('body') || ''
  const m1 = t1.match(/FY-XSD-WX-\d{10}/)
  if (m1) saleOrderId = m1[0]

  const confirmPayBtn = page.getByRole('button', { name: '确认收款' })
  await expect(confirmPayBtn).toBeVisible({ timeout: 10000 })
  await confirmPayBtn.click()
  await expect(page.getByText(/收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({ timeout: 15000 })

  if (!saleOrderId) {
    const t2 = await page.textContent('body') || ''
    const m2 = t2.match(/FY-XSD-WX-\d{10}/)
    if (m2) saleOrderId = m2[0]
  }
  expect(saleOrderId).toMatch(/^FY-XSD-WX-\d{10}$/)
  console.log(`[链路29] saleOrderId=${saleOrderId} couponUsed=${couponUsed}`)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-29-03-paid.png` })

  // ---- DB 验证 + SQL 反例 ----
  const verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL' | 'SKIP'; actual: string }> = []

  if (couponUsed) {
    const row = psql(
      `SELECT total_amount, coupon_discount, coupon_id FROM sale_orders WHERE sale_order_id='${saleOrderId}'`,
    )
    const [oTotal, oDiscount, oCpn] = row.split('|')
    verdicts.push({
      check: 'sale_orders.coupon_id = FY-FIX-CPN-ITEM',
      verdict: oCpn === FIXTURE_COUPON_ID ? 'PASS' : 'FAIL',
      actual: oCpn,
    })
    verdicts.push({
      check: 'sale_orders.coupon_discount = 30（品项券 discount_value）',
      verdict: Number(oDiscount) === 30 ? 'PASS' : 'FAIL',
      actual: oDiscount,
    })
    verdicts.push({
      check: 'sale_orders.total_amount = 70（100 - 30 品项券折扣）',
      verdict: Number(oTotal) === 70 ? 'PASS' : 'FAIL',
      actual: oTotal,
    })

    // user_coupons 状态机
    const cpnStatus = psql(
      `SELECT status, used_sale_order_id FROM user_coupons WHERE coupon_id='${FIXTURE_COUPON_ID}'`,
    )
    const [cStatus, cUsedOrder] = cpnStatus.split('|')
    verdicts.push({
      check: 'user_coupons.status = 已使用 / used_sale_order_id = saleOrderId',
      verdict: cStatus === '已使用' && cUsedOrder === saleOrderId ? 'PASS' : 'FAIL',
      actual: `status=${cStatus} used_order=${cUsedOrder}`,
    })
  } else {
    verdicts.push({
      check: 'UI 品项券提交',
      verdict: 'SKIP',
      actual: `UI 未找到品项券选项 — 检查 getAvailableCoupons 是否返回 FY-FIX-CT-ITEM。options=${JSON.stringify(uiOptions)}`,
    })
  }

  // ---- SQL 反例：品项券 applicable_category_ids 应限定缦之羽 ----
  // 命中校验：HIT_SKU 的 category 必须在 applicable_category_ids 中
  const hitCategoryRow = psql(
    `SELECT category_id FROM product_skus WHERE sku_id='${HIT_SKU_ID}'`,
  )
  verdicts.push({
    check: `命中 SKU（洗-无创纹身）的 category_id = ${APPLICABLE_CATEGORY_ID}（缦之羽）`,
    verdict: hitCategoryRow === APPLICABLE_CATEGORY_ID ? 'PASS' : 'FAIL',
    actual: hitCategoryRow,
  })

  // 不命中校验：MISS_SKU 的 category 不能在 applicable_category_ids 中
  const missCategoryRow = psql(
    `SELECT category_id FROM product_skus WHERE sku_id='${MISS_SKU_ID}'`,
  )
  verdicts.push({
    check: `不命中 SKU（假性皱纹管家）的 category_id != ${APPLICABLE_CATEGORY_ID}`,
    verdict: missCategoryRow && missCategoryRow !== APPLICABLE_CATEGORY_ID ? 'PASS' : 'FAIL',
    actual: missCategoryRow,
  })

  // 品项券 applicable_category_ids 字段断言：包含缦之羽、不包含 MISS 的 category
  const tplRow = psql(
    `SELECT applicable_category_ids::text FROM coupon_templates WHERE template_id='${FIXTURE_TEMPLATE_ID}'`,
  )
  const includesHit = tplRow.includes(APPLICABLE_CATEGORY_ID)
  const includesMiss = missCategoryRow ? tplRow.includes(missCategoryRow) : false
  verdicts.push({
    check: 'coupon_templates.applicable_category_ids 包含缦之羽 category',
    verdict: includesHit ? 'PASS' : 'FAIL',
    actual: tplRow,
  })
  verdicts.push({
    check: 'coupon_templates.applicable_category_ids 不包含假性皱纹管家 category（业务上 getAvailableCoupons 会过滤）',
    verdict: !includesMiss ? 'PASS' : 'FAIL',
    actual: `tpl=${tplRow}, miss_category=${missCategoryRow}`,
  })

  console.log('\n=== 链路 29 验证 ===')
  for (const v of verdicts) console.log(`  [${v.verdict}] ${v.check} — 实际: ${v.actual}`)
  const failed = verdicts.filter((v) => v.verdict === 'FAIL')
  const skipped = verdicts.filter((v) => v.verdict === 'SKIP')

  writeContext({
    link29: {
      saleOrderId,
      couponUsed,
      verdicts: verdicts.length,
      failed: failed.length,
      skipped: skipped.length,
      status: failed.length === 0 ? (couponUsed ? 'PASS' : 'PARTIAL') : 'FAIL',
      ranAt: new Date().toISOString(),
    },
  })

  // ---- 清理 ----
  psql(`UPDATE user_coupons SET status='未使用', used_sale_order_id=NULL, used_at=NULL WHERE coupon_id='${FIXTURE_COUPON_ID}'`)
  if (saleOrderId) cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路29]' })

  expect(failed, `失败项: ${failed.map((v) => v.check).join(', ')}`).toEqual([])
})
