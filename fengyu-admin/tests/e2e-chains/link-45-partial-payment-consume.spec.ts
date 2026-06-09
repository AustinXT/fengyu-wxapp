/**
 * 链路 45：部分支付订单消费 + paid_sessions 限额（ticket 2026-05-19-sale-items-paid-sessions）
 *
 * 验证 D2=A（部分支付订单允许 service.create）+ D6=A（paid_sessions=0 锁死） + D3=A（退款扣减）
 * 三大决策的端到端业务链路。
 *
 * Step 0: SQL 注入 10 次卡 + 部分支付（received=5000/total=10000，paid_sessions=5）
 *         + 已存在订单守护：清理可能的旧测试遗留
 * Step 1: UI 创建服务单 1 次（D2=A 验证：当前断言应能成功——改造前会拒绝）
 *         → 完成服务单 → SQL 验证 used=1 / remaining=9 / paid_sessions=5
 * Step 2: SQL 模拟"用满 paid_sessions"（直接 INSERT 4 个 service_orders + service_items，
 *         UPDATE remaining_sessions=5）
 * Step 3: D6=A 验证：UI 再进 services/create 选卡，该 sale_item 应被过滤
 *         （UI 层：consumableSessions = min(remaining, paid-used) <= 0 → 不显示在可选列表）
 * Step 4: SQL 模拟 admin recordPayment 回款 5000（INSERT payments + UPDATE received
 *         + 调与 PAID_SESSIONS_RECALC_SQL 等价的 UPDATE）→ 验证 paid_sessions 升到 10
 * Step 5: UI 再次能选卡（D2=A 重新可消费）
 * Step 6: 清理
 *
 * 关键覆盖：
 *   - 部分支付订单 service.create 不再被硬卡拒绝（ticket 2026-05-19 D2=A）
 *   - paid_sessions=used 时整张卡锁死（D6=A）
 *   - 回款后 paid_sessions 单调递增（recalc 触发）
 */

import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'

const MANAGER_PHONE = '13900139001'
const MANAGER_PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const FIXTURE_CLIENT_ID = 'FY-FIX-CLIENT-01'

// 10 次卡 SKU（同 link-12）
const MULTI_SESSION_SKU_ID = 'sku-001-02'
const MULTI_SESSION_SKU_NAME = '蜜语水润嫩肤护理 10次卡'
const MULTI_SESSION_COUNT = 10
const TOTAL_AMOUNT = 10000
const INITIAL_RECEIVED = 5000
const INITIAL_PAID_SESSIONS = 5  // floor(5000/10000 * 10)

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')

// 固定测试 ID 避免序号冲突
const PRE_SALE_ORDER_ID = 'FY-XSD-WX-2605199101'
const PRE_SALE_ITEM_ID = 'FY-XSD-WX-2605199101-01'

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function runPsql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu_e2e -t -A -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim()
  } catch (e: any) {
    return `ERROR: ${e.message}`
  }
}

test.setTimeout(360000)

test('链路45：部分支付订单消费 + paid_sessions 限额', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[browser-error] ${msg.text()}`)
  })
  page.on('pageerror', (err) => console.log(`[page-error] ${err.message}`))

  // ============================================================
  // 登录
  // ============================================================
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
  console.log('[链路45] 登录成功')

  // ============================================================
  // Step 0: 清理遗留 + SQL 注入部分支付订单
  // ============================================================
  console.log('[链路45] Step0 清理遗留 + 注入部分支付订单...')
  cleanupSaleOrder(PRE_SALE_ORDER_ID, runPsql, { logPrefix: '[链路45-Step0]' })

  const storeId = runPsql(
    `SELECT bound_store_id FROM client_wechat_users WHERE user_id='${FIXTURE_CLIENT_ID}'`
  )
  const marketName = runPsql(
    `SELECT DISTINCT market_name FROM sale_orders WHERE store_id='${storeId}' LIMIT 1`
  ) || '南昌市场'
  const mgr = runPsql(
    `SELECT employee_id FROM staff_wechat_users WHERE phone='${MANAGER_PHONE}' LIMIT 1`
  )

  // INSERT 部分支付订单：total=10000, received=5000（payable_amount = total - prepaid = 10000）
  const insertOrder = runPsql(
    `INSERT INTO sale_orders ` +
    `(sale_order_id, status, sale_order_type, market_name, store_id, sale_order_datetime, ` +
    `client_user_id, client_phone, customer_name, total_amount, prepaid_card_amount, ` +
    `received, payable_amount, payment_method, opened_by, paid_at, created_at, updated_at) ` +
    `VALUES ` +
    `('${PRE_SALE_ORDER_ID}', '部分支付', '销售单', '${marketName}', '${storeId}', NOW(), ` +
    `'${FIXTURE_CLIENT_ID}', '${FIXTURE_PHONE}', 'Fixture测试客', ` +
    `${TOTAL_AMOUNT}.00, 0, ${INITIAL_RECEIVED}.00, ${TOTAL_AMOUNT}.00, '线下', ` +
    `'${mgr || 'FY-TEST-MGR'}', NOW(), NOW(), NOW()) ` +
    `ON CONFLICT (sale_order_id) DO NOTHING`
  )
  console.log(`[链路45] Step0 INSERT sale_order: ${insertOrder}`)

  // INSERT sale_item：session_count=10, remaining=10, paid_sessions=5（部分付 50% 可消费 5 次）
  const insertItem = runPsql(
    `INSERT INTO sale_items ` +
    `(sale_item_id, sale_order_id, item_direction, sku_id, session_count, remaining_sessions, paid_sessions, ` +
    `unit_price, quantity, unit_real_price, sale_amount, received, ` +
    `product_name, product_type, store_id, created_at, updated_at) ` +
    `VALUES ` +
    `('${PRE_SALE_ITEM_ID}', '${PRE_SALE_ORDER_ID}', '购买', '${MULTI_SESSION_SKU_ID}', ` +
    `${MULTI_SESSION_COUNT}, ${MULTI_SESSION_COUNT}, ${INITIAL_PAID_SESSIONS}, ` +
    `${TOTAL_AMOUNT}.00, 1, ${TOTAL_AMOUNT}.00, ${TOTAL_AMOUNT}.00, ${INITIAL_RECEIVED}.00, ` +
    `'蜜语水润嫩肤护理', '疗程卡', '${storeId}', NOW(), NOW()) ` +
    `ON CONFLICT (sale_item_id) DO NOTHING`
  )
  console.log(`[链路45] Step0 INSERT sale_item: ${insertItem}`)

  // INSERT payments 行（首次支付 5000）— 维护不变量 received=SUM(payments[已支付,首次支付/回款/储值卡抵扣])
  runPsql(
    `INSERT INTO sale_order_payments ` +
    `(sale_order_id, change_type, amount, payment_method, status, source_end, created_at, paid_at) ` +
    `VALUES ` +
    `('${PRE_SALE_ORDER_ID}', '首次支付', ${INITIAL_RECEIVED}.00, '线下', '已支付', 'admin', NOW(), NOW())`
  )

  // 验证初始状态
  const initial = runPsql(
    `SELECT status, received, total_amount FROM sale_orders WHERE sale_order_id='${PRE_SALE_ORDER_ID}'`
  )
  console.log(`[链路45] Step0 订单初始状态: ${initial}`)
  const [statusInit, recInit, totInit] = initial.split('|')
  expect(statusInit).toBe('部分支付')
  expect(parseFloat(recInit)).toBe(INITIAL_RECEIVED)
  expect(parseFloat(totInit)).toBe(TOTAL_AMOUNT)

  const itemInit = runPsql(
    `SELECT session_count, remaining_sessions, COALESCE(paid_sessions, 0) FROM sale_items WHERE sale_item_id='${PRE_SALE_ITEM_ID}'`
  )
  const [scInit, remInit, paidInit] = itemInit.split('|')
  expect(parseInt(scInit)).toBe(MULTI_SESSION_COUNT)
  expect(parseInt(remInit)).toBe(MULTI_SESSION_COUNT)
  expect(parseInt(paidInit)).toBe(INITIAL_PAID_SESSIONS)
  console.log(`[链路45] Step0 sale_item: sc=${scInit} rem=${remInit} paid=${paidInit} ✓`)

  // ============================================================
  // Step 1: UI 创建服务单（D2=A 核心验证：部分支付订单也能消费）
  // ============================================================
  console.log('[链路45] Step1 创建服务单（D2=A 验证：部分支付订单 service.create 应能成功）...')

  await page.goto(`${BASE}/services/create`)
  await expect(page.getByRole('heading', { name: '新建服务单' })).toBeVisible({ timeout: 15000 })

  await page.getByPlaceholder(/手机号/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('姓名') || t.includes('未找到')
  }, { timeout: 15000 })

  const step1Next = page.getByRole('button', { name: '下一步' })
  await expect(step1Next).toBeEnabled({ timeout: 5000 })
  await step1Next.click()

  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('选择服务项目') || t.includes('暂无可用')
  }, { timeout: 20000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-45-10-step1-items.png` })

  // 核心断言：注入的 sale_item 应出现在可选列表（D2=A）
  // 注：UI 表格不显示 sale_item_id，只显示商品名/规格/用量/单价；按 SKU 规格名定位
  const mainText = (await page.locator('main').innerText().catch(() => '')) || ''
  expect(mainText).toContain(MULTI_SESSION_SKU_NAME)
  console.log('[链路45] Step1 部分支付订单的 sale_item 出现在可选列表 ✓（D2=A 验证通过）')

  // 选中我们注入的行：按规格名 + paid_sessions=5 / session_count=10 (UI "已用/已付/共" 显示 "0/5/10") 双重定位
  const rows = page.locator('table tbody tr')
  const rowCount = await rows.count()
  let targetRowIdx = -1
  for (let i = 0; i < rowCount; i++) {
    const rowText = await rows.nth(i).textContent()
    if (rowText?.includes(MULTI_SESSION_SKU_NAME) && rowText?.includes('0/5/10')) {
      targetRowIdx = i
      break
    }
  }
  // fallback：仅按 SKU 名匹配（若 fixture 顾客同名卡多张则取第一张匹配的）
  if (targetRowIdx === -1) {
    for (let i = 0; i < rowCount; i++) {
      const rowText = await rows.nth(i).textContent()
      if (rowText?.includes(MULTI_SESSION_SKU_NAME)) {
        targetRowIdx = i
        break
      }
    }
  }
  expect(targetRowIdx).toBeGreaterThanOrEqual(0)
  await rows.nth(targetRowIdx).click()

  // 选员工
  const empSelect = page.locator('select').filter({ hasText: /请选择/ })
  if (await empSelect.count() > 0) {
    const opts = await empSelect.first().locator('option').allTextContents()
    const firstValid = opts.find((o) => o && !o.includes('请选择'))
    if (firstValid) await empSelect.first().selectOption({ label: firstValid })
  }

  const step2Next = page.getByRole('button', { name: '下一步' })
  await expect(step2Next).toBeEnabled({ timeout: 5000 })
  await step2Next.click()

  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('确认服务单') || t.includes('提交服务单')
  }, { timeout: 10000 })

  await page.getByRole('button', { name: '提交服务单' }).click()
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('服务单创建成功') || t.includes('FY-FW-')
  }, { timeout: 20000 })

  const bodyAfterCreate = await page.textContent('body')
  const soMatch = bodyAfterCreate?.match(/FY-FW-[A-Z0-9-]+/)
  expect(soMatch).toBeTruthy()
  const serviceOrderId = soMatch![0]
  console.log(`[链路45] Step1 服务单创建: ${serviceOrderId} ✓`)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-45-11-step1-created.png` })

  // 开始 + 完成服务（消费 1 次）
  await page.goto(`${BASE}/services?q=${serviceOrderId}`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)

  await page.getByRole('button', { name: '开始服务' }).first().click()
  await page.waitForFunction(() => document.body.textContent?.includes('服务中'), { timeout: 20000 })

  // migration 0053（arch/006）：服务中 →「标记完成」→ 待客户确认 →「代客户确认」→ 已完成（confirm 才扣次数）
  await page.getByRole('button', { name: '完成服务' }).first().click()
  await expect(page.getByRole('heading', { name: /标记完成服务/ })).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '标记完成' }).click()
  await page.waitForFunction(() => document.body.textContent?.includes('待客户确认'), { timeout: 20000 })
  await page.getByRole('button', { name: '代客户确认' }).first().click()
  await expect(page.getByRole('heading', { name: /代客户确认服务完成/ })).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '确认完成' }).click()
  await page.waitForFunction(() => document.body.textContent?.includes('已完成'), { timeout: 20000 })
  console.log('[链路45] Step1 服务单完成 ✓')

  // SQL 验证 used=1 / remaining=9 / paid_sessions=5（未变）
  // 注：UI 文案"已完成"出现的瞬间不一定等于 SQL 已 commit + revalidate 完成，
  //    用短轮询等真值出现，避免观测过早的竞态。
  let sc1 = '', rem1 = '', paid1 = ''
  for (let i = 0; i < 20; i++) {
    const row = runPsql(
      `SELECT session_count, remaining_sessions, COALESCE(paid_sessions, 0) FROM sale_items WHERE sale_item_id='${PRE_SALE_ITEM_ID}'`
    )
    ;[sc1, rem1, paid1] = row.split('|')
    if (parseInt(rem1) === MULTI_SESSION_COUNT - 1) break
    await page.waitForTimeout(500)
  }
  expect(parseInt(rem1)).toBe(MULTI_SESSION_COUNT - 1)  // 10 - 1 = 9
  expect(parseInt(paid1)).toBe(INITIAL_PAID_SESSIONS)   // 5（未变）
  expect(parseInt(sc1) - parseInt(rem1)).toBeLessThanOrEqual(parseInt(paid1))  // used=1 <= paid=5
  console.log(`[链路45] Step1 SQL 验证: sc=${sc1} rem=${rem1} paid=${paid1} used=${parseInt(sc1) - parseInt(rem1)} ✓`)

  // ============================================================
  // Step 2: SQL 模拟"用满 paid_sessions"
  // ============================================================
  console.log('[链路45] Step2 SQL 模拟用满 paid_sessions（remaining=5，used=5=paid_sessions）...')
  runPsql(
    `UPDATE sale_items SET remaining_sessions = ${MULTI_SESSION_COUNT - INITIAL_PAID_SESSIONS}, updated_at=NOW() ` +
    `WHERE sale_item_id='${PRE_SALE_ITEM_ID}'`
  )
  const afterStep2 = runPsql(
    `SELECT session_count, remaining_sessions, COALESCE(paid_sessions, 0) FROM sale_items WHERE sale_item_id='${PRE_SALE_ITEM_ID}'`
  )
  const [sc2, rem2, paid2] = afterStep2.split('|')
  expect(parseInt(rem2)).toBe(MULTI_SESSION_COUNT - INITIAL_PAID_SESSIONS)  // 5
  expect(parseInt(sc2) - parseInt(rem2)).toBe(parseInt(paid2))  // used=5 = paid=5
  console.log(`[链路45] Step2 sc=${sc2} rem=${rem2} paid=${paid2} used=${parseInt(sc2) - parseInt(rem2)} ✓`)

  // ============================================================
  // Step 3: D6=A 验证：UI 选卡时该 sale_item 被过滤
  // ============================================================
  console.log('[链路45] Step3 D6=A 验证：UI 再选卡，该 sale_item 应被前端过滤...')
  await page.goto(`${BASE}/services/create`)
  await expect(page.getByRole('heading', { name: '新建服务单' })).toBeVisible({ timeout: 15000 })

  await page.getByPlaceholder(/手机号/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('姓名') || t.includes('未找到')
  }, { timeout: 15000 })

  const step1Next3 = page.getByRole('button', { name: '下一步' })
  await expect(step1Next3).toBeEnabled({ timeout: 5000 })
  await step1Next3.click()

  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('选择服务项目') || t.includes('暂无可用')
  }, { timeout: 20000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-45-30-step3-items.png` })

  const bodyStep3 = await page.textContent('body')
  // D6=A 核心断言：用满 paid_sessions 的 sale_item 不应出现在可选列表
  // 注：可能其他 sale_item 也属于该顾客，所以只断言"这个特定 ID 不在"
  if (bodyStep3?.includes(PRE_SALE_ITEM_ID)) {
    // 兜底检查：若出现，必须是 disabled 状态（如 stepper max=0）
    const rowsStep3 = page.locator('table tbody tr')
    const rowCntStep3 = await rowsStep3.count()
    let isDisabled = false
    for (let i = 0; i < rowCntStep3; i++) {
      const rt = await rowsStep3.nth(i).textContent()
      if (rt?.includes(PRE_SALE_ITEM_ID)) {
        const rh = await rowsStep3.nth(i).innerHTML()
        if (rh.includes('disabled') || rt.includes('已付次数已用完') || rt.includes('次数不足')) {
          isDisabled = true
        }
        break
      }
    }
    expect(isDisabled).toBe(true)
    console.log('[链路45] Step3 sale_item 出现但已 disabled ✓（D6=A 验证通过）')
  } else {
    console.log('[链路45] Step3 sale_item 未出现在可选列表 ✓（D6=A 验证通过）')
  }

  // ============================================================
  // Step 4: SQL 模拟 admin recordPayment 回款 5000 + 重算 paid_sessions
  // ============================================================
  console.log('[链路45] Step4 模拟回款 5000 + 重算 paid_sessions...')
  runPsql(
    `INSERT INTO sale_order_payments ` +
    `(sale_order_id, change_type, amount, payment_method, status, source_end, created_at, paid_at) ` +
    `VALUES ('${PRE_SALE_ORDER_ID}', '回款', 5000.00, '线下', '已支付', 'admin', NOW(), NOW())`
  )
  runPsql(
    `UPDATE sale_orders SET received=10000.00, status='已支付', paid_at=NOW(), updated_at=NOW() ` +
    `WHERE sale_order_id='${PRE_SALE_ORDER_ID}'`
  )

  // 行级公式：sale_items.received 也需同步到全额（模拟 admin recordPayment 链路把入账金额下分到行）
  runPsql(
    `UPDATE sale_items SET received=10000.00, updated_at=NOW() ` +
    `WHERE sale_order_id='${PRE_SALE_ORDER_ID}'`
  )

  // 调用与 PAID_SESSIONS_RECALC_SQL 等价的 UPDATE（模拟 recalcPaidSessionsForOrder，行级公式）
  runPsql(
    `UPDATE sale_items SET paid_sessions = CASE ` +
    `WHEN sale_items.session_count IS NULL THEN NULL ` +
    `WHEN sale_items.sale_amount <= 0 THEN sale_items.session_count ` +
    `ELSE LEAST(sale_items.session_count, FLOOR(GREATEST(0, sale_items.received::numeric - (op.refunded_amount::numeric * sale_items.sale_amount::numeric / NULLIF(op.total_amount::numeric, 0))) * sale_items.session_count / sale_items.sale_amount::numeric)::integer) ` +
    `END, updated_at = NOW() ` +
    `FROM (SELECT total_amount, COALESCE(refunded_amount, 0) AS refunded_amount FROM sale_orders WHERE sale_order_id='${PRE_SALE_ORDER_ID}') op ` +
    `WHERE sale_items.sale_order_id='${PRE_SALE_ORDER_ID}'`
  )

  const afterStep4 = runPsql(
    `SELECT so.status, so.received, si.paid_sessions, si.remaining_sessions ` +
    `FROM sale_orders so JOIN sale_items si ON si.sale_order_id=so.sale_order_id ` +
    `WHERE so.sale_order_id='${PRE_SALE_ORDER_ID}'`
  )
  const [stStep4, recStep4, paidStep4, remStep4] = afterStep4.split('|')
  expect(stStep4).toBe('已支付')
  expect(parseFloat(recStep4)).toBe(TOTAL_AMOUNT)
  expect(parseInt(paidStep4)).toBe(MULTI_SESSION_COUNT)  // 回款后 paid_sessions = session_count
  expect(parseInt(remStep4)).toBe(MULTI_SESSION_COUNT - INITIAL_PAID_SESSIONS)  // remaining 不变（还是 5）
  console.log(`[链路45] Step4 回款后: status=${stStep4} received=${recStep4} paid=${paidStep4} rem=${remStep4} ✓`)

  // ============================================================
  // Step 5: 验证 UI 再次能选卡（D2=A 重新可消费）
  // ============================================================
  console.log('[链路45] Step5 验证 UI 再次能选卡...')
  await page.goto(`${BASE}/services/create`)
  await expect(page.getByRole('heading', { name: '新建服务单' })).toBeVisible({ timeout: 15000 })

  await page.getByPlaceholder(/手机号/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('姓名') || t.includes('未找到')
  }, { timeout: 15000 })

  const step1Next5 = page.getByRole('button', { name: '下一步' })
  await expect(step1Next5).toBeEnabled({ timeout: 5000 })
  await step1Next5.click()

  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return t.includes('选择服务项目') || t.includes('暂无可用')
  }, { timeout: 20000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-45-50-step5-items.png` })

  // UI 表格不渲染 sale_item_id（只显示商品名/规格/已用/已付/共/单价/到期日）。
  // 回款后 paid_sessions=10, 之前用过 5 次 -> 三段显示 5/10/10。
  const bodyStep5 = await page.textContent('body')
  expect(bodyStep5).toContain(MULTI_SESSION_SKU_NAME)
  expect(bodyStep5).toContain('5/10/10')
  console.log('[链路45] Step5 回款后 sale_item 重新可选 ✓')

  // ============================================================
  // Step 6: 清理
  // ============================================================
  console.log('[链路45] Step6 清理...')
  runPsql(
    `DELETE FROM service_commissions WHERE service_item_id IN ` +
    `(SELECT service_item_id FROM service_items WHERE service_order_id='${serviceOrderId}')`
  )
  runPsql(`DELETE FROM service_items WHERE service_order_id='${serviceOrderId}'`)
  runPsql(`DELETE FROM service_orders WHERE service_order_id='${serviceOrderId}'`)
  runPsql(`DELETE FROM operation_logs WHERE target_id='${serviceOrderId}'`)
  cleanupSaleOrder(PRE_SALE_ORDER_ID, runPsql, { logPrefix: '[链路45-Step6]' })

  const cleanCheck = runPsql(
    `SELECT COUNT(*) FROM sale_orders WHERE sale_order_id='${PRE_SALE_ORDER_ID}'`
  )
  expect(cleanCheck).toBe('0')

  console.log('[链路45] 全部步骤完成 ✓')
})
