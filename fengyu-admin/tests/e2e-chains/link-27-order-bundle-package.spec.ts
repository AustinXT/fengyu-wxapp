/**
 * 链路 27：组合套餐下单（BundlePicker → 跳过购物车直进 Step 3 → 打包价 ¥180）
 *
 * 主题：覆盖 ProductKindChoice='组合套餐' 分支的特殊 UX —
 *       点"加入套餐"会同时清空旧 cart + 填入子 SKU + 直接进 Step 3（无购物车 UI）。
 *       验证 sale_items 用 bundle_price 作为 unit_real_price 落库（而非 product_skus.price）。
 *
 * 角色：FY-TEST-MGR
 * Fixture 顾客：FY-FIX-CLIENT-01
 * Fixture 套餐：FY-FIX-BUNDLE-01（原价 ¥200，打包 ¥180，含 2 张 ¥90 SKU）
 *
 * 关键不变量：
 *   sale_items 行数               = 2（套餐子 SKU）
 *   sale_items.unit_real_price    = 90.00（套餐价，覆盖原 ¥100）
 *   SUM(sale_items.sale_amount)   = 180.00
 *   sale_orders.total_amount      = 180.00
 *   sale_orders.status            = '已支付'
 *
 * 反例：Step 3 提交不应允许手工改价（line 422、895 priceOverrides 被锁）。
 *      （UI 上无改价输入框；本 spec 由 server-side 落库的 unit_real_price 反推已被锁）
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
const BUNDLE_NAME = 'Fixture 套餐 ¥180'
const BUNDLE_PRICE_TOTAL = 180

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

function psql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu -t -A -c "${sql.replace(/"/g, '\\"')}"`,
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

test('链路 27：组合套餐下单', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-error] ${m.text()}`) })

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
  await expect(bundleKindBtn).toHaveAttribute('aria-pressed', 'true')

  await page.getByPlaceholder(/手机号|姓名/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => (document.body.textContent || '').includes('找到'), { timeout: 15000 })
  await page.locator('div.space-y-1 > button').first().click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })

  await page.getByRole('button', { name: '下一步' }).click()

  // ---- Step 2: BundlePicker → 找 "Fixture 套餐 ¥180" → 加入 → 自动跳 Step 3 ----
  await expect(page.getByText('组合套餐', { exact: false }).first()).toBeVisible({ timeout: 15000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-27-01-bundles.png` })

  // 等数据
  for (let retry = 0; retry < 3; retry++) {
    const t = await page.textContent('body') || ''
    if (t.includes('数据未加载')) {
      const r = page.getByRole('button', { name: '重试' })
      if (await r.count() > 0) { await r.click(); await page.waitForTimeout(2000) }
    } else if (t.includes('加入套餐') || t.includes('暂无可选套餐')) {
      break
    } else {
      await page.waitForTimeout(1500)
    }
  }

  // 找 fixture 套餐卡片
  const bundleCard = page.locator('div').filter({ hasText: BUNDLE_NAME }).first()
  await expect(bundleCard).toBeVisible({ timeout: 15000 })
  const addBundleBtn = bundleCard.locator('xpath=ancestor::*[.//button[contains(text(), "加入套餐")]][1]').getByRole('button', { name: '加入套餐' }).first()
  await addBundleBtn.click()
  console.log('[链路27] 已点击"加入套餐"')

  // 此时应自动跳 Step 3，且 cart 已被替换（无购物车下一步按钮）
  await page.waitForTimeout(1000)
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-27-02-step3-auto.png` })

  // ---- Step 3 反例：手工改价应被禁用（套餐价锁定提示） ----
  // line 766: "组合套餐按打包价销售，禁用手工改价"
  const lockHint = await page.getByText(/打包价销售|禁用手工改价/).count()
  const lockHintShown = lockHint > 0

  // 线下支付
  const paySelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
  if (await paySelect.count() > 0) {
    await paySelect.selectOption({ label: '线下支付' })
  }

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
  console.log(`[链路27] saleOrderId=${saleOrderId}`)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-27-03-paid.png` })

  // ---- DB 验证 ----
  const verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL'; actual: string }> = []

  verdicts.push({
    check: 'UI 提示"打包价销售/禁用手工改价"可见',
    verdict: lockHintShown ? 'PASS' : 'FAIL',
    actual: String(lockHintShown),
  })

  const orderRow = psql(
    `SELECT status, total_amount FROM sale_orders WHERE sale_order_id='${saleOrderId}'`,
  )
  const [oStatus, oTotal] = orderRow.split('|')
  verdicts.push({
    check: 'sale_orders.status = 已支付',
    verdict: oStatus === '已支付' ? 'PASS' : 'FAIL',
    actual: oStatus,
  })
  verdicts.push({
    check: `sale_orders.total_amount = ${BUNDLE_PRICE_TOTAL}（套餐打包价）`,
    verdict: Number(oTotal) === BUNDLE_PRICE_TOTAL ? 'PASS' : 'FAIL',
    actual: oTotal,
  })

  const itemsAgg = psql(
    `SELECT count(*), sum(unit_real_price), sum(sale_amount), bool_and(unit_real_price = 90.00) FROM sale_items WHERE sale_order_id='${saleOrderId}'`,
  )
  const [iCount, iSumPrice, iSumAmount, iAllBundlePrice] = itemsAgg.split('|')
  verdicts.push({
    check: 'sale_items 行数 = 2',
    verdict: Number(iCount) === 2 ? 'PASS' : 'FAIL',
    actual: iCount,
  })
  verdicts.push({
    check: '每行 unit_real_price = 90.00（bundle_price，不是 SKU 原价 ¥100）',
    verdict: iAllBundlePrice === 't' ? 'PASS' : 'FAIL',
    actual: `sum_unit_real_price=${iSumPrice}`,
  })
  verdicts.push({
    check: `SUM(sale_amount) = ${BUNDLE_PRICE_TOTAL}`,
    verdict: Number(iSumAmount) === BUNDLE_PRICE_TOTAL ? 'PASS' : 'FAIL',
    actual: iSumAmount,
  })

  console.log('\n=== 链路 27 验证 ===')
  for (const v of verdicts) console.log(`  [${v.verdict}] ${v.check} — 实际: ${v.actual}`)
  const failed = verdicts.filter((v) => v.verdict === 'FAIL')

  writeContext({
    link27: {
      saleOrderId,
      bundleProductId: 'FY-FIX-BUNDLE-01',
      verdicts: verdicts.length,
      failed: failed.length,
      status: failed.length === 0 ? 'PASS' : 'FAIL',
      ranAt: new Date().toISOString(),
    },
  })

  cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路27]' })

  expect(failed, `失败项: ${failed.map((v) => v.check).join(', ')}`).toEqual([])
})
