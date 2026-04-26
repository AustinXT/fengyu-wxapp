/**
 * 链路 3 回归：预约 → 确认（验证 confirmed_at）→ 签到 → 新建服务单（验证自动关联 appointment_id）
 *
 * 前置条件：
 *   - TEST-APT-001 已 INSERT（状态=待确认）
 *   - TEST-SIID-TMP01 已 INSERT（remaining_sessions > 0，归属 FY-FIX-CLIENT-01）
 *
 * 跑法：
 *   bunx playwright test --config=scripts/manual-e2e/playwright.manual.config.ts \
 *     link-3-appointment-flow.spec.ts --project=chromium --reporter=list
 */

import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'

const BASE = 'http://localhost:3000'
const PG_CMD = 'PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp'

function dbQuery(sql: string): string {
  return execSync(`${PG_CMD} -t -A -c "${sql.replace(/"/g, '\\"')}"`).toString().trim()
}

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

    // 选择员工：选择"测试店长"
    // 员工 select 位置在"负责美容师"标签下（第二个 select，第一个是门店）
    const employeeSelect = page.locator('select').nth(1)
    // 获取所有 option 文本，找到含"测试店长"的那个值
    const empOptions = await employeeSelect.locator('option').all()
    let empValue = ''
    for (const opt of empOptions) {
      const text = await opt.textContent()
      if (text && text.includes('测试店长')) {
        empValue = (await opt.getAttribute('value')) ?? ''
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

    await page.screenshot({ path: `${SHOTS}/link3-B2-success.png`, fullPage: true })

    // DB 验证：service_orders.appointment_id = 'TEST-APT-001'
    const linkedApptId = dbQuery(
      `SELECT appointment_id FROM service_orders WHERE service_order_id='${serviceOrderId}'`
    )
    console.log('[VERDICT] service_orders.appointment_id =', linkedApptId)
    expect(linkedApptId).toBe('TEST-APT-001')
  })
})
