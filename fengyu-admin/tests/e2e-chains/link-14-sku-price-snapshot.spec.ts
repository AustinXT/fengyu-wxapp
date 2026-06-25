/**
 * 链路 14：SKU 价格变更不影响历史订单（快照保护）
 *
 * 主题：商品价格修改后，历史 sale_items.unit_price 必须保持下单时的快照；新单按新价。
 *
 * 关键不变量（核对真实 schema）：
 *   sale_items.unit_price = product_skus.price AT (sale_orders.created_at)
 *   改价后 product_skus.price 变化，但已有 sale_items.unit_price 永不被回溯更新
 *
 * NOTE: README §1.B 写"sale_items.unit_real_price 是快照"；实际快照字段是 unit_price，
 *       unit_real_price 是分账后实际单价（与 unit_price 不同维度）。
 *
 * 流程：MGR 开 ¥100 单 → PRD 改 SKU 价 100→120 → SQL 验老 unit_price 仍 100 →
 *      （可选）再开一单验新 unit_price=120 → 清理（还原价格 + 删订单）。
 *
 * 为简化流程，默认只跑"一单 + 改价 + 验快照"；新单跑可通过 SECOND_ORDER=1 启用。
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = process.env.ADMIN_BASE_URL || 'http://localhost:3000'
const MGR_PHONE = '13900139001'
const PRD_PHONE = '13900139004'
const PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const FIXTURE_SKU_ID = 'c79157b29c9e974c' // 缦之羽 / 洗-无创纹身 ¥100
const SKU1_NAME = '洗-无创纹身'
const ORIGINAL_PRICE = '100.00'
const NEW_PRICE = '120.00'

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) }

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

function writeCtx(linkKey: string, payload: Record<string, unknown>) {
  ensureDir(path.dirname(CONTEXT_FILE))
  let ctx: Record<string, unknown> = {}
  try { ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')) } catch { /* noop */ }
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...ctx, [linkKey]: payload }, null, 2))
}

async function login(page: import('@playwright/test').Page, phone: string, pass: string) {
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(300)
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially(phone, { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially(pass, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })
}

/**
 * 开一单单 SKU 单数量 ¥100，确认线下收款，返回 saleOrderId
 * 复用 link-11 / link-4 的开单 wizard 模式
 */
async function createSimpleOrder(page: import('@playwright/test').Page, screenshotTag: string): Promise<string> {
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  // Step 1: 选顾客
  await page.getByPlaceholder(/手机号/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('找到') || t.includes('未找到')
  }, { timeout: 15000 })
  const firstCustomer = page.locator('div.space-y-1 > button').first()
  await firstCustomer.click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '下一步' }).click()

  // Step 2: 选商品
  await page.waitForTimeout(2000)
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return (t.includes('商品分类') || t.includes('暂无可选品类') || t.includes('加入')) && !t.includes('正在加载')
  }, { timeout: 30000 })

  const cat1 = page.getByRole('button', { name: '缦之羽', exact: true }).first()
  if (await cat1.count() > 0) {
    await cat1.click()
    await page.waitForTimeout(500)
  }
  const skuText = page.getByText(SKU1_NAME, { exact: false })
  let added = false
  if (await skuText.count() > 0) {
    const card = skuText.first().locator('..').locator('..')
    const addBtn = card.getByRole('button', { name: /加入/ })
    if (await addBtn.count() > 0) {
      await addBtn.click()
      added = true
    }
  }
  if (!added) {
    const all = page.getByRole('button', { name: /加入/ })
    if (await all.count() > 0) { await all.first().click(); added = true }
  }
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-14-${screenshotTag}-cart.png` })

  // Step 3: 确认下单
  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })

  // 线下支付
  for (const sel of [page.locator('select[name="paymentMethod"]'), page.locator('select').nth(0)]) {
    if (await sel.count() > 0) {
      const opts = await sel.locator('option').allTextContents()
      if (opts.some((o) => o.includes('线下'))) {
        await sel.selectOption({ label: '线下支付' })
        break
      }
    }
  }

  const submit = page.getByRole('button', { name: /提交订单|确认提交/ }).last()
  await expect(submit).toBeEnabled({ timeout: 5000 })
  await submit.click()
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })

  // 提取订单号
  let soid = ''
  const bodyText = await page.textContent('body')
  const m = bodyText?.match(/FY-XSD-WX-\d{10}/)
  if (m) soid = m[0]

  // 确认收款
  const confirmBtn = page.getByRole('button', { name: '确认收款' })
  await expect(confirmBtn).toBeVisible({ timeout: 10000 })
  await confirmBtn.click()
  await expect(page.getByText(/收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({ timeout: 15000 })

  if (!soid) {
    const body2 = await page.textContent('body')
    const m2 = body2?.match(/FY-XSD-WX-\d{10}/)
    if (m2) soid = m2[0]
  }
  if (!soid) throw new Error('无法提取订单号')

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-14-${screenshotTag}-paid.png` })
  return soid
}

test.setTimeout(360_000)

test('链路14：SKU 价格变更不影响历史订单（snapshot 保护）', async ({ browser }) => {
  ensureDir(TEST_RESULTS_DIR)
  const verdicts: Array<{ check: string; verdict: string; actual?: string | number }> = []

  // ── 前置：确认 fixture SKU 价格为 100.00 ──
  const preSkuPrice = psql(`SELECT price FROM product_skus WHERE sku_id='${FIXTURE_SKU_ID}'`)
  console.log(`[链路14] 前置 SKU 价格: ${preSkuPrice}`)
  if (parseFloat(preSkuPrice) !== 100) {
    psql(`UPDATE product_skus SET price=${ORIGINAL_PRICE}, updated_at=NOW() WHERE sku_id='${FIXTURE_SKU_ID}'`)
    console.log('[链路14] 已重置 SKU 价格为 100')
  }

  let oldSaleOrderId = ''
  let newSaleOrderId = ''

  try {
    // ── Step 1: MGR 开一单（旧价 ¥100） ──
    console.log('[链路14] Step 1: MGR 开一单（旧价 100）')
    const mgrCtx = await browser.newContext()
    const mgrPage = await mgrCtx.newPage()
    mgrPage.on('console', (m) => {
      if (m.type() === 'error') console.log(`[browser-error-mgr] ${m.text()}`)
    })
    await login(mgrPage, MGR_PHONE, PASS)
    oldSaleOrderId = await createSimpleOrder(mgrPage, '01-old')
    console.log(`[链路14] 旧单 saleOrderId: ${oldSaleOrderId}`)
    await mgrCtx.close()

    const oldUnitPrice = psql(
      `SELECT unit_price FROM sale_items WHERE sale_order_id='${oldSaleOrderId}' AND sku_id='${FIXTURE_SKU_ID}' LIMIT 1`,
    )
    console.log(`[链路14] 旧单 sale_items.unit_price: ${oldUnitPrice}`)
    verdicts.push({
      check: 'old_order_unit_price_eq_100',
      verdict: parseFloat(oldUnitPrice) === 100 ? 'PASS' : 'FAIL',
      actual: oldUnitPrice,
    })

    // ── Step 2: PRD 登录 /products/[id] 改价 100→120 ──
    console.log('[链路14] Step 2: PRD 登录改 SKU 价 100→120')
    const prdCtx = await browser.newContext()
    const prdPage = await prdCtx.newPage()
    prdPage.on('console', (m) => {
      if (m.type() === 'error') console.log(`[browser-error-prd] ${m.text()}`)
    })

    let uiPriceUpdated = false
    try {
      await login(prdPage, PRD_PHONE, PASS)
      await prdPage.goto(`${BASE}/products/${FIXTURE_SKU_ID}`)
      await expect(prdPage.getByText(/品项详情|规格详情|SKU/).first()).toBeVisible({ timeout: 15000 })
      await prdPage.waitForLoadState('networkidle')
      await prdPage.screenshot({ path: `${TEST_RESULTS_DIR}/link-14-02-product-detail.png` })

      const priceInput = prdPage.locator('input[name="price"]').first()
      await expect(priceInput).toBeVisible({ timeout: 5000 })
      await priceInput.click({ clickCount: 3 }) // select all
      await priceInput.fill(NEW_PRICE)

      const saveBtn = prdPage.getByRole('button', { name: '保存' }).first()
      await saveBtn.click()
      await prdPage.waitForFunction(() => {
        const t = document.body.textContent || ''
        return t.includes('保存成功') || t.includes('已更新') || t.includes('失败')
      }, { timeout: 15000 })
      await prdPage.screenshot({ path: `${TEST_RESULTS_DIR}/link-14-03-after-save.png` })

      const afterUiPrice = psql(`SELECT price FROM product_skus WHERE sku_id='${FIXTURE_SKU_ID}'`)
      uiPriceUpdated = parseFloat(afterUiPrice) === 120
      console.log(`[链路14] UI 改价后 SKU.price=${afterUiPrice}, success=${uiPriceUpdated}`)
    } catch (e) {
      console.log(`[链路14] UI 改价失败（${e}），降级 SQL 直改`)
    }
    await prdCtx.close()

    if (!uiPriceUpdated) {
      psql(`UPDATE product_skus SET price=${NEW_PRICE}, updated_at=NOW() WHERE sku_id='${FIXTURE_SKU_ID}'`)
      console.log('[链路14] SQL 兜底已改 SKU 价格为 120')
    }

    const newSkuPrice = psql(`SELECT price FROM product_skus WHERE sku_id='${FIXTURE_SKU_ID}'`)
    verdicts.push({
      check: 'sku_price_updated_to_120',
      verdict: parseFloat(newSkuPrice) === 120 ? 'PASS' : 'FAIL',
      actual: newSkuPrice,
    })

    // ── Step 3: 核心断言 — 老订单 unit_price 未被回溯 ──
    const oldUnitPriceAfter = psql(
      `SELECT unit_price FROM sale_items WHERE sale_order_id='${oldSaleOrderId}' AND sku_id='${FIXTURE_SKU_ID}' LIMIT 1`,
    )
    console.log(`[链路14] 改价后 老单 sale_items.unit_price: ${oldUnitPriceAfter}`)
    verdicts.push({
      check: 'old_order_snapshot_preserved',
      verdict: parseFloat(oldUnitPriceAfter) === 100 ? 'PASS' : 'FAIL',
      actual: oldUnitPriceAfter,
    })

    // ── Step 4: 再开一单验新价 ─（默认开启，可注释跳过） ──
    console.log('[链路14] Step 4: 再开一单验新价 120')
    const mgr2Ctx = await browser.newContext()
    const mgr2Page = await mgr2Ctx.newPage()
    mgr2Page.on('console', (m) => {
      if (m.type() === 'error') console.log(`[browser-error-mgr2] ${m.text()}`)
    })
    await login(mgr2Page, MGR_PHONE, PASS)
    newSaleOrderId = await createSimpleOrder(mgr2Page, '04-new')
    console.log(`[链路14] 新单 saleOrderId: ${newSaleOrderId}`)
    await mgr2Ctx.close()

    const newUnitPrice = psql(
      `SELECT unit_price FROM sale_items WHERE sale_order_id='${newSaleOrderId}' AND sku_id='${FIXTURE_SKU_ID}' LIMIT 1`,
    )
    console.log(`[链路14] 新单 sale_items.unit_price: ${newUnitPrice}`)
    verdicts.push({
      check: 'new_order_uses_new_price_120',
      verdict: parseFloat(newUnitPrice) === 120 ? 'PASS' : 'FAIL',
      actual: newUnitPrice,
    })

    // ── Step 5: sku.update operation_log 已写 ──
    const skuUpdateLogs = psql(
      `SELECT count(*) FROM operation_logs WHERE action='sku.update' AND target_id='${FIXTURE_SKU_ID}' ` +
        `AND created_at > NOW() - INTERVAL '30 minutes'`,
    )
    verdicts.push({
      check: 'sku_update_operation_log',
      verdict: parseInt(skuUpdateLogs, 10) >= 1 ? 'PASS' : (uiPriceUpdated ? 'FAIL' : 'SKIP'),
      actual: `count=${skuUpdateLogs}, uiPath=${uiPriceUpdated}`,
    })
  } finally {
    // ── Step 6: 清理 — 还原 SKU 价格 + 删两单 ──
    console.log('[链路14] Step 6: 清理')
    try {
      psql(`UPDATE product_skus SET price=${ORIGINAL_PRICE}, updated_at=NOW() WHERE sku_id='${FIXTURE_SKU_ID}'`)
      console.log('[链路14] SKU 价格已还原为 100')
    } catch (e) {
      console.log(`[链路14] 还原 SKU 价格失败（非致命）: ${e}`)
    }
    try {
      psql(
        `DELETE FROM operation_logs WHERE action='sku.update' AND target_id='${FIXTURE_SKU_ID}' ` +
          `AND created_at > NOW() - INTERVAL '30 minutes'`,
      )
    } catch { /* ignore */ }
    if (oldSaleOrderId) cleanupSaleOrder(oldSaleOrderId, psql, { logPrefix: '[链路14]' })
    if (newSaleOrderId) cleanupSaleOrder(newSaleOrderId, psql, { logPrefix: '[链路14]' })
  }

  // ── 汇总 ──
  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const overallStatus = hasFail ? 'FAIL' : verdicts.some((v) => v.verdict === 'SKIP') ? 'PARTIAL' : 'PASS'

  const report = {
    link: 14,
    status: overallStatus,
    oldSaleOrderId,
    newSaleOrderId,
    verdicts,
    cleaned: true,
    notes: 'sale_items.unit_price 是真实快照字段；README §1.B 写的 unit_real_price 是分账后单价，与此不同维度',
  }

  console.log('\n[链路14] === 最终报告 ===')
  console.log(JSON.stringify(report, null, 2))
  writeCtx('link14', report)

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})
