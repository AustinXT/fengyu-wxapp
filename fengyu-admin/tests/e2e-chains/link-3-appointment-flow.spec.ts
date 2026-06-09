/**
 * 链路 3 回归：预约 → 确认（验证 confirmed_at）→ 签到 → 新建服务单（验证自动关联 appointment_id）
 *
 * Fixture（由本 spec 自管理，beforeAll INSERT / afterAll DELETE）：
 *   - TEST-APT-001（状态=待确认；FY-FIX-CLIENT-01 / store-nc01 / FY-TEST-MGR）
 *   - 段 B2 复用 FY-FIX-CLIENT-01 已有的可用 sale_item（remaining_sessions > 0），不再 INSERT 临时 SIID
 *
 * 跑法：
 *   bunx playwright test --config=tests/e2e-chains/playwright.manual.config.ts \
 *     link-3-appointment-flow.spec.ts --project=chromium --reporter=list
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'
const PG_CMD = 'PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5434 -U fengyu -d fengyu_e2e'

const APPT_ID = 'TEST-APT-001'
const FIX_CLIENT_ID = 'FY-FIX-CLIENT-01'
const FIX_STORE_ID = 'store-nc01'
const FIX_EMP_ID = 'FY-TEST-MGR'
const FIX_EMP_NAME = '测试店长'
const FIX_CLIENT_NAME = 'Fixture测试客'

// 段 B2 需要 FY-FIX-CLIENT-01 名下有一张「已支付 / 疗程卡 / remaining_sessions>0」的 sale_item
// 才能进入 /services/create Step 2 看到可选行。Fixture 不保证留存（数据可能被其它清理流程移除），
// 故本 spec 自管理一笔 10 次卡注入单（ID 与 link-12 等错开避免冲突）。
const PRE_SALE_ORDER_ID = 'FY-XSD-WX-2604039903'
const PRE_SALE_ITEM_ID = 'FY-XSD-WX-2604039903-01'
const PRE_SALE_SKU_ID = 'sku-001-02'
const PRE_SALE_SKU_NAME = '蜜语水润嫩肤护理 10次卡'
const PRE_SALE_PRODUCT_NAME = '蜜语水润嫩肤护理'

function dbQuery(sql: string): string {
  return execSync(`${PG_CMD} -t -A -c "${sql.replace(/"/g, '\\"')}"`).toString().trim()
}

function dbExec(sql: string): void {
  execSync(`${PG_CMD} -c "${sql.replace(/"/g, '\\"')}"`, { stdio: 'pipe' })
}

// 跨 test 共享：B2 创建出的服务单号（用于 afterAll 清理）
const createdServiceOrderIds: string[] = []

// ──────────────────────────────────────────────────────────────────────────────
// Fixture：每次跑前清掉残留再 INSERT，跑完再 DELETE
// 顺序遵守 FK：先把可能引用本 appointment 的 service_orders 解绑，再删 appointment
// ──────────────────────────────────────────────────────────────────────────────
async function cleanupAppointmentFixture() {
  // service_orders.appointment_id 是 FK；解绑之前所有引用，再删本预约
  dbExec(`UPDATE service_orders SET appointment_id=NULL WHERE appointment_id='${APPT_ID}'`)
  dbExec(`DELETE FROM appointments WHERE appointment_id='${APPT_ID}'`)
  dbExec(`DELETE FROM operation_logs WHERE target_id='${APPT_ID}'`)
}

/** 清理 B2 阶段创建的服务单（service_items → service_orders → operation_logs）。单条失败仅 log 不抛 */
function cleanupServiceOrder(soid: string) {
  if (!soid) return
  const stmts: Array<[string, string]> = [
    ['service_commissions', `DELETE FROM service_commissions WHERE service_item_id IN (SELECT service_item_id FROM service_items WHERE service_order_id='${soid}')`],
    ['service_items', `DELETE FROM service_items WHERE service_order_id='${soid}'`],
    ['service_orders', `DELETE FROM service_orders WHERE service_order_id='${soid}'`],
    ['operation_logs', `DELETE FROM operation_logs WHERE target_id='${soid}'`],
  ]
  for (const [tag, sql] of stmts) {
    try {
      dbExec(sql)
      console.log(`[link-3 afterAll cleanup] ${tag} (${soid}): ok`)
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
      console.error(`[link-3 afterAll cleanup] ${tag} (${soid}): skipped (${msg})`)
    }
  }
}

async function insertAppointmentFixture() {
  await cleanupAppointmentFixture()
  dbExec(
    `INSERT INTO appointments
      (appointment_id, status, store_id, client_user_id, client_name,
       employee_id, employee_name, appointment_time)
     VALUES
      ('${APPT_ID}', '待确认', '${FIX_STORE_ID}', '${FIX_CLIENT_ID}', '${FIX_CLIENT_NAME}',
       '${FIX_EMP_ID}', '${FIX_EMP_NAME}', NOW() + INTERVAL '1 day')`,
  )
}

/**
 * 注入一张已支付 / 疗程卡 / remaining_sessions>0 的 sale_item，供段 B2 在 /services/create 选中。
 * 若 fixture 顾客名下已经存在可用 sale_item（remaining_sessions>0 + paid_sessions 充足 + 已支付），
 * 则跳过注入，afterAll 也不清理。
 */
let injectedSaleItem = false
async function ensurePaidSaleItemFixture() {
  const existing = dbQuery(
    `SELECT si.sale_item_id FROM sale_items si JOIN sale_orders so ON so.sale_order_id = si.sale_order_id ` +
    `WHERE so.client_user_id='${FIX_CLIENT_ID}' AND so.status IN ('已支付','部分支付') ` +
    `AND si.item_direction='购买' AND si.product_type = '疗程卡' ` +
    `AND si.remaining_sessions > 0 ` +
    `AND COALESCE(si.paid_sessions, 0) >= si.session_count - si.remaining_sessions + 1 ` +
    `AND (si.expire_date IS NULL OR si.expire_date > CURRENT_DATE) ` +
    `LIMIT 1`,
  )
  if (existing) {
    console.log(`[link-3 beforeAll] 复用已有 sale_item=${existing}，跳过注入`)
    return
  }
  console.log('[link-3 beforeAll] 未找到可用 sale_item，SQL 注入一笔 10 次卡（已支付）')
  // 清理可能的遗留（幂等）
  cleanupSaleOrder(PRE_SALE_ORDER_ID, dbQuery, { logPrefix: '[link-3 beforeAll]' })

  const marketName = dbQuery(
    `SELECT DISTINCT market_name FROM sale_orders WHERE store_id='${FIX_STORE_ID}' LIMIT 1`,
  ) || '南昌市场'

  dbExec(
    `INSERT INTO sale_orders ` +
    `(sale_order_id, status, sale_order_type, market_name, store_id, sale_order_datetime, ` +
    ` client_user_id, client_phone, customer_name, total_amount, payment_method, ` +
    ` opened_by, paid_at, created_at, updated_at) ` +
    `VALUES ` +
    `('${PRE_SALE_ORDER_ID}', '已支付', '销售单', '${marketName}', '${FIX_STORE_ID}', NOW(), ` +
    ` '${FIX_CLIENT_ID}', '13800138000', '${FIX_CLIENT_NAME}', 1999.00, '线下', ` +
    ` '${FIX_EMP_ID}', NOW(), NOW(), NOW()) ` +
    `ON CONFLICT (sale_order_id) DO NOTHING`,
  )
  dbExec(
    `INSERT INTO sale_items ` +
    `(sale_item_id, sale_order_id, item_direction, sku_id, session_count, remaining_sessions, paid_sessions, ` +
    ` unit_price, quantity, unit_real_price, sale_amount, received, ` +
    ` product_name, product_type, store_id, created_at, updated_at) ` +
    `VALUES ` +
    `('${PRE_SALE_ITEM_ID}', '${PRE_SALE_ORDER_ID}', '购买', '${PRE_SALE_SKU_ID}', ` +
    ` 10, 10, 10, ` +
    ` 1999.00, 1, 1999.00, 1999.00, 1999.00, ` +
    ` '${PRE_SALE_PRODUCT_NAME}', '疗程卡', '${FIX_STORE_ID}', NOW(), NOW()) ` +
    `ON CONFLICT (sale_item_id) DO NOTHING`,
  )
  injectedSaleItem = true
  console.log(`[link-3 beforeAll] 已注入 ${PRE_SALE_ORDER_ID} / ${PRE_SALE_ITEM_ID}`)
}

/**
 * 预清理 fixture 顾客残留的活跃服务单。
 * uq_so_client_active 是 client_user_id 上 WHERE status NOT IN ('已完成','已取消') 的偏唯一索引
 * （同一顾客同时只能有一个未完成服务单）。上一轮 link-2/3/45 若中途失败会留下孤儿活跃服务单，
 * 阻塞 B2 的服务单创建（提交后停在确认页，等不到"服务单创建成功"标题）。
 */
function cleanupActiveServiceOrders() {
  const raw = dbQuery(
    `SELECT service_order_id FROM service_orders WHERE client_user_id='${FIX_CLIENT_ID}' AND status NOT IN ('已完成','已取消')`,
  )
  for (const sid of raw.split('\n').map((s) => s.trim()).filter(Boolean)) {
    console.log(`[link-3 beforeAll] 清理残留活跃服务单 ${sid}`)
    cleanupServiceOrder(sid)
  }
}

test.beforeAll(async () => {
  cleanupActiveServiceOrders()
  await insertAppointmentFixture()
  await ensurePaidSaleItemFixture()
})

test.afterAll(async () => {
  // 段 B2 跑完会产生 service_orders；先按 ID 清掉这些服务单（含 service_items / operation_logs），
  // 再解 appointment 引用并删 appointment 本身。单条失败均 try/catch 不抛。
  for (const soid of createdServiceOrderIds) {
    cleanupServiceOrder(soid)
  }
  try {
    await cleanupAppointmentFixture()
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
    console.error(`[link-3 afterAll cleanup] appointment fixture: skipped (${msg})`)
  }
  // 注入的 sale_order 一并回收（若 B2 选中并使用过它，会有 service_items 引用——cleanupSaleOrder 会按 FK 顺序清干净）
  if (injectedSaleItem) {
    cleanupSaleOrder(PRE_SALE_ORDER_ID, dbQuery, { logPrefix: '[link-3 afterAll]' })
  }
})

/** 以 FY-TEST-MGR（13900139001/fengyu2026）身份登录 */
async function login(page: import('@playwright/test').Page) {
  await page.goto(`${BASE}/login`)
  await page.getByRole('button', { name: /登 录/ }).waitFor({ state: 'visible' })
  await page.waitForTimeout(400)
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially('13900139001', { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially('fengyu2026', { delay: 30 })
  await page.getByRole('button', { name: /登 录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 15000 })
}

/** 结果截图目录 */
const SHOTS = path.resolve('test-results')
fs.mkdirSync(SHOTS, { recursive: true })

// ──────────────────────────────────────────────────────────────────────────────
// 段 A：验证 confirmAppointment 补写了 confirmed_at = NOW()
// ──────────────────────────────────────────────────────────────────────────────
test.describe('段 A：确认预约 → confirmed_at 不为空', () => {
  test.setTimeout(90_000)

  test('A1: 确认 TEST-APT-001 并验证 confirmed_at IS NOT NULL', async ({ page }) => {
    await login(page)

    // 进待确认 Tab（默认 tab=pending）
    await page.goto(`${BASE}/appointments`)
    await expect(page.getByRole('heading', { name: '预约管理' })).toBeVisible()

    // 搜索 Fixture测试客
    const searchInput = page.getByPlaceholder(/搜索顾客/)
    await searchInput.fill('Fixture测试客')
    await page.waitForTimeout(500)
    await page.waitForLoadState('networkidle')

    await page.screenshot({ path: `${SHOTS}/link3-A1-before-confirm.png`, fullPage: true })

    // 找到该行
    const apptRow = page.locator('tr', { hasText: 'Fixture测试客' }).first()
    await expect(apptRow).toBeVisible({ timeout: 10_000 })

    // 找到"确认"按钮
    const confirmBtn = apptRow.getByRole('button', { name: '确认' })
    await expect(confirmBtn).toBeVisible()

    // 点确认
    await confirmBtn.click()
    // 等待 toast
    await expect(page.getByText(/确认成功|预约已确认|操作成功/).first()).toBeVisible({ timeout: 10_000 })
    await page.waitForLoadState('networkidle')

    await page.screenshot({ path: `${SHOTS}/link3-A1-after-confirm.png`, fullPage: true })

    // DB 验证：confirmed_at IS NOT NULL
    const confirmedAt = dbQuery(
      `SELECT confirmed_at::text FROM appointments WHERE appointment_id='TEST-APT-001'`
    )
    expect(confirmedAt).not.toBe('')
    expect(confirmedAt.toLowerCase()).not.toBe('null')
    expect(confirmedAt.toLowerCase()).not.toBe('(null)')
    console.log('[VERDICT] confirmed_at =', confirmedAt)
  })

  test('A2: 已确认 Tab 显示签到按钮，待确认 Tab 不显示签到', async ({ page }) => {
    await login(page)

    // 已确认 Tab
    await page.goto(`${BASE}/appointments?tab=confirmed`)
    await expect(page.getByRole('heading', { name: '预约管理' })).toBeVisible()

    const searchInput = page.getByPlaceholder(/搜索顾客/)
    await searchInput.fill('Fixture测试客')
    await page.waitForTimeout(500)
    await page.waitForLoadState('networkidle')

    const confirmedRow = page.locator('tr', { hasText: 'Fixture测试客' }).first()
    await expect(confirmedRow).toBeVisible({ timeout: 10_000 })

    // 应有"签到"按钮
    const checkinBtn = confirmedRow.getByRole('button', { name: '签到' })
    await expect(checkinBtn).toBeVisible()

    // 待确认 Tab 该行消失
    await page.goto(`${BASE}/appointments`)
    const searchInput2 = page.getByPlaceholder(/搜索顾客/)
    await searchInput2.fill('Fixture测试客')
    await page.waitForTimeout(500)
    await page.waitForLoadState('networkidle')
    // TEST-APT-001 已变为已确认，不应出现在待确认 Tab
    const pendingRow = page.locator('tr', { hasText: 'Fixture测试客' })
    await expect(pendingRow).toHaveCount(0, { timeout: 5_000 })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 段 B：签到 → 新建服务单 → 验证 appointment_id 自动关联
// ──────────────────────────────────────────────────────────────────────────────
test.describe('段 B：签到 → 新建服务单 → appointment_id 自动关联', () => {
  test.setTimeout(120_000)

  test('B1: 签到 TEST-APT-001', async ({ page }) => {
    await login(page)

    // 已确认 Tab
    await page.goto(`${BASE}/appointments?tab=confirmed`)
    await expect(page.getByRole('heading', { name: '预约管理' })).toBeVisible()

    const searchInput = page.getByPlaceholder(/搜索顾客/)
    await searchInput.fill('Fixture测试客')
    await page.waitForTimeout(500)
    await page.waitForLoadState('networkidle')

    const confirmedRow = page.locator('tr', { hasText: 'Fixture测试客' }).first()
    await expect(confirmedRow).toBeVisible({ timeout: 10_000 })

    const checkinBtn = confirmedRow.getByRole('button', { name: '签到' })
    await expect(checkinBtn).toBeVisible()

    await checkinBtn.click()
    await expect(page.getByText(/签到成功|已签到|操作成功/).first()).toBeVisible({ timeout: 10_000 })
    await page.waitForLoadState('networkidle')

    await page.screenshot({ path: `${SHOTS}/link3-B1-after-checkin.png`, fullPage: true })

    // DB 验证：checkin_at IS NOT NULL
    const checkinAt = dbQuery(
      `SELECT checkin_at::text FROM appointments WHERE appointment_id='TEST-APT-001'`
    )
    expect(checkinAt).not.toBe('')
    expect(checkinAt.toLowerCase()).not.toBe('null')
    console.log('[VERDICT] checkin_at =', checkinAt)
  })

  test('B2: 新建服务单 → 自动关联 appointment_id = TEST-APT-001', async ({ page }) => {
    await login(page)

    // 进 /services/create
    await page.goto(`${BASE}/services/create`)
    await expect(page.getByRole('heading', { name: '新建服务单' })).toBeVisible()

    // Step 1：输入顾客手机号搜索
    const phoneInput = page.getByPlaceholder(/输入手机号搜索/)
    await phoneInput.fill('13800138000')
    await page.getByRole('button', { name: '搜索' }).click()

    // 等待顾客卡片出现（含姓名"Fixture测试客"）
    await expect(page.getByText('Fixture测试客').first()).toBeVisible({ timeout: 10_000 })

    await page.screenshot({ path: `${SHOTS}/link3-B2-customer-found.png`, fullPage: true })

    // 点下一步进入 Step 2
    await page.getByRole('button', { name: '下一步' }).click()
    // 等待 Step 2 表格或"暂无可用"提示出现
    await page.waitForTimeout(1000)
    await page.waitForLoadState('networkidle')

    await page.screenshot({ path: `${SHOTS}/link3-B2-step2.png`, fullPage: true })

    // 选择第一个可用项目（点击行以勾选 checkbox）
    const firstItemRow = page.locator('tbody tr').first()
    await expect(firstItemRow).toBeVisible({ timeout: 10_000 })
    await firstItemRow.click()
    // 验证 checkbox 已选中
    const checkbox = firstItemRow.locator('input[type="checkbox"]')
    await expect(checkbox).toBeChecked()

    // 选择员工：取第一个非"请选择"的选项
    // 员工 select 位置在"负责美容师"标签下（第二个 select，第一个是门店）
    // 注：UI 按 skills.includes('美容师') 过滤，FY-TEST-MGR 没"美容师"标签所以不会出现
    const employeeSelect = page.locator('select').nth(1)
    const empOptions = await employeeSelect.locator('option').all()
    let empValue = ''
    for (const opt of empOptions) {
      const text = await opt.textContent()
      const value = (await opt.getAttribute('value')) ?? ''
      if (value && text && !text.includes('请选择')) {
        empValue = value
        break
      }
    }
    expect(empValue).not.toBe('')
    await employeeSelect.selectOption(empValue)

    await page.screenshot({ path: `${SHOTS}/link3-B2-step2-filled.png`, fullPage: true })

    // 点下一步进入 Step 3（确认提交）
    const nextBtns = page.getByRole('button', { name: '下一步' })
    await nextBtns.last().click()
    await page.waitForTimeout(500)

    await page.screenshot({ path: `${SHOTS}/link3-B2-step3-confirm.png`, fullPage: true })

    // Step 3：点"提交服务单"
    const submitBtn = page.getByRole('button', { name: '提交服务单' })
    await expect(submitBtn).toBeVisible({ timeout: 5_000 })
    await submitBtn.click()

    // 等待成功页（含"服务单创建成功"标题）
    await expect(page.getByRole('heading', { name: '服务单创建成功' })).toBeVisible({ timeout: 15_000 })

    // 读取成功页上展示的服务单号（格式 FY-FW-YYMMDD0001）
    const serviceOrderIdEl = page.locator('p.font-mono')
    const serviceOrderId = (await serviceOrderIdEl.textContent())?.trim() ?? ''
    console.log('[INFO] Created serviceOrderId =', serviceOrderId)
    expect(serviceOrderId).toMatch(/^FY-FW-/)
    // 记录待 afterAll 清理（FK 顺序：service_items → service_orders → operation_logs）
    if (serviceOrderId) createdServiceOrderIds.push(serviceOrderId)

    await page.screenshot({ path: `${SHOTS}/link3-B2-success.png`, fullPage: true })

    // DB 验证：service_orders.appointment_id = 'TEST-APT-001'
    const linkedApptId = dbQuery(
      `SELECT appointment_id FROM service_orders WHERE service_order_id='${serviceOrderId}'`
    )
    console.log('[VERDICT] service_orders.appointment_id =', linkedApptId)
    expect(linkedApptId).toBe('TEST-APT-001')
  })
})
