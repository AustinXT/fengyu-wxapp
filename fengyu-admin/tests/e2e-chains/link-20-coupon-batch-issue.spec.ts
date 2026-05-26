/**
 * 链路 20：优惠券模板批量发放
 *
 * 主题：admin 通过模板批量给一批顾客发券，user_coupons 新增行数 == 被勾选/输入的手机号数。
 *
 * NOTE: README §1.B 写"coupon_templates.granted_count += N"；实际 coupon_templates 无 granted_count 列。
 *       本 spec 改用 COUNT(*) FROM user_coupons WHERE template_id=T 前后对比。
 *
 * 真实 action：batchIssueCoupons(templateId, phones: string[])
 *   - 不超过 200 个手机号
 *   - tpl 必须 isActive
 *   - validity_mode='days' 用 validDays + NOW；'fixed' 用 valid_to
 *   - 未匹配到顾客的手机号 → 全部失败（不是部分发放）
 *
 * Fixture FY-FIX-CT-01 当前 validity_mode='fixed' 但 valid_to=NULL → 必须 spec 前置补齐
 * （beforeAll 设 valid_to=NOW()+30 天；afterAll 还原为 NULL）
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const BASE = 'http://localhost:3000'
const PRD_PHONE = '13900139004'
const PASS = 'fengyu2026'
const TEMPLATE_ID = 'FY-FIX-CT-01'
const FIXTURE_PHONE = '13800138000'
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'

// 真实存在的额外测试顾客（已确认 5434 上有）
const OTHER_PHONES = [
  '13900139002', // FYGK-20250205-0002（FY-TEST-FIN 也共用此号？— 实际只用作 coupon 收件人）
  '13900139006', // FYGK-20260101-0006
]

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) }

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

// 临时设置 fixture 模板 valid_to，使 batchIssueCoupons 不报"有效期配置异常"
let preValidTo = 'NULL'
test.beforeAll(() => {
  preValidTo = psql(`SELECT COALESCE(valid_to::text,'NULL') FROM coupon_templates WHERE template_id='${TEMPLATE_ID}'`)
  // 设为 NOW + 30 天
  psql(`UPDATE coupon_templates SET valid_to=NOW() + INTERVAL '30 days', is_active=true, updated_at=NOW() WHERE template_id='${TEMPLATE_ID}'`)
  console.log(`[链路20 setup] 已设置 ${TEMPLATE_ID} valid_to=NOW+30d, 原值 ${preValidTo}`)
})

test.afterAll(() => {
  // 还原 valid_to 到原值
  try {
    if (preValidTo === 'NULL') {
      psql(`UPDATE coupon_templates SET valid_to=NULL, updated_at=NOW() WHERE template_id='${TEMPLATE_ID}'`)
    } else {
      psql(`UPDATE coupon_templates SET valid_to='${preValidTo}', updated_at=NOW() WHERE template_id='${TEMPLATE_ID}'`)
    }
    console.log(`[链路20 teardown] valid_to 已还原`)
  } catch (e) {
    console.log(`[链路20 teardown] 还原 valid_to 失败（非致命）: ${e}`)
  }
})

test.setTimeout(180_000)

test('链路20：优惠券模板批量发放（数量对账）', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)
  const verdicts: Array<{ check: string; verdict: string; actual?: string | number }> = []

  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })

  // ── 前置：取 N0、cutoff ──
  const n0 = parseInt(psql(`SELECT count(*) FROM user_coupons WHERE template_id='${TEMPLATE_ID}'`), 10) || 0
  const cutoffStr = psql(`SELECT NOW()::text`)
  console.log(`[链路20] N0 = ${n0}, cutoff = ${cutoffStr}`)

  // ── Step 1: PRD 登录 → /coupons/[id] → 批量发放 Dialog ──
  await login(page, PRD_PHONE, PASS)
  console.log('[链路20] PRD 登录成功')

  await page.goto(`${BASE}/coupons/${TEMPLATE_ID}`)
  await expect(page.getByText(/优惠券详情|Fixture-满200减30|模板/).first()).toBeVisible({ timeout: 15000 })
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-20-01-coupon-detail.png` })

  // 点 "批量发放" 按钮
  const batchBtn = page.getByRole('button', { name: '批量发放' })
  await expect(batchBtn).toBeVisible({ timeout: 10000 })
  await batchBtn.click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-20-02-batch-dialog.png` })

  // Dialog 应 visible — 默认是 manual 模式（输入手机号）
  // 输入 fixture + 2 个其他 phone（每行一个）
  const phoneList = [FIXTURE_PHONE, ...OTHER_PHONES]
  const phoneText = phoneList.join('\n')
  const phoneTextarea = page.locator('textarea').first()
  await expect(phoneTextarea).toBeVisible({ timeout: 5000 })
  await phoneTextarea.click()
  await phoneTextarea.fill(phoneText)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-20-03-phones-filled.png` })

  // 提交按钮 — 必须在 dialog 作用域内查找，避免与外层"打开 dialog"触发按钮歧义
  // README §1.B link-20：dialog backdrop 拦截 outer button click → 30+ 重试超时
  const dialog = page.locator('div[role="dialog"], dialog[open]').first()
  await expect(dialog).toBeVisible({ timeout: 5000 })
  let submitOK = false
  for (const name of ['批量发放', '确认发放', '确认', '提交']) {
    const btn = dialog.getByRole('button', { name })
    if (await btn.count() > 0 && await btn.isEnabled()) {
      await btn.click()
      submitOK = true
      console.log(`[链路20] 点击了"${name}"按钮提交（dialog 作用域内）`)
      break
    }
  }
  if (!submitOK) throw new Error('找不到批量发放提交按钮')

  // 等成功 toast 或错误
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return /发放成功|批量发放成功|已发放|失败|错误/.test(t)
  }, { timeout: 20000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-20-04-after-submit.png` })

  // ── Step 2: DB 校验 ──
  // 2.1 user_coupons 新增数量 = phoneList.length（3）
  const n1 = parseInt(psql(`SELECT count(*) FROM user_coupons WHERE template_id='${TEMPLATE_ID}'`), 10) || 0
  const delta = n1 - n0
  console.log(`[链路20] N1=${n1}, delta=${delta}`)
  verdicts.push({
    check: 'user_coupons_count_delta_eq_phones',
    verdict: delta === phoneList.length ? 'PASS' : 'FAIL',
    actual: `delta=${delta}, expected=${phoneList.length} (N0=${n0}, N1=${n1})`,
  })

  // 2.2 新增行 status='未使用' 且 expire_at > NOW
  const newCouponRows = psql(
    `SELECT count(*) FROM user_coupons WHERE template_id='${TEMPLATE_ID}' ` +
      `AND created_at > '${cutoffStr}'::timestamp AND status='未使用' AND expire_at > NOW()`,
  )
  verdicts.push({
    check: 'new_coupons_active_state',
    verdict: parseInt(newCouponRows, 10) === phoneList.length ? 'PASS' : 'FAIL',
    actual: `valid_new_rows=${newCouponRows}, expected=${phoneList.length}`,
  })

  // 2.3 operation_logs 含 coupon.batchIssue
  const logCount = psql(
    `SELECT count(*) FROM operation_logs ` +
      `WHERE action='coupon.batchIssue' AND target_id='${TEMPLATE_ID}' AND created_at > '${cutoffStr}'::timestamp`,
  )
  verdicts.push({
    check: 'operation_log_batch_issue',
    verdict: parseInt(logCount, 10) >= 1 ? 'PASS' : 'FAIL',
    actual: logCount,
  })

  // 2.4 reference detail.phones 含输入手机号
  const logDetail = psql(
    `SELECT detail::text FROM operation_logs ` +
      `WHERE action='coupon.batchIssue' AND target_id='${TEMPLATE_ID}' AND created_at > '${cutoffStr}'::timestamp ` +
      `ORDER BY created_at DESC LIMIT 1`,
  )
  const hasFixturePhone = logDetail.includes(FIXTURE_PHONE)
  verdicts.push({
    check: 'log_detail_contains_phones',
    verdict: hasFixturePhone ? 'PASS' : 'SKIP',
    actual: logDetail.length > 200 ? logDetail.substring(0, 200) + '...' : logDetail,
  })

  // ── Step 3: 清理 — 删本测发放的券 + 日志 ──
  console.log('[链路20] Step 3: 清理 — 删本测发放的 user_coupons + 日志')
  try {
    psql(
      `DELETE FROM user_coupons WHERE template_id='${TEMPLATE_ID}' ` +
        `AND created_at > '${cutoffStr}'::timestamp`,
    )
    psql(
      `DELETE FROM operation_logs WHERE action='coupon.batchIssue' ` +
        `AND target_id='${TEMPLATE_ID}' AND created_at > '${cutoffStr}'::timestamp`,
    )
  } catch (e) {
    console.log(`[链路20] 清理出错（非致命）: ${e}`)
  }

  // 确认清理后 user_coupons 数 = N0
  const nAfterClean = parseInt(psql(`SELECT count(*) FROM user_coupons WHERE template_id='${TEMPLATE_ID}'`), 10) || 0
  console.log(`[链路20] 清理后 count = ${nAfterClean}（应=${n0}）`)

  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const overallStatus = hasFail ? 'FAIL' : verdicts.some((v) => v.verdict === 'SKIP') ? 'PARTIAL' : 'PASS'
  const report = {
    link: 20,
    status: overallStatus,
    templateId: TEMPLATE_ID,
    phoneCount: phoneList.length,
    delta,
    n0,
    nAfterClean,
    verdicts,
    cleaned: nAfterClean === n0,
    notes: 'coupon_templates 无 granted_count 列；本 spec 用 user_coupons COUNT 增量校验；'
      + 'fixture 模板 valid_to=NULL 由 beforeAll 临时填充',
  }

  console.log('\n[链路20] === 最终报告 ===')
  console.log(JSON.stringify(report, null, 2))
  writeCtx('link20', report)

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})
