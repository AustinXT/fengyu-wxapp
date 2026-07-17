/**
 * 链路 47：admin 开单 — 微信限额支付（线上部分支付）+ payNotify 模拟落账
 *
 * 主题：验证"在 admin 开单页支付方式选微信、把某行 sale_item 实付金额下调"
 *       时，订单提交后 status 保持 '待支付'、sale_orders.first_payment_amount
 *       记录下调后的金额（QR 扫码只收这个限额）；Step 4 走二维码分支（非
 *       partial-payment 提示）；随后用 psql 模拟 payNotify 回调，验证回调后
 *       订单进入 '部分支付'、received = first_payment_amount、
 *       first_payment_amount 被清空、sale_items.paid_sessions 按逐行公式落地。
 *
 * 角色：FY-TEST-MGR
 * Fixture 顾客：FY-FIX-CLIENT-01
 *
 * SKU 选择策略：动态发现一张 session_count=2 + 启用 + 非体验 的疗程卡（与
 *               链路 46 同源；按 price ASC 取最便宜）。
 *
 * 实付分布：first_payment_amount = round(P / 2) → 模拟扫码支付该金额
 *           → 模拟 payNotify 后预期 paid_sessions = floor(min(1, first/P) * 2) = 1
 *
 * payNotify 模拟说明：
 *   真实 payNotify 走 WeChat HMAC 回调，本地 e2e 无法伪造签名；故按 payNotify
 *   云函数对 sale_orders / sale_order_payments 的最终写入效果直接 SQL 复刻：
 *     1) INSERT 1 行 sale_order_payments(change_type='首次支付', status='已支付',
 *        amount=first_payment_amount, payment_method=微信)
 *     2) UPDATE sale_orders SET status='部分支付', received=first_payment_amount,
 *        first_payment_amount=NULL, paid_at=NOW()
 *     3) 调用与 PAID_SESSIONS_RECALC_SQL 等价的 UPDATE 重算 sale_items.paid_sessions
 *   payNotify 的端到端正向链路由 cloudfn-level e2e 覆盖，此处不重复。
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

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function writeContext(data: Record<string, unknown>) {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'))
  } catch {
    /* ignore */
  }
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...existing, ...data }, null, 2))
}

test.setTimeout(180000)

test('链路 47：admin 微信限额支付 — 提交时落 first_payment_amount + payNotify 后部分支付', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[browser-error] ${m.text()}`)
  })
  page.on('pageerror', (err) => console.log(`[page-error] ${err.message}`))

  // ============================================================
  // Step 0: 动态发现 2 次疗程卡 SKU
  // ============================================================
  const skuRow = psql(
    `SELECT ps.sku_id, ps.spec_name, ps.price, ps.category_id, pc.category_name ` +
      `FROM product_skus ps JOIN product_categories pc ON pc.category_id = ps.category_id ` +
      `WHERE ps.session_count = 2 AND ps.is_enabled = true AND ps.is_experience = false ` +
      `AND ps.deleted_at IS NULL AND pc.product_kind = '护理项目' ` +
      `ORDER BY ps.price ASC LIMIT 1`,
  )
  if (!skuRow) throw new Error('未在 5433 找到 session_count=2 的疗程卡 SKU；请检查 fixture 同步')
  const [SKU_ID, SKU_SPEC_NAME, SKU_PRICE_STR, , SKU_CATEGORY_NAME] = skuRow.split('|')
  const SKU_PRICE = Number(SKU_PRICE_STR)
  if (!SKU_PRICE || SKU_PRICE < 4) throw new Error(`SKU 单价异常: ${SKU_PRICE_STR}`)

  const FIRST_PAYMENT = Math.round(SKU_PRICE / 2)
  const EXPECTED_PAID_SESSIONS = Math.floor(Math.min(1, FIRST_PAYMENT / SKU_PRICE) * 2)
  console.log(
    `[链路47] Step0 SKU=${SKU_ID} (${SKU_SPEC_NAME}) ` +
      `price=${SKU_PRICE} first_payment=${FIRST_PAYMENT} expected_paid=${EXPECTED_PAID_SESSIONS}`,
  )
  expect(EXPECTED_PAID_SESSIONS).toBe(1)

  // ============================================================
  // 登录
  // ============================================================
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(500)
  await page.locator('#phone').pressSequentially(MANAGER_PHONE, { delay: 30 })
  await page.locator('#password').pressSequentially(MANAGER_PASS, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })
  console.log('[链路47] 登录成功')

  // ============================================================
  // Step 1: 开单页 — 选普通商品 + 顾客
  // ============================================================
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  const normalKindBtn = page.getByRole('button', { name: '普通商品', exact: true })
  await expect(normalKindBtn).toBeVisible({ timeout: 5000 })
  await normalKindBtn.click()
  await expect(normalKindBtn).toHaveAttribute('aria-pressed', 'true')

  await page.getByPlaceholder('输入姓名或手机号搜索').fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(
    () => (document.body.textContent || '').includes('找到'),
    { timeout: 15000 },
  )
  await page.locator('div.space-y-1 > button').first().click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })

  await page.getByRole('button', { name: '下一步' }).click()

  // ============================================================
  // Step 2: 选 SKU
  // ============================================================
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-47-01-step2.png` })

  const categoryBtn = page.locator('button', { hasText: SKU_CATEGORY_NAME }).first()
  await expect(categoryBtn).toBeVisible({ timeout: 10000 })
  await categoryBtn.click()
  await page.waitForTimeout(500)

  const skuHeading = page.locator('h4', { hasText: SKU_SPEC_NAME }).first()
  await expect(skuHeading).toBeVisible({ timeout: 10000 })
  const addSkuBtn = skuHeading
    .locator('xpath=ancestor::*[.//button[normalize-space()="加入"]][1]')
    .getByRole('button', { name: '加入' })
    .first()
  await expect(addSkuBtn).toBeVisible({ timeout: 5000 })
  await addSkuBtn.click()
  console.log(`[链路47] Step2 加入 SKU=${SKU_ID} ✓`)

  await page.getByRole('button', { name: '下一步' }).click()

  // ============================================================
  // Step 3: 选微信支付 + 下调实付金额 → 提交
  // ============================================================
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({
    timeout: 10000,
  })

  // 默认支付方式就是微信支付，确认一下显式 select
  const paySelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
  await paySelect.selectOption({ label: '微信支付' })

  // 下调实付
  const receivedInput = page.locator('input[type="number"]:not([disabled])').first()
  await expect(receivedInput).toBeVisible({ timeout: 5000 })
  await receivedInput.click()
  await receivedInput.fill('')
  await receivedInput.fill(FIRST_PAYMENT.toFixed(2))
  await page.waitForTimeout(300)

  await expect(page.getByText(`实付合计: ¥${FIRST_PAYMENT.toFixed(2)}`)).toBeVisible({ timeout: 5000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-47-02-step3-lowered.png` })

  await page.getByRole('button', { name: /提交订单/ }).click()

  // Step 4 — 线上分支：status 仍是"待支付"，标题应该是"订单创建成功"，QR 应出现
  await expect(page.getByRole('heading', { name: '订单创建成功' })).toBeVisible({ timeout: 20000 })
  // 应出现引导文案而非"已记录首次收款"
  await expect(page.getByRole('heading', { name: '已记录首次收款' })).toHaveCount(0)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-47-03-step4-qr.png` })

  // 抓订单号
  const bodyText = (await page.textContent('body')) || ''
  const m = bodyText.match(/FY-XSD-WX-\d{10}/)
  if (!m) throw new Error('未能从 Step 4 抓到 sale_order_id')
  const saleOrderId = m[0]
  console.log(`[链路47] Step3 saleOrderId=${saleOrderId} ✓`)

  // ============================================================
  // DB 验证：创建后状态（线上限额）
  // ============================================================
  const verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL'; actual: string }> = []

  const orderRow = psql(
    `SELECT status, received, total_amount, payment_method, COALESCE(first_payment_amount::text, 'NULL') ` +
      `FROM sale_orders WHERE sale_order_id='${saleOrderId}'`,
  )
  const [oStatus, oReceived, oTotal, oPayMethod, oFirstPay] = orderRow.split('|')
  verdicts.push({
    check: '创建后 sale_orders.status = 待支付',
    verdict: oStatus === '待支付' ? 'PASS' : 'FAIL',
    actual: oStatus,
  })
  verdicts.push({
    check: '创建后 sale_orders.received = 0',
    verdict: Number(oReceived) === 0 ? 'PASS' : 'FAIL',
    actual: oReceived,
  })
  verdicts.push({
    check: `创建后 sale_orders.total_amount = ${SKU_PRICE.toFixed(2)}`,
    verdict: Number(oTotal) === SKU_PRICE ? 'PASS' : 'FAIL',
    actual: oTotal,
  })
  verdicts.push({
    check: '创建后 sale_orders.payment_method = 微信',
    verdict: oPayMethod === '微信' ? 'PASS' : 'FAIL',
    actual: oPayMethod,
  })
  verdicts.push({
    check: `创建后 sale_orders.first_payment_amount = ${FIRST_PAYMENT.toFixed(2)}`,
    verdict: oFirstPay !== 'NULL' && Number(oFirstPay) === FIRST_PAYMENT ? 'PASS' : 'FAIL',
    actual: oFirstPay,
  })

  // 线上未支付时不应有 sale_order_payments 行
  const payCount = psql(
    `SELECT COUNT(*) FROM sale_order_payments WHERE sale_order_id='${saleOrderId}'`,
  )
  verdicts.push({
    check: '创建后 sale_order_payments 行数 = 0（线上未支付）',
    verdict: payCount === '0' ? 'PASS' : 'FAIL',
    actual: payCount,
  })

  // ============================================================
  // Step 4: 模拟 payNotify 落账
  // ============================================================
  console.log(`[链路47] Step4 模拟 payNotify 写入首次支付 ¥${FIRST_PAYMENT}...`)
  // 微信/支付宝走 chk_sop_method_txn 约束必须传 external_txn_id（真实 payNotify 用 wx 交易号）
  psql(
    `INSERT INTO sale_order_payments ` +
      `(sale_order_id, change_type, amount, payment_method, external_txn_id, status, source_end, created_at, paid_at) ` +
      `VALUES ('${saleOrderId}', '首次支付', ${FIRST_PAYMENT.toFixed(2)}, '微信', 'WX-LINK47-${Date.now()}', '已支付', 'client', NOW(), NOW())`,
  )
  psql(
    `UPDATE sale_orders SET status='部分支付', received=${FIRST_PAYMENT.toFixed(2)}, ` +
      `first_payment_amount=NULL, paid_at=NOW(), updated_at=NOW() ` +
      `WHERE sale_order_id='${saleOrderId}'`,
  )

  // 重算 paid_sessions（与 PAID_SESSIONS_RECALC_SQL 等价：逐行公式
  // floor(min(1, sale_items.received / sale_items.sale_amount) × session_count)）
  psql(
    `UPDATE sale_items SET received = ${FIRST_PAYMENT.toFixed(2)}, updated_at = NOW() ` +
      `WHERE sale_order_id='${saleOrderId}'`,
  )
  psql(
    `UPDATE sale_items SET paid_sessions = CASE ` +
      `WHEN session_count IS NULL THEN NULL ` +
      `WHEN sale_amount <= 0 THEN session_count ` +
      `ELSE LEAST(session_count, FLOOR(LEAST(1, received::numeric / sale_amount) * session_count)::integer) ` +
      `END, updated_at = NOW() ` +
      `WHERE sale_order_id='${saleOrderId}'`,
  )

  // ============================================================
  // DB 验证：payNotify 后状态
  // ============================================================
  const postRow = psql(
    `SELECT so.status, so.received, COALESCE(so.first_payment_amount::text, 'NULL'), ` +
      `COALESCE(si.paid_sessions, -1), si.received ` +
      `FROM sale_orders so JOIN sale_items si ON si.sale_order_id=so.sale_order_id ` +
      `WHERE so.sale_order_id='${saleOrderId}'`,
  )
  const [pStatus, pReceived, pFirstPay, pPaidSessions, pItemReceived] = postRow.split('|')
  verdicts.push({
    check: 'payNotify 后 sale_orders.status = 部分支付',
    verdict: pStatus === '部分支付' ? 'PASS' : 'FAIL',
    actual: pStatus,
  })
  verdicts.push({
    check: `payNotify 后 sale_orders.received = ${FIRST_PAYMENT.toFixed(2)}`,
    verdict: Math.abs(Number(pReceived) - FIRST_PAYMENT) < 0.005 ? 'PASS' : 'FAIL',
    actual: pReceived,
  })
  verdicts.push({
    check: 'payNotify 后 sale_orders.first_payment_amount IS NULL',
    verdict: pFirstPay === 'NULL' ? 'PASS' : 'FAIL',
    actual: pFirstPay,
  })
  verdicts.push({
    check: `payNotify 后 sale_items.received = ${FIRST_PAYMENT.toFixed(2)}`,
    verdict: Math.abs(Number(pItemReceived) - FIRST_PAYMENT) < 0.005 ? 'PASS' : 'FAIL',
    actual: pItemReceived,
  })
  verdicts.push({
    check: `payNotify 后 sale_items.paid_sessions = ${EXPECTED_PAID_SESSIONS}`,
    verdict: Number(pPaidSessions) === EXPECTED_PAID_SESSIONS ? 'PASS' : 'FAIL',
    actual: pPaidSessions,
  })

  // 首次支付行存在
  const fpRow = psql(
    `SELECT change_type, status, amount, payment_method FROM sale_order_payments ` +
      `WHERE sale_order_id='${saleOrderId}' AND change_type='首次支付'`,
  )
  const [fpType, fpStatus, fpAmount, fpMethod] = fpRow.split('|')
  verdicts.push({
    check: 'payNotify 后 sale_order_payments 存在首次支付行（微信 / 已支付）',
    verdict:
      fpType === '首次支付' && fpStatus === '已支付' && fpMethod === '微信' ? 'PASS' : 'FAIL',
    actual: `change_type=${fpType} status=${fpStatus} method=${fpMethod}`,
  })
  verdicts.push({
    check: `payNotify 后 首次支付.amount = ${FIRST_PAYMENT.toFixed(2)}`,
    verdict: Number(fpAmount) === FIRST_PAYMENT ? 'PASS' : 'FAIL',
    actual: fpAmount,
  })

  // ============================================================
  // 汇总 + 清理
  // ============================================================
  console.log('\n=== 链路 47 验证 ===')
  for (const v of verdicts) console.log(`  [${v.verdict}] ${v.check} — 实际: ${v.actual}`)
  const failed = verdicts.filter((v) => v.verdict === 'FAIL')

  writeContext({
    link47: {
      saleOrderId,
      skuId: SKU_ID,
      skuPrice: SKU_PRICE,
      firstPaymentAmount: FIRST_PAYMENT,
      verdicts: verdicts.length,
      failed: failed.length,
      status: failed.length === 0 ? 'PASS' : 'FAIL',
      ranAt: new Date().toISOString(),
    },
  })

  cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路47]' })

  expect(failed, `失败项: ${failed.map((v) => v.check).join(', ')}`).toEqual([])
})
