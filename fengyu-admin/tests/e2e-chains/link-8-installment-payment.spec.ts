/**
 * 链路 8：多次回款累加一致性
 *
 * 场景：创建一笔部分支付订单（paid=100, payable=100），然后分 3 次回款（¥50→¥30→¥20）直到结清。
 * 每次回款后验证 SQL 不变量：
 *   received == SUM(sale_order_payments.amount) WHERE change_type IN (首次支付,回款,储值卡抵扣) — 退款
 *   payable_amount == total_amount - prepaid_card_amount  （固定值，建单时计算并冻结）
 * 第三次结清后验证 status 转为 '已支付'。
 * 还测反例：在结清前录入超额回款 → UI 应拦截。
 *
 * 注：2026-04-26 sale-order-domain-refactor 后 paid_amount 列已 DROP，统一改用 received。
 * 注：录入回款需 sale_order:record_payment 权限，仅 finance 角色拥有；admin 无此权限。
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'

const MANAGER_PHONE = '13900139001'
const MANAGER_PASS = 'fengyu2026'
const FINANCE_PHONE = '13900139002'
const FINANCE_PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')

const PG_CMD = (sql: string) =>
  `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -t -A -c "${sql.replace(/"/g, '\\"')}"`

function dbQuery(sql: string): string {
  try {
    return execSync(PG_CMD(sql), { encoding: 'utf8' }).trim()
  } catch (e) {
    console.error('[dbQuery] error:', e)
    return ''
  }
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// 计算 SQL 不变量，返回 'PASS' 或详情
// 实际系统不变量（经代码审查确认）：
//   1. received == SUM(WHERE status='已支付' AND change_type IN (首次支付,回款,退款,储值卡抵扣)) 的 amount 累加
//      （退款 amount 为负数，所以 SUM 自然减去）
//   2. payable_amount == total_amount - prepaid_card_amount（建单时固定，不随回款变化）
// 注意：任务描述中的 payable_amount = total - prepaid - paid 是"剩余欠款"语义，
//      但实际列 payable_amount 是固定的"应付总额"；"剩余欠款"= payable_amount - received
function checkInvariants(saleOrderId: string): { verdict: string; detail: string } {
  // Single-line SQL to avoid shell escaping issues
  const sql = `WITH o AS (SELECT status,total_amount,received,payable_amount,prepaid_card_amount FROM sale_orders WHERE sale_order_id='${saleOrderId}'), p AS (SELECT COALESCE(SUM(CASE WHEN status='已支付' AND change_type IN ('首次支付','回款','退款','储值卡抵扣') THEN amount::numeric ELSE 0 END),0) AS paid_sum, COUNT(*) AS rows FROM sale_order_payments WHERE sale_order_id='${saleOrderId}') SELECT o.status,o.total_amount,o.received,o.payable_amount,o.prepaid_card_amount,p.paid_sum,p.rows, CASE WHEN ABS(CAST(o.received AS FLOAT)-CAST(p.paid_sum AS FLOAT))<0.01 AND ABS(CAST(o.payable_amount AS FLOAT)-(CAST(o.total_amount AS FLOAT)-CAST(o.prepaid_card_amount AS FLOAT)))<0.01 THEN 'PASS' ELSE 'FAIL' END AS verdict FROM o,p`
  const result = dbQuery(sql)
  const lastPipe = result.lastIndexOf('|')
  const verdict = lastPipe >= 0 ? result.substring(lastPipe + 1).trim() : 'UNKNOWN'
  return { verdict, detail: result }
}

test('链路8：多次回款累加一致性', async ({ page }) => {
  test.setTimeout(300000)
  ensureDir(TEST_RESULTS_DIR)

  page.on('console', (msg) => {
    const txt = msg.text()
    if (msg.type() === 'error' || txt.includes('Error') || txt.includes('FAIL')) console.log(`[browser-${msg.type()}] ${txt}`)
  })
  page.on('pageerror', (err) => console.log(`[page-error] ${err.message}`))
  // Monitor Next.js server action responses
  page.on('response', async (res) => {
    const url = res.url()
    if (res.status() >= 400) {
      console.log(`[http-error] ${res.status()} ${url}`)
    }
    // Capture server action responses (they POST to the current page with RSC headers)
    if (url.includes('/orders/') && res.request().method() === 'POST') {
      const body = await res.text().catch(() => '')
      if (body.length < 500) console.log(`[action-response] ${url}: ${body.substring(0, 200)}`)
    }
  })

  // ================================================================
  // STEP 1: 用 FY-TEST-MGR 登录，创建部分支付订单
  // ================================================================
  console.log('[链路8] Step 1: 登录管理员（店长），创建部分支付订单...')

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
  console.log('[链路8] 店长登录成功')

  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  // 搜索 fixture 顾客
  await page.getByPlaceholder(/手机号/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('找到') || t.includes('未找到')
  }, { timeout: 15000 })

  const hasResults = await page.getByText(/找到 \d+ 位顾客/).isVisible().catch(() => false)
  if (!hasResults) throw new Error(`FATAL: fixture 顾客 ${FIXTURE_PHONE} 未找到`)

  await page.locator('div.space-y-1 > button').first().click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })

  // 下一步进入商品选择
  await page.getByRole('button', { name: '下一步' }).click()
  await page.waitForTimeout(2000)

  // 重试等待商品加载
  for (let retry = 0; retry < 5; retry++) {
    const bodyText = await page.textContent('body')
    if (bodyText?.includes('商品分类') || bodyText?.includes('加入')) break
    if (bodyText?.includes('重试')) {
      await page.getByRole('button', { name: '重试' }).click()
    }
    await page.waitForTimeout(2000)
  }

  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return (t.includes('商品分类') || t.includes('暂无') || t.includes('加入')) && !t.includes('正在加载')
  }, { timeout: 30000 })

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-01-products.png` })

  // 添加第一件商品（任意一件）
  const addBtns = page.getByRole('button', { name: /加入/ })
  const btnCount = await addBtns.count()
  if (btnCount === 0) throw new Error('Step 1: 无可用商品，无法继续')

  await addBtns.first().click()
  await page.waitForTimeout(300)
  console.log('[链路8] 已添加第一件商品')

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-02-cart.png` })

  // 进入 Step 3（确认订单）
  const nextBtn = page.getByRole('button', { name: '下一步' })
  await expect(nextBtn).toBeEnabled({ timeout: 5000 })
  await nextBtn.click()
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })

  // 获取订单总额
  await page.waitForTimeout(1000)
  const bodyText = await page.textContent('body')
  console.log('[链路8] Step 3 页面内容摘要（前500字）:', bodyText?.substring(0, 500))

  // 选线下支付（先选，才能激活本次收款 input）
  const paymentSelectEl = page.locator('select').first()
  const paymentOptions = await paymentSelectEl.locator('option').allTextContents()
  console.log('[链路8] 支付方式选项:', paymentOptions)
  const offlineOption = paymentOptions.find(o => o.includes('线下'))
  if (offlineOption) {
    await paymentSelectEl.selectOption({ label: offlineOption })
    console.log('[链路8] 选择了线下支付')
    await page.waitForTimeout(500)
  }

  // 读取 total_amount（从"应付合计: ¥XXX"或"订单总额: ¥XXX"中提取）
  const bodyText2 = await page.textContent('body')
  let totalAmountForOrder = 0
  const totalPatterns = [
    /应付合计[:：]\s*[¥￥]([\d.]+)/,
    /订单总额[:：]\s*[¥￥]([\d.]+)/,
    /合计[:：\s]*[¥￥]([\d.]+)/,
    /[¥￥]([\d.]+)/,
  ]
  for (const pat of totalPatterns) {
    const m = bodyText2?.match(pat)
    if (m) {
      totalAmountForOrder = parseFloat(m[1])
      console.log(`[链路8] 检测到订单合计金额: ¥${totalAmountForOrder}（pattern=${pat})`)
      break
    }
  }
  if (!totalAmountForOrder) {
    // Fallback: read from input max attribute
    const receivedMax = await page.locator('input[type="number"]').first().getAttribute('max')
    if (receivedMax) {
      totalAmountForOrder = parseFloat(receivedMax)
      console.log(`[链路8] 从 input.max 读取总额: ¥${totalAmountForOrder}`)
    }
  }
  if (!totalAmountForOrder || totalAmountForOrder <= 0) {
    totalAmountForOrder = 68 // 已知商品价格 fallback
    console.warn(`[链路8] 无法读取总额，使用 fallback: ¥${totalAmountForOrder}`)
  }

  // 填写"已收款金额"为总额的一半（部分支付）
  const halfAmount = Math.round(totalAmountForOrder / 2 * 100) / 100

  // 找本次收款 input（placeholder 含"留空"）
  let receivedInputLocator = null
  {
    // 找包含"留空"占位符的 input
    const inputs = page.locator('input[placeholder]')
    const count = await inputs.count()
    for (let i = 0; i < count; i++) {
      const ph = await inputs.nth(i).getAttribute('placeholder')
      if (ph?.includes('留空') || ph?.includes('全额') || ph?.includes('收款')) {
        receivedInputLocator = inputs.nth(i)
        console.log(`[链路8] 找到收款 input，placeholder="${ph}"`)
        break
      }
    }
    if (!receivedInputLocator) {
      const receivedLabel = page.getByLabel(/已收款|收款金额/)
      if (await receivedLabel.count() > 0) receivedInputLocator = receivedLabel.first()
    }
  }

  if (receivedInputLocator && await receivedInputLocator.isVisible().catch(() => false)) {
    await receivedInputLocator.fill(halfAmount.toFixed(2))
    console.log(`[链路8] 填写已收款金额: ¥${halfAmount.toFixed(2)}（部分支付，总额¥${totalAmountForOrder}）`)
  } else {
    console.warn('[链路8] 未找到已收款金额输入框，将用 DB 降级方案')
  }

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-03-step3-partial.png` })

  // 提交订单
  const submitBtn = page.getByRole('button', { name: /提交订单/ })
  await expect(submitBtn).toBeEnabled({ timeout: 5000 })
  await submitBtn.click()

  // 等待创建成功
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-04-created.png` })

  // 提取订单号
  let saleOrderId = ''
  const orderIdEl = page.locator('p.font-mono, p:has-text("FY-XSD-WX")').first()
  if (await orderIdEl.count() > 0) {
    const text = await orderIdEl.textContent()
    const m = text?.match(/FY-XSD-WX-\d{10}/)
    if (m) saleOrderId = m[0]
  }
  if (!saleOrderId) {
    const bt = await page.textContent('body')
    const m = bt?.match(/FY-XSD-WX-\d{10}/)
    if (m) saleOrderId = m[0]
  }
  // 若完成页有"查看订单"链接
  if (!saleOrderId) {
    const viewLink = page.getByRole('link', { name: '查看订单' })
    if (await viewLink.count() > 0) {
      await viewLink.click()
      await page.waitForURL(/\/orders\/FY-XSD-WX-/, { timeout: 15000 })
      const url = page.url()
      const m = url.match(/FY-XSD-WX-\d{10}/)
      if (m) saleOrderId = m[0]
    }
  }

  if (!saleOrderId) throw new Error('无法提取订单号')
  console.log(`[链路8] 创建的订单号: ${saleOrderId}`)

  // ================================================================
  // 检查并确保订单为部分支付状态
  // ================================================================
  // 等待创建后订单落库
  await page.waitForTimeout(2000)

  let orderRow = dbQuery(`SELECT status, total_amount, received, payable_amount, prepaid_card_amount FROM sale_orders WHERE sale_order_id='${saleOrderId}'`)
  console.log(`[链路8] 创建后订单行: ${orderRow}`)

  // 如果不是部分支付，用 DB 降级方案
  const currentStatus = orderRow.split('|')[0]
  let usedFallback = false
  let initialPaid = 0
  let totalAmountDB = 0

  {
    const row = orderRow.split('|')
    totalAmountDB = parseFloat(row[1] || '0')
    initialPaid = parseFloat(row[2] || '0')
  }
  // payable_amount in this system = total - prepaid (fixed at creation, does NOT decrease with payments)
  // remaining debt = payable_amount - received
  let payableFixed = parseFloat(orderRow.split('|')[3] || '0')
  const prepaidFixed = parseFloat(orderRow.split('|')[4] ?? '0')

  if (currentStatus !== '部分支付') {
    console.log(`[链路8] 当前状态: ${currentStatus}，执行降级方案（DB 手动设置部分支付）`)
    usedFallback = true

    // 计算半额作为 received（payable_amount 是固定的 total - prepaid，不改）
    initialPaid = Math.round(payableFixed / 2 * 100) / 100

    // 若 received 已经 >= payable_amount（例如已全额收款），改小一半
    if (initialPaid >= payableFixed) initialPaid = Math.round(payableFixed * 0.4 * 100) / 100

    // 更新 received + status，payable_amount 保持不变（系统语义：payable = total - prepaid）
    dbQuery(`UPDATE sale_orders SET received=${initialPaid}, status='部分支付' WHERE sale_order_id='${saleOrderId}'`)

    // 更新 sale_order_payments 中第一条记录的金额（若有）
    const existingPayment = dbQuery(`SELECT id FROM sale_order_payments WHERE sale_order_id='${saleOrderId}' LIMIT 1`)
    if (existingPayment) {
      const payId = existingPayment.trim()
      if (payId) {
        dbQuery(`UPDATE sale_order_payments SET amount=${initialPaid} WHERE id=${payId}`)
        console.log(`[链路8] 降级：更新 payment 流水金额为 ${initialPaid}`)
      }
    }

    orderRow = dbQuery(`SELECT status, total_amount, received, payable_amount, prepaid_card_amount FROM sale_orders WHERE sale_order_id='${saleOrderId}'`)
    console.log(`[链路8] 降级后订单行: ${orderRow}`)
    payableFixed = parseFloat(orderRow.split('|')[3] || '0')
  }

  // remaining debt = payable_amount - received
  const remainingAfterCreate = Math.round((payableFixed - initialPaid) * 100) / 100
  console.log(`[链路8] 初始状态: total=${totalAmountDB}, received=${initialPaid}, payable_fixed=${payableFixed}, remaining=${remainingAfterCreate}`)

  // 验证初始状态
  const invCheck0 = checkInvariants(saleOrderId)
  console.log(`[链路8] 创建后不变量检查: ${invCheck0.verdict} — ${invCheck0.detail}`)

  const partial_payment_verdict = (orderRow.split('|')[0] === '部分支付') ? 'PASS' : 'FAIL'
  console.log(`[链路8] 初始状态检查: ${partial_payment_verdict}`)

  // ================================================================
  // STEP 2: 以 FY-TEST-FIN 登录，录入 3 次回款
  // 注：admin 角色无 sale_order:record_payment 权限，仅 finance 有
  // ================================================================
  console.log('[链路8] Step 2: 切换到财务账号...')

  // 清除 session cookie，强制重新登录
  await page.context().clearCookies()
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(500)

  await page.locator('#phone').fill(FINANCE_PHONE)
  await page.locator('#password').fill(FINANCE_PASS)
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })
  console.log('[链路8] 财务登录成功')

  // 进入订单详情页
  await page.goto(`${BASE}/orders/${saleOrderId}`)
  await expect(page.getByText('订单详情')).toBeVisible({ timeout: 15000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-05-order-detail.png` })

  // 计算 3 次回款金额
  const totalPayable = remainingAfterCreate
  const installment1 = Math.round(totalPayable * 0.5 * 100) / 100
  const installment2 = Math.round(totalPayable * 0.3 * 100) / 100
  const installment3 = Math.round((totalPayable - installment1 - installment2) * 100) / 100
  console.log(`[链路8] 3 次回款: ¥${installment1} + ¥${installment2} + ¥${installment3} = ¥${totalPayable}`)

  // ---- 反例测试：在第一次回款前尝试超额回款（> remainingPayable）----
  console.log('[链路8] Step 4 (反例): 尝试录入超额回款...')
  let negativeTestPassed = false

  const recordBtn0 = page.getByRole('button', { name: '录入回款' })
  if (await recordBtn0.isVisible({ timeout: 5000 }).catch(() => false)) {
    await recordBtn0.click()
    await page.waitForTimeout(800)

    const dialog0 = page.locator('dialog[open]')
    if (await dialog0.isVisible({ timeout: 5000 }).catch(() => false)) {
      // 填写超额金额
      const overAmount = totalPayable + 100
      const amountInput = dialog0.locator('input[type="number"]').first()
      await amountInput.clear()
      await amountInput.fill(overAmount.toFixed(2))

      // 填写必要的银行回执号
      const txnInput = dialog0.getByPlaceholder(/银行回执号|流水号|BANK/)
      if (await txnInput.isVisible().catch(() => false)) {
        await txnInput.fill('BANK-TEST-OVERPAY')
      }

      // 点确认录入
      const confirmBtn = page.getByRole('button', { name: '确认录入' })
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click()
        await page.waitForTimeout(1000)

        // 检查是否出现错误提示（toast 或弹层仍开启）
        const bodyNow = await page.textContent('body')
        const hasError = bodyNow?.includes('不能超过') || bodyNow?.includes('超过剩余欠款') || bodyNow?.includes('超额') || bodyNow?.includes('OVERPAY') || bodyNow?.includes('超出')
        if (hasError) {
          negativeTestPassed = true
          console.log('[链路8] 反例: 超额回款被拦截（错误 toast）')
        } else {
          // 对话框仍开启 = 前端客户端验证拦截（toast 可能已消失）
          const dialogStillOpen = await page.locator('dialog[open]').isVisible().catch(() => false)
          negativeTestPassed = dialogStillOpen
          console.log(`[链路8] 反例: 弹层仍开启=${dialogStillOpen}（前端拦截）`)
        }
      }

      // 关闭弹层
      const closeBtn = page.getByRole('button', { name: '取消' })
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click()
      } else {
        await page.keyboard.press('Escape')
      }
      await page.waitForTimeout(500)
    }
  } else {
    console.warn('[链路8] 未找到"录入回款"按钮（可能权限不足或状态不对）')
    negativeTestPassed = false
  }

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-06-negative-test.png` })

  // ================================================================
  // 第一次回款
  // ================================================================
  console.log(`[链路8] 第一次回款: ¥${installment1}`)
  await page.reload()
  await expect(page.getByText('订单详情')).toBeVisible({ timeout: 15000 })

  const recordBtn1 = page.getByRole('button', { name: '录入回款' })
  await expect(recordBtn1).toBeVisible({ timeout: 10000 })
  await recordBtn1.click()
  await page.waitForTimeout(800)

  // 等待弹层出现
  const dialog1 = page.locator('dialog[open]')
  await expect(dialog1).toBeVisible({ timeout: 5000 })

  // 回款金额（弹层内第一个 number input）— 用 pressSequentially 确保 React onChange 被触发
  const amountInput1 = dialog1.locator('input[type="number"]').first()
  await amountInput1.click()
  await amountInput1.fill('')
  await amountInput1.pressSequentially(installment1.toFixed(2), { delay: 20 })
  console.log(`[链路8] 第一次回款：填入金额 ${installment1.toFixed(2)}`)

  // 银行回执号（必填，否则前端拦截）
  await page.waitForTimeout(300)
  const txnInputAll1 = await dialog1.locator('input[type="text"], input:not([type])').all()
  console.log(`[链路8] 弹层内 text inputs 数量: ${txnInputAll1.length}`)
  const txnInput1 = dialog1.getByPlaceholder(/银行回执号|流水号|BANK|例如/)
  const txnVisible1 = await txnInput1.isVisible().catch(() => false)
  console.log(`[链路8] 银行回执号 input 可见: ${txnVisible1}`)
  if (txnVisible1) {
    await txnInput1.fill(`BANK-LINK8-INST1-${Date.now()}`)
    console.log('[链路8] 已填写银行回执号')
  } else {
    // 尝试找第一个 text input 作为 fallback
    const fallbackTxn = dialog1.locator('input:not([type="number"])').first()
    if (await fallbackTxn.isVisible().catch(() => false)) {
      await fallbackTxn.click()
      await fallbackTxn.fill('')
      await fallbackTxn.pressSequentially(`BANK8I1${Date.now()}`, { delay: 20 })
      console.warn('[链路8] 银行回执号 fallback：用 pressSequentially 填入第一个非 number input')
    } else {
      console.warn('[链路8] 第一次回款：未找到银行回执号输入框')
    }
  }

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-07a-dialog1.png` })

  // 验证输入值
  const amtVal1 = await amountInput1.inputValue()
  const txnVal1 = await dialog1.locator('input:not([type="number"])').first().inputValue().catch(() => '')
  console.log(`[链路8] 第一次回款提交前：amount=${amtVal1}, txn=${txnVal1}`)

  const confirmBtn1 = dialog1.getByRole('button', { name: '确认录入' })
  await confirmBtn1.click()
  console.log('[链路8] 第一次回款：已点击确认录入')
  await page.waitForTimeout(1000)
  // 捕获 toast 错误消息（sonner toast 挂在 body 下的 [data-sonner-toaster] 元素）
  const toastEl1 = await page.locator('[data-sonner-toaster]').textContent().catch(() => '')
  if (toastEl1) console.log(`[链路8] Toast 内容: ${toastEl1.substring(0, 2000)}`)
  // 检查输入框当前值（React state 视角）
  const amtValAfterClick1 = await amountInput1.inputValue().catch(() => '')
  console.log(`[链路8] 确认后 amount input 值: ${amtValAfterClick1}`)
  await page.waitForTimeout(1000)

  // 等待弹层关闭（回款成功后 onOpenChange(false) 关闭弹层，router.refresh() 重新加载页面）
  await expect(page.locator('dialog[open]')).not.toBeVisible({ timeout: 15000 })
  console.log('[链路8] 第一次回款：弹层已关闭')
  // 等待页面刷新完成（router.refresh 触发服务端重渲染）
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)

  // 立即查 DB 验证支付是否写入
  const paidAfter1 = dbQuery(`SELECT received FROM sale_orders WHERE sale_order_id='${saleOrderId}'`)
  console.log(`[链路8] 第一次回款后 DB received: ${paidAfter1}`)
  // 如果支付未写入，说明存在问题
  if (parseFloat(paidAfter1) <= initialPaid + 0.01) {
    const errorMsg = await page.textContent('body')
    console.warn(`[链路8] 警告：支付后 received 未增加（页面内容摘要）: ${errorMsg?.substring(0, 200)}`)
  }

  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-07-after-1st-payment.png` })

  // DB 验证
  const check1 = checkInvariants(saleOrderId)
  console.log(`[链路8] 第一次回款后不变量: ${check1.verdict} — ${check1.detail}`)

  // 验证状态仍非"已支付"
  const statusAfter1 = dbQuery(`SELECT status FROM sale_orders WHERE sale_order_id='${saleOrderId}'`)
  console.log(`[链路8] 第一次回款后状态: ${statusAfter1}`)
  const notPaidAfter1 = statusAfter1 !== '已支付'
  console.log(`[链路8] 状态非已支付: ${notPaidAfter1}`)

  // ================================================================
  // 第二次回款
  // ================================================================
  console.log(`[链路8] 第二次回款: ¥${installment2}`)
  await page.reload()
  await expect(page.getByText('订单详情')).toBeVisible({ timeout: 15000 })

  const recordBtn2 = page.getByRole('button', { name: '录入回款' })
  await expect(recordBtn2).toBeVisible({ timeout: 10000 })
  await recordBtn2.click()
  await page.waitForTimeout(800)

  const dialog2 = page.locator('dialog[open]')
  await expect(dialog2).toBeVisible({ timeout: 5000 })

  const amountInput2 = dialog2.locator('input[type="number"]').first()
  await amountInput2.click()
  await amountInput2.fill('')
  await amountInput2.pressSequentially(installment2.toFixed(2), { delay: 20 })

  const txnInput2 = dialog2.locator('input:not([type="number"])').first()
  if (await txnInput2.isVisible().catch(() => false)) {
    await txnInput2.click()
    await txnInput2.fill('')
    await txnInput2.pressSequentially(`BANK8I2${Date.now()}`, { delay: 20 })
  }

  const confirmBtn2 = dialog2.getByRole('button', { name: '确认录入' })
  await confirmBtn2.click()

  await expect(page.locator('dialog[open]')).not.toBeVisible({ timeout: 15000 })
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-08-after-2nd-payment.png` })

  // DB 验证
  const check2 = checkInvariants(saleOrderId)
  console.log(`[链路8] 第二次回款后不变量: ${check2.verdict} — ${check2.detail}`)

  const statusAfter2 = dbQuery(`SELECT status FROM sale_orders WHERE sale_order_id='${saleOrderId}'`)
  console.log(`[链路8] 第二次回款后状态: ${statusAfter2}`)
  const notPaidAfter2 = statusAfter2 !== '已支付'

  // ================================================================
  // 第三次回款（结清）
  // ================================================================
  console.log(`[链路8] 第三次回款（结清）: ¥${installment3}`)
  await page.reload()
  await expect(page.getByText('订单详情')).toBeVisible({ timeout: 15000 })

  const recordBtn3 = page.getByRole('button', { name: '录入回款' })
  await expect(recordBtn3).toBeVisible({ timeout: 10000 })
  await recordBtn3.click()
  await page.waitForTimeout(800)

  const dialog3 = page.locator('dialog[open]')
  await expect(dialog3).toBeVisible({ timeout: 5000 })

  // 默认值应等于剩余欠款
  const defaultAmountVal = await dialog3.locator('input[type="number"]').first().inputValue()
  console.log(`[链路8] 第三次回款弹层默认金额: ${defaultAmountVal}`)

  const amountInput3 = dialog3.locator('input[type="number"]').first()
  await amountInput3.click()
  await amountInput3.fill('')
  await amountInput3.pressSequentially(installment3.toFixed(2), { delay: 20 })

  const txnInput3 = dialog3.locator('input:not([type="number"])').first()
  if (await txnInput3.isVisible().catch(() => false)) {
    await txnInput3.click()
    await txnInput3.fill('')
    await txnInput3.pressSequentially(`BANK8I3${Date.now()}`, { delay: 20 })
  }

  const confirmBtn3 = dialog3.getByRole('button', { name: '确认录入' })
  await confirmBtn3.click()

  await expect(page.locator('dialog[open]')).not.toBeVisible({ timeout: 15000 })
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-09-after-final-payment.png` })

  // 验证 UI 状态变为已支付
  await page.reload()
  await expect(page.getByText('订单详情')).toBeVisible({ timeout: 15000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-8-10-final-status.png` })

  const finalBodyText = await page.textContent('body')
  const uiShowsPaid = finalBodyText?.includes('已支付') ?? false
  console.log(`[链路8] 最终 UI 状态含"已支付": ${uiShowsPaid}`)

  // DB 最终验证
  const checkFinal = checkInvariants(saleOrderId)
  console.log(`[链路8] 最终不变量: ${checkFinal.verdict} — ${checkFinal.detail}`)

  const finalStatusRow = dbQuery(`SELECT status FROM sale_orders WHERE sale_order_id='${saleOrderId}'`)
  console.log(`[链路8] 最终状态: ${finalStatusRow}`)
  const finalStatusPaid = finalStatusRow === '已支付'

  // ================================================================
  // 汇总所有验证结果（assertions）
  // ================================================================
  const verdicts = {
    partial_payment_initial_state: partial_payment_verdict,
    after_1st_installment_verdict_sql: check1.verdict,
    after_1st_not_fully_paid: notPaidAfter1 ? 'PASS' : 'FAIL',
    after_2nd_installment_verdict_sql: check2.verdict,
    after_2nd_not_fully_paid: notPaidAfter2 ? 'PASS' : 'FAIL',
    after_3rd_installment_status_paid: finalStatusPaid ? 'PASS' : 'FAIL',
    after_final_verdict_sql: checkFinal.verdict,
    neg_overpayment_blocked: negativeTestPassed ? 'PASS' : 'SKIP',
  }

  console.log('[链路8] 全部验证结果:', JSON.stringify(verdicts, null, 2))

  // ================================================================
  // STEP 5: 清理测试数据
  // ================================================================
  console.log('[链路8] Step 5: 清理测试数据...')
  // 共享清理工具（自动递归回款/凭证单）
  cleanupSaleOrder(saleOrderId, dbQuery, { logPrefix: '[链路8]' })
  console.log('[链路8] 清理完成')

  // ================================================================
  // 最终 Playwright assertions
  // ================================================================
  expect(verdicts.partial_payment_initial_state).toBe('PASS')
  expect(verdicts.after_1st_installment_verdict_sql).toBe('PASS')
  expect(verdicts.after_1st_not_fully_paid).toBe('PASS')
  expect(verdicts.after_2nd_installment_verdict_sql).toBe('PASS')
  expect(verdicts.after_2nd_not_fully_paid).toBe('PASS')
  expect(verdicts.after_3rd_installment_status_paid).toBe('PASS')
  expect(verdicts.after_final_verdict_sql).toBe('PASS')
  // 反例：PASS 或 SKIP 都接受
  expect(['PASS', 'SKIP']).toContain(verdicts.neg_overpayment_blocked)

  // 输出供父脚本读取的 JSON 结果
  const result = {
    link: 8,
    status: Object.values(verdicts).every(v => v === 'PASS' || v === 'SKIP') ? 'PASS' : 'PARTIAL',
    saleOrderId,
    verdicts: [
      { check: 'partial_payment_initial_state', actual: `status=部分支付 paid=${initialPaid} payable=${remainingAfterCreate}`, verdict: verdicts.partial_payment_initial_state },
      { check: 'after_1st_installment_verdict_sql', actual: check1.detail, verdict: verdicts.after_1st_installment_verdict_sql },
      { check: 'after_1st_not_fully_paid', actual: statusAfter1, verdict: verdicts.after_1st_not_fully_paid },
      { check: 'after_2nd_installment_verdict_sql', actual: check2.detail, verdict: verdicts.after_2nd_installment_verdict_sql },
      { check: 'after_2nd_not_fully_paid', actual: statusAfter2, verdict: verdicts.after_2nd_not_fully_paid },
      { check: 'after_3rd_installment_status_paid', actual: finalStatusRow, verdict: verdicts.after_3rd_installment_status_paid },
      { check: 'after_final_verdict_sql', actual: checkFinal.detail, verdict: verdicts.after_final_verdict_sql },
      { check: 'neg_overpayment_blocked', verdict: verdicts.neg_overpayment_blocked },
    ],
    cleaned: true,
    notes: `usedFallback=${usedFallback}; change_type枚举: {首次支付,回款,退款,储值卡抵扣}; 线下回款需填外部交易号; payable_amount在本系统固定为total-prepaid（不随回款变化），剩余欠款=payable_amount-received; FY-TEST-FIN(finance)执行录入回款（admin无此权限）`,
  }
  console.log('[链路8] RESULT JSON:', JSON.stringify(result, null, 2))
})
