/**
 * 链路 25：体验卡下单（Step 1 选体验卡 → trial-card-picker → 销售单 → 收款 → DB 校验）
 *
 * 主题：覆盖 4 个 ProductKindChoice 中的"体验卡"分支，验证 trial-card-picker 数据源
 *       与下单结果落库一致（getProductsByKind('体验卡').categories）。
 *
 * 角色：FY-TEST-MGR
 * Fixture 顾客：FY-FIX-CLIENT-01 (phone 13800138000)
 * Fixture 体验卡 SKU：FY-FIX-SKU-TRIAL（¥99，session_count=1，is_experience=true）
 *
 * 关键不变量：
 *   sale_items.sku_id                = 'FY-FIX-SKU-TRIAL'
 *   sale_items.unit_real_price       = 99.00
 *   sale_items.session_count         = 1
 *   sale_orders.status               = '已支付'
 *   sale_orders.sale_order_type      = '销售单'
 *   sale_orders.total_amount         = 99.00（无优惠、无储值卡抵扣）
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = process.env.ADMIN_BASE_URL || 'http://localhost:3000'
const MANAGER_PHONE = '13900139001'
const MANAGER_PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const TRIAL_SKU_ID = 'FY-FIX-SKU-TRIAL'
const TRIAL_SPEC_NAME = 'Fixture 体验卡 ¥99'

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

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

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readContext(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')) } catch { return {} }
}

function writeContext(data: Record<string, unknown>) {
  const existing = readContext()
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...existing, ...data }, null, 2))
}

test.setTimeout(180000)

test('链路 25：体验卡下单', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[browser-error] ${msg.text()}`)
  })
  page.on('pageerror', (err) => console.log(`[page-error] ${err.message}`))

  // ---- 登录 ----
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(500)
  await page.locator('#phone').pressSequentially(MANAGER_PHONE, { delay: 30 })
  await page.locator('#password').pressSequentially(MANAGER_PASS, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })

  // ---- Step 1: 进入开单向导 ----
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-25-01-step1.png` })

  // 切换"体验卡"
  const trialBtn = page.getByRole('button', { name: '体验卡', exact: true })
  await expect(trialBtn).toBeVisible({ timeout: 5000 })
  await trialBtn.click()
  await expect(trialBtn).toHaveAttribute('aria-pressed', 'true')

  // 选顾客
  await page.getByPlaceholder(/手机号|姓名/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('找到') || t.includes('未找到')
  }, { timeout: 15000 })

  const firstCustomerBtn = page.locator('div.space-y-1 > button').first()
  await firstCustomerBtn.click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })

  await page.getByRole('button', { name: '下一步' }).click()

  // ---- Step 2: trial-card-picker → 选 FY-FIX-SKU-TRIAL ----
  await expect(page.getByText('体验卡', { exact: false }).first()).toBeVisible({ timeout: 15000 })
  await page.waitForTimeout(1500) // 等 prefetch
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-25-02-trial-picker.png` })

  // 等待数据加载（若需重试）
  for (let retry = 0; retry < 3; retry++) {
    const bodyText = await page.textContent('body') || ''
    if (bodyText.includes('数据未加载')) {
      const retryBtn = page.getByRole('button', { name: '重试' })
      if (await retryBtn.count() > 0) {
        await retryBtn.click()
        await page.waitForTimeout(2000)
      }
    } else if (bodyText.includes('加入') || bodyText.includes('暂无可选体验卡')) {
      break
    } else {
      await page.waitForTimeout(1500)
    }
  }

  // 找到 Fixture 体验卡卡片并点"加入"
  const trialCard = page.getByText(TRIAL_SPEC_NAME, { exact: false }).first()
  await expect(trialCard).toBeVisible({ timeout: 15000 })
  const addBtn = trialCard.locator('xpath=ancestor::*[.//button[contains(text(), "加入")]][1]').getByRole('button', { name: /加入/ })
  await addBtn.click()
  console.log('[链路25] 已加入体验卡 fixture')

  await page.waitForTimeout(500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-25-03-cart.png` })

  // 下一步
  const nextBtn = page.getByRole('button', { name: '下一步' })
  await expect(nextBtn).toBeEnabled({ timeout: 5000 })
  await nextBtn.click()

  // ---- Step 3: 销售单 + 线下支付 + 提交 ----
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toHaveAttribute('aria-pressed', 'true')

  // 线下支付
  const paySelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
  if (await paySelect.count() > 0) {
    await paySelect.selectOption({ label: '线下支付' })
  }
  // 取消充值卡抵扣（顾客有卡余额时自动勾选 → payment_method='无' 绕过确认收款；2026-06-09 同 link-1）
  const useCardCb = page.getByRole('checkbox').first()
  if ((await useCardCb.count()) > 0 && (await useCardCb.isChecked().catch(() => false))) {
    await useCardCb.uncheck()
  }

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-25-04-checkout.png` })

  const submitBtn = page.getByRole('button', { name: /提交订单/ })
  await expect(submitBtn).toBeEnabled({ timeout: 5000 })
  await submitBtn.click()

  // ---- 完成（订单号 + 确认收款）----
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })

  let saleOrderId = ''
  const bodyText = await page.textContent('body') || ''
  const m = bodyText.match(/FY-XSD-WX-\d{10}/)
  if (m) saleOrderId = m[0]

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
  console.log(`[链路25] saleOrderId=${saleOrderId}`)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-25-05-paid.png` })

  // ---- DB 验证 ----
  const verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL'; actual: string }> = []

  const orderRow = psql(
    `SELECT status, sale_order_type, total_amount FROM sale_orders WHERE sale_order_id='${saleOrderId}'`,
  )
  const [oStatus, oType, oTotal] = orderRow.split('|')
  verdicts.push({
    check: 'sale_orders.status = 已支付',
    verdict: oStatus === '已支付' ? 'PASS' : 'FAIL',
    actual: oStatus,
  })
  verdicts.push({
    check: 'sale_orders.sale_order_type = 销售单',
    verdict: oType === '销售单' ? 'PASS' : 'FAIL',
    actual: oType,
  })
  verdicts.push({
    check: 'sale_orders.total_amount = 99.00',
    verdict: Number(oTotal) === 99 ? 'PASS' : 'FAIL',
    actual: oTotal,
  })

  const itemRow = psql(
    `SELECT sku_id, unit_real_price, session_count, product_type FROM sale_items WHERE sale_order_id='${saleOrderId}'`,
  )
  const [iSku, iPrice, iSess, iPType] = itemRow.split('|')
  verdicts.push({
    check: `sale_items.sku_id = ${TRIAL_SKU_ID}`,
    verdict: iSku === TRIAL_SKU_ID ? 'PASS' : 'FAIL',
    actual: iSku,
  })
  verdicts.push({
    check: 'sale_items.unit_real_price = 99.00',
    verdict: Number(iPrice) === 99 ? 'PASS' : 'FAIL',
    actual: iPrice,
  })
  verdicts.push({
    check: 'sale_items.session_count = 1',
    verdict: Number(iSess) === 1 ? 'PASS' : 'FAIL',
    actual: iSess,
  })
  verdicts.push({
    check: 'sale_items.product_type 落库（trial 走"疗程卡"路径，单品已合并）',
    verdict: iPType ? 'PASS' : 'FAIL',
    actual: iPType,
  })

  console.log('\n=== 链路 25 验证 ===')
  for (const v of verdicts) console.log(`  [${v.verdict}] ${v.check} — 实际: ${v.actual}`)
  const failed = verdicts.filter((v) => v.verdict === 'FAIL')

  writeContext({
    link25: {
      saleOrderId,
      verdicts: verdicts.length,
      failed: failed.length,
      status: failed.length === 0 ? 'PASS' : 'FAIL',
      ranAt: new Date().toISOString(),
    },
  })

  // ---- 清理 ----
  cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路25]' })

  expect(failed, `失败项: ${failed.map((v) => v.check).join(', ')}`).toEqual([])
})
