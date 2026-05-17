/**
 * 链路 26：充值卡下单（档位 ¥500 → 实付 ¥495 → balance +500 → 反例：强制销售单）
 *
 * 主题：覆盖 ProductKindChoice='充值卡' 分支（虚拟 SKU + RECHARGE_TIERS + matchTier）。
 *       验证 server action `orders.ts` 充值卡专项校验（line 798-849）：
 *         - 强制销售单（其他类型 UI 锁 + server 拒）
 *         - 一单一笔
 *         - 不支持优惠券
 *         - unit_real_price 必须 == matchTier(faceValue).payAmount（防篡改）
 *
 * 角色：FY-TEST-MGR
 * Fixture 顾客：FY-FIX-CLIENT-01
 * Fixture 储值卡：FY-FIX-CARD-01（初始 balance=¥1000）
 *
 * 关键不变量：
 *   sale_items.sku_id           = 'sku-recharge-virtual'
 *   sale_items.is_recharge_card = true
 *   sale_items.unit_real_price  = 495.00（¥500 档 × 0.99）
 *   sale_items.product_name     ∋ '¥500'
 *   sale_orders.sale_order_type = '销售单'（强制）
 *   prepaid_cards.balance       += 500.00（faceValue，不是实付）
 *   card_transactions           +1 行（type='充值', amount=500, ref_order_id=:soid）
 *
 * 反例：Step 3 中 "内部单" / "转换单" 按钮 disabled，title="充值卡订单仅支持销售单"
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
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'
const RECHARGE_VIRTUAL_SKU = 'sku-recharge-virtual'
const TIER_FACE_VALUE = 500
const TIER_PAY_AMOUNT = 495 // 500 × 0.99

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

test('链路 26：充值卡下单', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-error] ${m.text()}`) })

  // ---- 前置：记录 balance 基线 ----
  const balanceBefore = Number(
    psql(`SELECT COALESCE(balance, 0) FROM prepaid_cards WHERE user_id='${FIXTURE_USER_ID}'`) || '0',
  )
  console.log(`[链路26] 充值前 balance=¥${balanceBefore}`)

  // ---- 登录 ----
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(500)
  await page.locator('#phone').pressSequentially(MANAGER_PHONE, { delay: 30 })
  await page.locator('#password').pressSequentially(MANAGER_PASS, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })

  // ---- Step 1: 进入开单向导 → 选充值卡 + 顾客 ----
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  const rechargeKindBtn = page.getByRole('button', { name: '充值卡', exact: true })
  await expect(rechargeKindBtn).toBeVisible({ timeout: 5000 })
  await rechargeKindBtn.click()
  await expect(rechargeKindBtn).toHaveAttribute('aria-pressed', 'true')

  await page.getByPlaceholder(/手机号|姓名/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => (document.body.textContent || '').includes('找到'), { timeout: 15000 })
  await page.locator('div.space-y-1 > button').first().click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })

  await page.getByRole('button', { name: '下一步' }).click()

  // ---- Step 2: prepaid-card-picker → 点 ¥500 档位 ----
  await expect(page.getByText('档位快选').first()).toBeVisible({ timeout: 15000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-26-01-tiers.png` })

  // 档位按钮上有 "¥500" + "9.9 折 · 实付 ¥495"；click 外层 button
  const tierBtn = page.locator('button').filter({ hasText: '¥500' }).filter({ hasText: '9.9 折' }).first()
  await expect(tierBtn).toBeVisible({ timeout: 5000 })
  await tierBtn.click()
  console.log('[链路26] 已选 ¥500 档位')

  await page.waitForTimeout(500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-26-02-cart.png` })

  const nextBtn = page.getByRole('button', { name: '下一步' })
  await expect(nextBtn).toBeEnabled({ timeout: 5000 })
  await nextBtn.click()

  // ---- Step 3: 反例验证 — 内部单/转换单按钮 disabled ----
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toHaveAttribute('aria-pressed', 'true')

  const internalBtn = page.getByRole('button', { name: '内部单', exact: true })
  const conversionBtn = page.getByRole('button', { name: '转换单', exact: true })
  const internalDisabled = (await internalBtn.count()) > 0 ? await internalBtn.isDisabled() : false
  const conversionDisabled = (await conversionBtn.count()) > 0 ? await conversionBtn.isDisabled() : false
  console.log(`[链路26] 反例锁定 — 内部单 disabled=${internalDisabled} 转换单 disabled=${conversionDisabled}`)

  // 线下支付 + 提交
  const paySelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
  if (await paySelect.count() > 0) {
    await paySelect.selectOption({ label: '线下支付' })
  }
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-26-03-step3.png` })

  await page.getByRole('button', { name: /提交订单/ }).click()
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })

  let saleOrderId = ''
  const t1 = await page.textContent('body') || ''
  const m1 = t1.match(/FY-XSD-WX-\d{10}/)
  if (m1) saleOrderId = m1[0]

  // 线下支付的确认收款
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
  console.log(`[链路26] saleOrderId=${saleOrderId}`)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-26-04-paid.png` })

  // ---- DB 验证 ----
  const verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL'; actual: string }> = []

  verdicts.push({
    check: 'UI 反例：内部单按钮 disabled',
    verdict: internalDisabled ? 'PASS' : 'FAIL',
    actual: String(internalDisabled),
  })
  verdicts.push({
    check: 'UI 反例：转换单按钮 disabled',
    verdict: conversionDisabled ? 'PASS' : 'FAIL',
    actual: String(conversionDisabled),
  })

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
    check: 'sale_orders.sale_order_type = 销售单（强制）',
    verdict: oType === '销售单' ? 'PASS' : 'FAIL',
    actual: oType,
  })
  verdicts.push({
    check: 'sale_orders.total_amount = 495.00',
    verdict: Number(oTotal) === TIER_PAY_AMOUNT ? 'PASS' : 'FAIL',
    actual: oTotal,
  })

  const itemRow = psql(
    `SELECT sku_id, is_recharge_card, unit_real_price, product_name, quantity FROM sale_items WHERE sale_order_id='${saleOrderId}'`,
  )
  const [iSku, iIsRecharge, iPrice, iName, iQty] = itemRow.split('|')
  verdicts.push({
    check: 'sale_items.sku_id = sku-recharge-virtual',
    verdict: iSku === RECHARGE_VIRTUAL_SKU ? 'PASS' : 'FAIL',
    actual: iSku,
  })
  verdicts.push({
    check: 'sale_items.is_recharge_card = true',
    verdict: iIsRecharge === 't' ? 'PASS' : 'FAIL',
    actual: iIsRecharge,
  })
  verdicts.push({
    check: 'sale_items.unit_real_price = 495.00（matchTier 反推）',
    verdict: Number(iPrice) === TIER_PAY_AMOUNT ? 'PASS' : 'FAIL',
    actual: iPrice,
  })
  verdicts.push({
    check: `sale_items.product_name 含 ¥${TIER_FACE_VALUE}`,
    verdict: iName.includes(String(TIER_FACE_VALUE)) ? 'PASS' : 'FAIL',
    actual: iName,
  })
  verdicts.push({
    check: 'sale_items.quantity = 1（强制一单一笔）',
    verdict: Number(iQty) === 1 ? 'PASS' : 'FAIL',
    actual: iQty,
  })

  // 充值入账：balance 应 +TIER_FACE_VALUE（面值，不是实付）
  const balanceAfter = Number(
    psql(`SELECT COALESCE(balance, 0) FROM prepaid_cards WHERE user_id='${FIXTURE_USER_ID}'`) || '0',
  )
  const delta = balanceAfter - balanceBefore
  verdicts.push({
    check: `prepaid_cards.balance 增加 ¥${TIER_FACE_VALUE}（面值）`,
    verdict: Math.abs(delta - TIER_FACE_VALUE) < 0.01 ? 'PASS' : 'FAIL',
    actual: `before=¥${balanceBefore} after=¥${balanceAfter} delta=¥${delta}`,
  })

  // card_transactions 应有一行充值流水
  const txnRow = psql(
    `SELECT type, amount FROM card_transactions WHERE ref_order_id='${saleOrderId}'`,
  )
  const [tType, tAmount] = txnRow.split('|')
  verdicts.push({
    check: `card_transactions 写入 type=充值 amount=${TIER_FACE_VALUE}`,
    verdict: tType === '充值' && Number(tAmount) === TIER_FACE_VALUE ? 'PASS' : 'FAIL',
    actual: `type=${tType} amount=¥${tAmount}`,
  })

  console.log('\n=== 链路 26 验证 ===')
  for (const v of verdicts) console.log(`  [${v.verdict}] ${v.check} — 实际: ${v.actual}`)
  const failed = verdicts.filter((v) => v.verdict === 'FAIL')

  writeContext({
    link26: {
      saleOrderId,
      balanceBefore,
      balanceAfter,
      verdicts: verdicts.length,
      failed: failed.length,
      status: failed.length === 0 ? 'PASS' : 'FAIL',
      ranAt: new Date().toISOString(),
    },
  })

  // ---- 清理：恢复 balance / 删流水 / 删订单 ----
  // 先恢复 balance（NULL 化 ref 会留下幽灵流水冲账，所以直接 DELETE）
  psql(`UPDATE prepaid_cards SET balance = balance - ${TIER_FACE_VALUE} WHERE user_id='${FIXTURE_USER_ID}'`)
  psql(`DELETE FROM card_transactions WHERE ref_order_id='${saleOrderId}'`)
  cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路26]', preserveCardTransactions: false })

  expect(failed, `失败项: ${failed.map((v) => v.check).join(', ')}`).toEqual([])
})
