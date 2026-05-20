/**
 * 链路 46：admin 开单 — 线下部分支付 + 多次回款 + paid_sessions 逐行进阶
 *
 * 主题：验证"在 admin 开单页把某行 sale_item 实付金额下调，订单提交后立即落
 *       status='部分支付'、写首次支付 payments 行"的端到端流程，再通过订单详情
 *       页的"录入回款"两次补齐尾款，期间 sale_items.paid_sessions 按逐行公式
 *       floor(min(1, received / sale_amount) * session_count) 进阶。
 *
 * 角色：FY-TEST-MGR
 * Fixture 顾客：FY-FIX-CLIENT-01（手机 13800138000）
 *
 * SKU：动态发现一张 session_count=2 + 启用 + 非体验 + 非删除的 2 次疗程卡。
 *       目前 5434 fixture 库存在 4 张（520一生一世卡 / 皱纹管家 / 剥离除皱 /
 *       抗衰仪器），按 price ASC 取最便宜的一张以最小化 e2e 金额波动。
 *
 * 实付分布（按 SKU 单价动态计算，下面以 ¥52 卡为例的 share）：
 *   first  = round(price / 2)        ← Step 3 下调实付（floor(1/2 * 2) = 1）
 *   repay1 = round(price / 4)        ← 第 1 笔回款（仍处 paid=1，不应进阶）
 *   repay2 = price - first - repay1  ← 第 2 笔回款（凑齐到 price，paid 升至 2）
 *
 * 关键不变量（按 SKU 价格 P / 次数 N=2 表达）：
 *   Step 3 提交后:
 *     sale_orders.status            = '部分支付'
 *     sale_orders.received          = first
 *     sale_orders.total_amount      = P
 *     sale_items.received           = first
 *     sale_items.paid_sessions      = floor(min(1, first/P) * 2) = 1
 *     sale_order_payments 存在 1 行 change_type='首次支付', amount=first, status='已支付'
 *   第 1 次回款后:
 *     sale_orders.status            = '部分支付'
 *     sale_orders.received          = first + repay1
 *     sale_items.paid_sessions      = 1（不进阶）
 *   第 2 次回款后:
 *     sale_orders.status            = '已支付'
 *     sale_orders.received          = P
 *     sale_items.paid_sessions      = 2
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

test('链路 46：admin 线下部分支付 + 多次回款 + paid_sessions 进阶', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[browser-error] ${m.text()}`)
  })
  page.on('pageerror', (err) => console.log(`[page-error] ${err.message}`))

  // ============================================================
  // Step 0: 动态发现 2 次疗程卡 SKU + 类目信息（用于 Step 2 侧边栏定位）
  // ============================================================
  const skuRow = psql(
    `SELECT ps.sku_id, ps.spec_name, ps.price, ps.category_id, pc.category_name ` +
      `FROM product_skus ps JOIN product_categories pc ON pc.category_id = ps.category_id ` +
      `WHERE ps.session_count = 2 AND ps.is_enabled = true AND ps.is_experience = false ` +
      `AND ps.deleted_at IS NULL AND pc.product_kind = '护理项目' ` +
      `ORDER BY ps.price ASC LIMIT 1`,
  )
  if (!skuRow) throw new Error('未在 5434 找到 session_count=2 的疗程卡 SKU；请检查 fixture 同步')
  const [SKU_ID, SKU_SPEC_NAME, SKU_PRICE_STR, SKU_CATEGORY_ID, SKU_CATEGORY_NAME] = skuRow.split('|')
  const SKU_PRICE = Number(SKU_PRICE_STR)
  if (!SKU_PRICE || SKU_PRICE < 4) throw new Error(`SKU 单价异常: ${SKU_PRICE_STR}`)

  // 实付分布：first=round(P/2), repay1=round(P/4)，repay2 凑齐
  const FIRST_RECEIVED = Math.round(SKU_PRICE / 2)
  const REPAY_1 = Math.round(SKU_PRICE / 4)
  const REPAY_2 = SKU_PRICE - FIRST_RECEIVED - REPAY_1
  const EXPECTED_PAID_SESSIONS_AFTER_FIRST = Math.floor(Math.min(1, FIRST_RECEIVED / SKU_PRICE) * 2)
  const EXPECTED_PAID_SESSIONS_AFTER_REPAY1 = Math.floor(
    Math.min(1, (FIRST_RECEIVED + REPAY_1) / SKU_PRICE) * 2,
  )

  console.log(
    `[链路46] Step0 SKU=${SKU_ID} (${SKU_SPEC_NAME}) ` +
      `price=${SKU_PRICE} first=${FIRST_RECEIVED} repay1=${REPAY_1} repay2=${REPAY_2} ` +
      `paid_after_first=${EXPECTED_PAID_SESSIONS_AFTER_FIRST}`,
  )
  expect(EXPECTED_PAID_SESSIONS_AFTER_FIRST).toBe(1)
  expect(REPAY_2).toBeGreaterThan(0)

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
  console.log('[链路46] 登录成功')

  // ============================================================
  // Step 1: 开单页 — 选普通商品 + 顾客
  // ============================================================
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  // productKindChoice 默认就是"普通商品"，但显式点一次确保选中态
  const normalKindBtn = page.getByRole('button', { name: '普通商品', exact: true })
  await expect(normalKindBtn).toBeVisible({ timeout: 5000 })
  await normalKindBtn.click()
  await expect(normalKindBtn).toHaveAttribute('aria-pressed', 'true')

  // 搜索顾客
  await page.getByPlaceholder('输入姓名或手机号搜索').fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(
    () => (document.body.textContent || '').includes('找到'),
    { timeout: 15000 },
  )
  // 点搜索结果第一条
  await page.locator('div.space-y-1 > button').first().click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })

  await page.getByRole('button', { name: '下一步' }).click()

  // ============================================================
  // Step 2: 选择 SKU（侧边栏点 categoryName → 右侧网格找 SKU → 点"加入"）
  // ============================================================
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-46-01-step2.png` })

  // 侧边栏按 categoryName 点击（左侧是 group=productKind 不可点 + 子项=category 可点）
  const categoryBtn = page.locator('button', { hasText: SKU_CATEGORY_NAME }).first()
  await expect(categoryBtn).toBeVisible({ timeout: 10000 })
  await categoryBtn.click()
  await page.waitForTimeout(500)

  // 右侧网格找 SKU 卡片（按 spec_name 锚定，定位到包含"加入"按钮的最近卡片祖先）
  const skuHeading = page.locator('h4', { hasText: SKU_SPEC_NAME }).first()
  await expect(skuHeading).toBeVisible({ timeout: 10000 })
  const addSkuBtn = skuHeading
    .locator('xpath=ancestor::*[.//button[normalize-space()="加入"]][1]')
    .getByRole('button', { name: '加入' })
    .first()
  await expect(addSkuBtn).toBeVisible({ timeout: 5000 })
  await addSkuBtn.click()
  console.log(`[链路46] Step2 加入 SKU=${SKU_ID} ✓`)

  // 进入 Step 3
  await page.getByRole('button', { name: '下一步' }).click()

  // ============================================================
  // Step 3: 选线下支付 + 下调实付金额 → 提交
  // ============================================================
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({
    timeout: 10000,
  })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-46-02-step3-default.png` })

  // 默认支付方式是"微信支付"，改成"线下支付"
  const paySelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
  await paySelect.selectOption({ label: '线下支付' })

  // 下调"实付金额"input —— 商品清单行的最右侧 number input（表头列名"实付金额"）
  // 实付金额 input 在 col-span-2 容器里，是唯一可编辑（非 disabled）的 number input
  // 选择策略：filter type=number 且非 disabled，min=0；首次只有一行
  const receivedInput = page.locator('input[type="number"]:not([disabled])').first()
  await expect(receivedInput).toBeVisible({ timeout: 5000 })
  await receivedInput.click()
  await receivedInput.fill('')
  await receivedInput.fill(FIRST_RECEIVED.toFixed(2))
  await page.waitForTimeout(300)

  // 校验汇总区显示"实付合计"
  await expect(page.getByText(`实付合计: ¥${FIRST_RECEIVED.toFixed(2)}`)).toBeVisible({ timeout: 5000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-46-03-step3-lowered.png` })

  // 提交
  await page.getByRole('button', { name: /提交订单/ }).click()

  // 等 Step 4 出现「已记录首次收款」标题
  await expect(page.getByRole('heading', { name: '已记录首次收款' })).toBeVisible({ timeout: 20000 })
  // 文案：本次已收 + 剩余
  await expect(
    page.getByText(new RegExp(`本次已收 ¥${FIRST_RECEIVED.toFixed(2)}`)),
  ).toBeVisible({ timeout: 5000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-46-04-step4.png` })

  // 部分支付分支不应出现"确认收款"按钮、不应出现二维码（无 OrderQRCode 标记）
  await expect(page.getByRole('button', { name: '确认收款' })).toHaveCount(0)

  // 提取订单号
  const bodyText = (await page.textContent('body')) || ''
  const m = bodyText.match(/FY-XSD-WX-\d{10}/)
  if (!m) throw new Error('未能从 Step 4 抓到 sale_order_id')
  const saleOrderId = m[0]
  console.log(`[链路46] Step3 saleOrderId=${saleOrderId} ✓`)

  // ============================================================
  // DB 验证：创建后状态
  // ============================================================
  const verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL'; actual: string }> = []

  const orderRow = psql(
    `SELECT status, received, total_amount FROM sale_orders WHERE sale_order_id='${saleOrderId}'`,
  )
  const [oStatus, oReceived, oTotal] = orderRow.split('|')
  verdicts.push({
    check: '创建后 sale_orders.status = 部分支付',
    verdict: oStatus === '部分支付' ? 'PASS' : 'FAIL',
    actual: oStatus,
  })
  verdicts.push({
    check: `创建后 sale_orders.received = ${FIRST_RECEIVED.toFixed(2)}`,
    verdict: Number(oReceived) === FIRST_RECEIVED ? 'PASS' : 'FAIL',
    actual: oReceived,
  })
  verdicts.push({
    check: `创建后 sale_orders.total_amount = ${SKU_PRICE.toFixed(2)}`,
    verdict: Number(oTotal) === SKU_PRICE ? 'PASS' : 'FAIL',
    actual: oTotal,
  })

  const itemRow = psql(
    `SELECT received, COALESCE(paid_sessions, -1), session_count, sale_amount FROM sale_items ` +
      `WHERE sale_order_id='${saleOrderId}'`,
  )
  const [iReceived, iPaidSessions, iSessionCount, iSaleAmount] = itemRow.split('|')
  verdicts.push({
    check: `创建后 sale_items.received = ${FIRST_RECEIVED.toFixed(2)}`,
    verdict: Number(iReceived) === FIRST_RECEIVED ? 'PASS' : 'FAIL',
    actual: iReceived,
  })
  verdicts.push({
    check: `创建后 sale_items.session_count = 2`,
    verdict: Number(iSessionCount) === 2 ? 'PASS' : 'FAIL',
    actual: iSessionCount,
  })
  verdicts.push({
    check: `创建后 sale_items.paid_sessions = ${EXPECTED_PAID_SESSIONS_AFTER_FIRST}（floor(${FIRST_RECEIVED}/${SKU_PRICE} × 2)）`,
    verdict: Number(iPaidSessions) === EXPECTED_PAID_SESSIONS_AFTER_FIRST ? 'PASS' : 'FAIL',
    actual: iPaidSessions,
  })
  verdicts.push({
    check: `创建后 sale_items.sale_amount = ${SKU_PRICE.toFixed(2)}`,
    verdict: Number(iSaleAmount) === SKU_PRICE ? 'PASS' : 'FAIL',
    actual: iSaleAmount,
  })

  // sale_order_payments：仅 1 行首次支付，amount=first，status=已支付
  const firstPayRow = psql(
    `SELECT change_type, status, amount FROM sale_order_payments ` +
      `WHERE sale_order_id='${saleOrderId}' AND change_type='首次支付'`,
  )
  const [fpType, fpStatus, fpAmount] = firstPayRow.split('|')
  verdicts.push({
    check: '创建后 sale_order_payments 存在首次支付行（已支付）',
    verdict: fpType === '首次支付' && fpStatus === '已支付' ? 'PASS' : 'FAIL',
    actual: `change_type=${fpType} status=${fpStatus}`,
  })
  verdicts.push({
    check: `创建后 首次支付.amount = ${FIRST_RECEIVED.toFixed(2)}`,
    verdict: Number(fpAmount) === FIRST_RECEIVED ? 'PASS' : 'FAIL',
    actual: fpAmount,
  })

  // ============================================================
  // Step 4: 第 1 次回款 — 跳订单详情页 → 录入回款 ¥repay1
  // ============================================================
  console.log(`[链路46] Step4 第 1 次回款 ¥${REPAY_1}...`)
  await page.goto(`${BASE}/orders/${saleOrderId}`)
  await page.waitForLoadState('networkidle')

  // 点"录入回款"按钮
  await page.getByRole('button', { name: '录入回款' }).first().click()
  // 弹层标题
  await expect(page.getByText('录入回款', { exact: true }).first()).toBeVisible({ timeout: 5000 })

  // 回款金额 input（类型 number，弹层内第一个 number input；default = 剩余欠款）
  const repayAmountInput = page
    .locator('input[type="number"]:not([disabled])')
    .first()
  await repayAmountInput.click()
  await repayAmountInput.fill('')
  await repayAmountInput.fill(REPAY_1.toFixed(2))

  // 线下回款需填外部交易号
  await page.getByPlaceholder(/BANK-/).fill(`E2E-LINK46-REPAY1-${Date.now()}`)

  await page.getByRole('button', { name: '确认录入' }).click()
  // 等弹窗关闭 + 详情页 refresh
  await page.waitForFunction(
    () => !document.body.textContent?.includes('储值卡抵扣金额（可选）'),
    { timeout: 15000 },
  )
  await page.waitForTimeout(1500)

  // DB 验证：第 1 次回款后仍为部分支付，paid_sessions 不进阶
  let row1 = ''
  for (let i = 0; i < 20; i++) {
    row1 = psql(
      `SELECT so.status, so.received, COALESCE(si.paid_sessions, -1) ` +
        `FROM sale_orders so JOIN sale_items si ON si.sale_order_id=so.sale_order_id ` +
        `WHERE so.sale_order_id='${saleOrderId}'`,
    )
    const [, rcv] = row1.split('|')
    if (Number(rcv) >= FIRST_RECEIVED + REPAY_1 - 0.005) break
    await page.waitForTimeout(500)
  }
  const [r1Status, r1Received, r1Paid] = row1.split('|')
  verdicts.push({
    check: '第 1 次回款后 sale_orders.status = 部分支付',
    verdict: r1Status === '部分支付' ? 'PASS' : 'FAIL',
    actual: r1Status,
  })
  verdicts.push({
    check: `第 1 次回款后 sale_orders.received = ${(FIRST_RECEIVED + REPAY_1).toFixed(2)}`,
    verdict: Math.abs(Number(r1Received) - (FIRST_RECEIVED + REPAY_1)) < 0.005 ? 'PASS' : 'FAIL',
    actual: r1Received,
  })
  verdicts.push({
    check: `第 1 次回款后 sale_items.paid_sessions = ${EXPECTED_PAID_SESSIONS_AFTER_REPAY1}（未跨阈值，不进阶）`,
    verdict: Number(r1Paid) === EXPECTED_PAID_SESSIONS_AFTER_REPAY1 ? 'PASS' : 'FAIL',
    actual: r1Paid,
  })

  // ============================================================
  // Step 5: 第 2 次回款 — 凑齐到 SKU 单价
  // ============================================================
  console.log(`[链路46] Step5 第 2 次回款 ¥${REPAY_2}...`)
  await page.getByRole('button', { name: '录入回款' }).first().click()
  await expect(page.getByText('录入回款', { exact: true }).first()).toBeVisible({ timeout: 5000 })

  const repayAmountInput2 = page
    .locator('input[type="number"]:not([disabled])')
    .first()
  await repayAmountInput2.click()
  await repayAmountInput2.fill('')
  await repayAmountInput2.fill(REPAY_2.toFixed(2))

  await page.getByPlaceholder(/BANK-/).fill(`E2E-LINK46-REPAY2-${Date.now()}`)

  await page.getByRole('button', { name: '确认录入' }).click()
  await page.waitForFunction(
    () => !document.body.textContent?.includes('储值卡抵扣金额（可选）'),
    { timeout: 15000 },
  )
  await page.waitForTimeout(1500)

  // DB 验证：第 2 次回款后 status=已支付，paid_sessions=2
  let row2 = ''
  for (let i = 0; i < 20; i++) {
    row2 = psql(
      `SELECT so.status, so.received, COALESCE(si.paid_sessions, -1) ` +
        `FROM sale_orders so JOIN sale_items si ON si.sale_order_id=so.sale_order_id ` +
        `WHERE so.sale_order_id='${saleOrderId}'`,
    )
    const [, , ps] = row2.split('|')
    if (Number(ps) === 2) break
    await page.waitForTimeout(500)
  }
  const [r2Status, r2Received, r2Paid] = row2.split('|')
  verdicts.push({
    check: '第 2 次回款后 sale_orders.status = 已支付',
    verdict: r2Status === '已支付' ? 'PASS' : 'FAIL',
    actual: r2Status,
  })
  verdicts.push({
    check: `第 2 次回款后 sale_orders.received = ${SKU_PRICE.toFixed(2)}`,
    verdict: Math.abs(Number(r2Received) - SKU_PRICE) < 0.005 ? 'PASS' : 'FAIL',
    actual: r2Received,
  })
  verdicts.push({
    check: '第 2 次回款后 sale_items.paid_sessions = 2',
    verdict: Number(r2Paid) === 2 ? 'PASS' : 'FAIL',
    actual: r2Paid,
  })

  // ============================================================
  // 汇总 + 清理
  // ============================================================
  console.log('\n=== 链路 46 验证 ===')
  for (const v of verdicts) console.log(`  [${v.verdict}] ${v.check} — 实际: ${v.actual}`)
  const failed = verdicts.filter((v) => v.verdict === 'FAIL')

  writeContext({
    link46: {
      saleOrderId,
      skuId: SKU_ID,
      skuPrice: SKU_PRICE,
      firstReceived: FIRST_RECEIVED,
      repay1: REPAY_1,
      repay2: REPAY_2,
      verdicts: verdicts.length,
      failed: failed.length,
      status: failed.length === 0 ? 'PASS' : 'FAIL',
      ranAt: new Date().toISOString(),
    },
  })

  cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路46]' })

  expect(failed, `失败项: ${failed.map((v) => v.check).join(', ')}`).toEqual([])
})
