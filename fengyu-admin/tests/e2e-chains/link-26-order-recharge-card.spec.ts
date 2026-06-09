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
const TIER_FACE_VALUE = 500
const TIER_PAY_AMOUNT = 495 // 500 × 0.99

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

  // ---- 前置清理：上次跑批若中段失败，会在 fixture 顾客身上留下「待支付」充值单，
  // 触发 createRechargeOrder 的"该顾客已有待支付订单"业务规则（CONFLICT）→ submit 静默失败、
  // 页面停在确认页 → 找不到「确认收款」按钮。这里强制清理同顾客所有「待支付」残留。----
  try {
    const stale = psql(
      `SELECT sale_order_id FROM sale_orders WHERE client_user_id='${FIXTURE_USER_ID}' AND status='待支付'`,
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const sid of stale) {
      console.log(`[链路26] 清理上次遗留待支付订单: ${sid}`)
      cleanupSaleOrder(sid, psql, { logPrefix: '[链路26 pre-clean]', preserveCardTransactions: false })
    }
  } catch (e) {
    console.error(`[链路26] 前置清理失败（非致命）: ${e instanceof Error ? e.message : String(e)}`)
  }

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
  await expect(page.getByText('充值档位').first()).toBeVisible({ timeout: 15000 })
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

  // ---- Step 3: 充值确认页（2026-05-21 充值入口收敛到 createRechargeOrder 专用流程）----
  // 充值卡分支没有「销售单/内部单/转换单」类型选择器（仅普通下单 Step 3 才有），
  // 该分支直接展示支付方式 select + 提交订单按钮。原"内部单/转换单 disabled 反例"已不适用，移除。

  // 线下支付 + 提交（必须确实切到线下，否则 Step 3 不渲染「确认收款」按钮）
  const paySelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
  await expect(paySelect).toBeVisible({ timeout: 10000 })
  // option value='线下'，显示文案='线下支付'；按 value 选更稳
  await paySelect.selectOption('线下')
  await expect(paySelect).toHaveValue('线下')
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-26-03-step3.png` })

  await page.getByRole('button', { name: /提交充值订单|提交订单/ }).click()
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/).first()).toBeVisible({ timeout: 20000 })

  let saleOrderId = ''
  const t1 = await page.textContent('body') || ''
  const m1 = t1.match(/FY-XSD-WX-\d{10}/)
  if (m1) saleOrderId = m1[0]

  // 线下支付的确认收款
  const confirmPayBtn = page.getByRole('button', { name: '确认收款' })
  await expect(confirmPayBtn).toBeVisible({ timeout: 10000 })
  await confirmPayBtn.click()
  // 充值单线下确认收款后：heading 切到「收款已确认」，并展示「储值卡已入账 +¥500」（recharge paymentConfirmed 分支）
  await expect(page.getByText(/收款已确认|储值卡已入账|收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({ timeout: 15000 })

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

  const orderRow = psql(
    `SELECT status, sale_order_type, total_amount, payable_amount FROM sale_orders WHERE sale_order_id='${saleOrderId}'`,
  )
  const [oStatus, oType, oTotal, oPayable] = orderRow.split('|')
  verdicts.push({
    check: 'sale_orders.status = 已支付',
    verdict: oStatus === '已支付' ? 'PASS' : 'FAIL',
    actual: oStatus,
  })
  verdicts.push({
    // 2026-05-21 充值卡 SKU 化剥离后，createRechargeOrder 写 sale_order_type='充值单'（0 sale_items），
    // 不再是带 sku-recharge-virtual 行的 '销售单'（commit 44f35b00 移除 sale_items.is_recharge_card 列）。
    check: 'sale_orders.sale_order_type = 充值单',
    verdict: oType === '充值单' ? 'PASS' : 'FAIL',
    actual: oType,
  })
  verdicts.push({
    // createRechargeOrder: total_amount = 面值(500)，payable_amount = 实付(495)
    check: `sale_orders.total_amount = ${TIER_FACE_VALUE}.00（面值）`,
    verdict: Number(oTotal) === TIER_FACE_VALUE ? 'PASS' : 'FAIL',
    actual: oTotal,
  })
  verdicts.push({
    check: `sale_orders.payable_amount = ${TIER_PAY_AMOUNT}.00（实付）`,
    verdict: Number(oPayable) === TIER_PAY_AMOUNT ? 'PASS' : 'FAIL',
    actual: oPayable,
  })

  // 2026-05-21 充值单不再生成 sale_items（createRechargeOrder 写 0 items），
  // 故原 sale_items.sku_id / is_recharge_card / unit_real_price / quantity 校验已删除。
  // 改为断言该充值单确实无明细行。
  const itemCount = Number(
    psql(`SELECT COUNT(*) FROM sale_items WHERE sale_order_id='${saleOrderId}'`) || '0',
  )
  verdicts.push({
    check: 'sale_items 行数 = 0（充值单无明细）',
    verdict: itemCount === 0 ? 'PASS' : 'FAIL',
    actual: String(itemCount),
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
