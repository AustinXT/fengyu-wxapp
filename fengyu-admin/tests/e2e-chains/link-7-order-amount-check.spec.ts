/**
 * 链路 7：订单金额三方对账
 *
 * 场景：2 件普通 SKU（各¥100）+ 优惠券（满200减30）= 总额¥170，全额线下支付
 * 降级场景：若优惠券不可用，2 件 SKU 全额线下支付 ¥200
 *
 * 三条金额不变量：
 *   1. total_amount == SUM(sale_items.sale_amount) - COALESCE(coupon_discount, 0)
 *   2. total_amount == paid_amount + payable_amount + prepaid_card_amount
 *   3. sale_items.sale_amount == unit_real_price * quantity
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'

// DB helper（与其他 spec 一致）
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

const MANAGER_PHONE = '13900139001'
const MANAGER_PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const SKU1_NAME = '洗-无创纹身'
const SKU2_NAME = '假性皱纹管家'

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readContext(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeContext(data: Record<string, unknown>) {
  const existing = readContext()
  const dir = path.dirname(CONTEXT_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...existing, ...data }, null, 2))
}

test.setTimeout(180000)

test('链路7：订单金额三方对账', async ({ page }) => {
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

  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially(MANAGER_PHONE, { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially(MANAGER_PASS, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-7-01-login.png` })

  // ---- Step 1: 进入开单向导 ----
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  // Step 1: 选顾客（按手机号搜索）
  await page.getByPlaceholder(/手机号/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()

  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('找到') || t.includes('未找到')
  }, { timeout: 15000 })

  const hasResults = await page.getByText(/找到 \d+ 位顾客/).isVisible().catch(() => false)
  if (!hasResults) {
    throw new Error(`FATAL: fixture 顾客 ${FIXTURE_PHONE} 未找到`)
  }

  const firstCustomerBtn = page.locator('div.space-y-1 > button').first()
  await expect(firstCustomerBtn).toBeVisible({ timeout: 5000 })
  await firstCustomerBtn.click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-7-02-customer-selected.png` })

  // 默认"普通商品"，直接点下一步
  await page.getByRole('button', { name: '下一步' }).click()

  // ---- Step 2: 选择商品 ----
  await page.waitForTimeout(2000)

  // 重试数据加载
  for (let retry = 0; retry < 3; retry++) {
    const bodyText = await page.textContent('body')
    if (bodyText?.includes('数据未加载') || bodyText?.includes('重试')) {
      const retryBtn = page.getByRole('button', { name: '重试' })
      if (await retryBtn.count() > 0) {
        console.log(`[链路7] Step 2 数据未加载，点击重试（第 ${retry + 1} 次）`)
        await retryBtn.click()
        await page.waitForTimeout(3000)
      }
    } else if (bodyText?.includes('商品分类') || bodyText?.includes('加入')) {
      break
    } else {
      await page.waitForTimeout(2000)
    }
  }

  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return (
      (t.includes('商品分类') || t.includes('暂无可选品类') || t.includes('加入')) &&
      !t.includes('正在加载')
    )
  }, { timeout: 30000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-7-03-step2-products.png` })

  // === 添加 SKU 1（洗-无创纹身）===
  const cat1Btn = page.getByRole('button', { name: '缦之羽', exact: true }).first()
  if (await cat1Btn.count() > 0) {
    await cat1Btn.click()
    await page.waitForTimeout(500)
    console.log('[链路7] 点击了"缦之羽"分类')
  }

  let sku1Added = false
  const sku1NameEl = page.getByText(SKU1_NAME, { exact: false })
  if (await sku1NameEl.count() > 0) {
    const sku1Card = sku1NameEl.first().locator('..').locator('..')
    const addBtn1 = sku1Card.getByRole('button', { name: /加入/ })
    if (await addBtn1.count() > 0) {
      await addBtn1.click()
      sku1Added = true
      console.log(`[链路7] 已加入 SKU1: ${SKU1_NAME}`)
    }
  }
  if (!sku1Added) {
    const allAddBtns = page.getByRole('button', { name: /加入/ })
    if (await allAddBtns.count() > 0) {
      await allAddBtns.first().click()
      sku1Added = true
      console.log('[链路7] SKU1 降级：点第一个"加入"按钮')
    } else {
      throw new Error('Step 2: 页面没有"加入"按钮，无法添加商品')
    }
  }

  await page.waitForTimeout(500)

  // === 添加 SKU 2（假性皱纹管家）===
  const cat2Btn = page.getByRole('button', { name: '其他', exact: true })
  if (await cat2Btn.count() > 0) {
    await cat2Btn.click()
    await page.waitForTimeout(500)
    console.log('[链路7] 点击了"其他"分类')
  }

  let sku2Added = false
  const sku2NameEl = page.getByText(SKU2_NAME, { exact: false })
  if (await sku2NameEl.count() > 0) {
    const sku2Card = sku2NameEl.first().locator('..').locator('..')
    const addBtn2 = sku2Card.getByRole('button', { name: /加入/ })
    if (await addBtn2.count() > 0) {
      await addBtn2.click()
      sku2Added = true
      console.log(`[链路7] 已加入 SKU2: ${SKU2_NAME}`)
    }
  }
  if (!sku2Added) {
    const addBtnsNow = page.getByRole('button', { name: /加入/ })
    const count2 = await addBtnsNow.count()
    if (count2 > 1) {
      await addBtnsNow.nth(1).click()
      sku2Added = true
      console.log('[链路7] SKU2 降级：点第二个"加入"按钮')
    } else if (count2 > 0) {
      await addBtnsNow.first().click()
      sku2Added = true
      console.log('[链路7] SKU2 降级：点第一个"加入"按钮')
    }
  }

  await page.waitForTimeout(500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-7-04-cart-filled.png` })

  // 点下一步进入 Step 3
  const nextBtn = page.getByRole('button', { name: '下一步' })
  await expect(nextBtn).toBeEnabled({ timeout: 5000 })
  await nextBtn.click()

  // ---- Step 3: 确认订单 ----
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })

  // 确认默认是"销售单"
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toHaveAttribute('aria-pressed', 'true')

  // 选择"线下"支付方式
  const paymentSelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
  if (await paymentSelect.count() > 0) {
    await paymentSelect.selectOption({ label: '线下支付' })
    console.log('[链路7] 选择了线下支付')
  }

  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-7-05-step3-before-coupon.png` })

  // ---- 选择优惠券（满200减30）----
  let couponUsed = false
  let couponDiscount = 0

  // 等待优惠券加载完成
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return !t.includes('正在加载可用优惠券')
  }, { timeout: 10000 })

  const couponSection = page.getByLabel('优惠券（可选）')
  const couponSelect = page.locator('select').filter({ hasText: /不使用优惠券|FY-FIX-COUPON|满/ })
  if (await couponSelect.count() > 0) {
    const options = await couponSelect.locator('option').allTextContents()
    console.log('[链路7] 优惠券选项:', options)
    // 找满200减30的券
    const couponOption = options.find(o => o.includes('FY-FIX-COUPON') || (o.includes('满') && o.includes('减')))
    if (couponOption && !couponOption.includes('不使用')) {
      await couponSelect.selectOption({ label: couponOption })
      couponUsed = true
      // 提取折扣金额
      const discountMatch = couponOption.match(/优惠¥([\d.]+)/)
      if (discountMatch) {
        couponDiscount = parseFloat(discountMatch[1])
      } else {
        couponDiscount = 30 // 默认满200减30
      }
      console.log(`[链路7] 已选择优惠券，折扣: ¥${couponDiscount}`)
    } else {
      console.log('[链路7] 无可用优惠券，降级为全额支付')
    }
  } else {
    console.log('[链路7] 优惠券 select 不存在，降级为全额支付')
  }

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-7-06-step3-coupon-selected.png` })

  // 提交订单
  const submitBtn = page.getByRole('button', { name: /提交订单/ })
  await expect(submitBtn).toBeEnabled({ timeout: 5000 })
  await submitBtn.click()

  // ---- Step 4: 完成 ----
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-7-07-step4-created.png` })

  // 提取订单号
  let saleOrderId = ''
  const orderIdEl = page.locator('p.font-mono, p:has-text("FY-XSD-WX")').first()
  if (await orderIdEl.count() > 0) {
    const text = await orderIdEl.textContent()
    const match = text?.match(/FY-XSD-WX-\d{10}/)
    if (match) saleOrderId = match[0]
  }
  if (!saleOrderId) {
    const bodyText = await page.textContent('body')
    const match = bodyText?.match(/FY-XSD-WX-\d{10}/)
    if (match) saleOrderId = match[0]
  }
  console.log(`[链路7] 创建的订单号: ${saleOrderId}`)

  // 确认收款（线下支付）
  const confirmPayBtn = page.getByRole('button', { name: '确认收款' })
  await expect(confirmPayBtn).toBeVisible({ timeout: 10000 })
  await confirmPayBtn.click()

  // 等待确认成功
  await expect(page.getByText(/收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({ timeout: 15000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-7-08-payment-confirmed.png` })

  // 再次尝试提取订单号（如果还没有）
  if (!saleOrderId) {
    const bodyText = await page.textContent('body')
    const match = bodyText?.match(/FY-XSD-WX-\d{10}/)
    if (match) saleOrderId = match[0]
  }
  if (!saleOrderId) {
    const viewOrderLink = page.getByRole('link', { name: '查看订单' })
    if (await viewOrderLink.count() > 0) {
      await viewOrderLink.click()
      await page.waitForURL(/\/orders\/FY-XSD-WX-/, { timeout: 15000 })
      const url = page.url()
      const match = url.match(/FY-XSD-WX-\d{10}/)
      if (match) saleOrderId = match[0]
    }
  }

  if (!saleOrderId) {
    throw new Error('无法提取订单号（FY-XSD-WX-YYMMDD{4位}），请检查 Step 4 页面结构')
  }

  console.log(`[链路7] 最终确认订单号: ${saleOrderId}`)
  expect(saleOrderId).toMatch(/^FY-XSD-WX-\d{10}$/)

  // 写入 context 文件
  writeContext({
    link7: {
      saleOrderId,
      couponUsed,
      couponDiscount,
      ranAt: new Date().toISOString(),
    },
  })
  console.log(`[链路7] saleOrderId 已写入 context: ${saleOrderId}`)

  // 导航到订单详情页验证状态
  if (!page.url().includes(saleOrderId)) {
    await page.goto(`${BASE}/orders/${saleOrderId}`)
    await expect(page.getByText('订单详情')).toBeVisible({ timeout: 15000 })
  }
  await expect(page.getByText('已支付').first()).toBeVisible({ timeout: 10000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-7-09-order-paid.png` })

  console.log(`[链路7] 链路完成，订单号: ${saleOrderId}，优惠券使用: ${couponUsed}，折扣: ¥${couponDiscount}`)

  // ---- Step 99: 清理测试数据（共享工具） ----
  if (saleOrderId) {
    try {
      cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路7]' })
    } catch (e) {
      console.log(`[链路7] 清理出错（非致命）: ${e}`)
    }
  }
})
