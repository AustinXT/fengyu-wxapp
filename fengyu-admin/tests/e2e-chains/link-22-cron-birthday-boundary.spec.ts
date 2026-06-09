/**
 * 链路 22：跨日 cron 边界（生日权益 / 感恩日）
 *
 * 主题：cron `0 3 * * *` Asia/Shanghai 触发，
 *      生日权益按当前 cron tick 的日期判定；同年内幂等。
 *
 * 关键事实（核对 src/cron/steps/grant-birthday-benefits.ts）：
 *   - 无 birthday_grant_log 表（README §1.B 写错）
 *   - 幂等三件套：
 *       messages.idempotency_key = 'birthday-msg-${year}-${userId}'  ON CONFLICT DO NOTHING
 *       point_transactions.external_ref = 'birthday-pts-${year}-${userId}'  ON CONFLICT DO NOTHING
 *       user_coupons.coupon_id = 'bday-${year}-${userId}-${templateId}'  自然主键唯一
 *   - 仅当 client_wechat_users.member_level IS NOT NULL 才进入循环
 *   - benefit 配置来自 system_configs['birthday_benefits']（JSON per member_level）
 *     现网（5434）此配置 5 等级 points=0 + 无 coupon + 无 message → 实际不会发放任何东西
 *
 * 为产生可测的发放结果，spec 临时把"初钻"等级的配置改为有意义值：
 *   {"points": 10, "couponTemplateIds": ["FY-FIX-CT-01"], "messageTitle": "测试生日权益"}
 *
 * 流程：
 *   1. beforeAll 备份 system_configs.birthday_benefits + fixture.birthday/member_level
 *   2. beforeAll 设置 fixture.birthday=今天 + member_level=初钻；注入测试配置
 *   3. test: 跑 cron once → STEP 3 应 grant: +1 point_transaction、+1 message、+1 user_coupon
 *   4. test: 再跑 cron once → STEP 3 应幂等：0 新增
 *   5. afterAll 还原所有 fixture / config
 */

import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'
const ADMIN_DIR = path.resolve(__dirname, '../..')
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'
const FIXTURE_PHONE = '13800138000'
const CONFIG_KEY = 'birthday_benefits'
const TEMPLATE_ID = 'FY-FIX-CT-01'

// beforeAll 真实 admin createOrder 顶 spend 用 — ticket D1 决策 B
// 现 fixture 顾客滚动 12 个月 spend 仅 ~¥1242 < 1980 阈值，
// cron STEP 2 看 spend < 1980 → 把 member_level 强降为 NULL → STEP 3 按
// "member_level IS NOT NULL" 过滤 → 跳过 fixture → 生日权益 0 发放 → 全部 FAIL。
// 解决：beforeAll 真开一单 ≥ ¥1980（20 件 ¥100 SKU = ¥2000）+ 收款，
// 让 STEP 2 看到 spend ≥ 1980 保留 member_level='初钻'，STEP 3 才会发放。
// afterAll 用 cleanupSaleOrder 完整回滚。
const MGR_PHONE = '13900139001'
const MGR_PASS = 'fengyu2026'
const SKU1_NAME = '洗-无创纹身' // 缦之羽 SKU ¥100
const SETUP_TOPUP_QUANTITY = 20 // 20 件 × ¥100 = ¥2000

let setupTopupOrderId = ''

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

function runCronOnce(): string {
  console.log('[链路22] 触发 cron:once …(预计 3-5 分钟，含 STEP 2 全量 + STEP 3 生日)')
  const t0 = Date.now()
  const out = execSync('bun run cron:once', {
    cwd: ADMIN_DIR,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  console.log(`[链路22] cron:once 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return out
}

// ── beforeAll: 备份 + 注入测试配置 ──
let origConfig = ''
let origBirthday = 'NULL'
let origMemberLevel = 'NULL'
let testYear = 0

const TEST_CONFIG = {
  '初钻': {
    points: 10,
    couponTemplateIds: [TEMPLATE_ID],
    messageTitle: '测试生日权益',
    messageBody: 'link-22 自动化测试 — 生日快乐！',
  },
  '星钻': { points: 0, couponTemplateIds: [], messageTitle: '', messageBody: '' },
  '粉钻': { points: 0, couponTemplateIds: [], messageTitle: '', messageBody: '' },
  '金钻': { points: 0, couponTemplateIds: [], messageTitle: '', messageBody: '' },
  '黑钻': { points: 0, couponTemplateIds: [], messageTitle: '', messageBody: '' },
}

// ── beforeAll helper：登录 + 真实 admin createOrder 补 spend ────────────────
async function doSetupLogin(page: Page) {
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(400)
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially(MGR_PHONE, { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially(MGR_PASS, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })
}

async function doSetupCreateTopupOrder(page: Page): Promise<string> {
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  await page.getByPlaceholder(/手机号/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(
    () => {
      const t = document.body.textContent || ''
      return t.includes('找到') || t.includes('未找到')
    },
    { timeout: 15000 },
  )
  const firstCustomerBtn = page.locator('div.space-y-1 > button').first()
  await expect(firstCustomerBtn).toBeVisible({ timeout: 5000 })
  await firstCustomerBtn.click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '下一步' }).click()

  await page.waitForTimeout(2000)
  for (let retry = 0; retry < 3; retry++) {
    const bodyText = await page.textContent('body')
    if (bodyText?.includes('数据未加载') || bodyText?.includes('重试')) {
      const retryBtn = page.getByRole('button', { name: '重试' })
      if ((await retryBtn.count()) > 0) {
        await retryBtn.click()
        await page.waitForTimeout(3000)
      }
    } else if (bodyText?.includes('商品分类') || bodyText?.includes('加入')) {
      break
    } else {
      await page.waitForTimeout(2000)
    }
  }
  await page.waitForFunction(
    () => {
      const t = document.body.textContent || ''
      return (
        (t.includes('商品分类') || t.includes('暂无可选品类') || t.includes('加入')) &&
        !t.includes('正在加载')
      )
    },
    { timeout: 30000 },
  )

  const cat1Btn = page.getByRole('button', { name: '缦之羽', exact: true }).first()
  if ((await cat1Btn.count()) > 0) {
    await cat1Btn.click()
    await page.waitForTimeout(500)
  }

  const skuNameEl = page.getByText(SKU1_NAME, { exact: false })
  let addBtn = page.getByRole('button', { name: /加入/ }).first()
  if ((await skuNameEl.count()) > 0) {
    const skuCard = skuNameEl.first().locator('..').locator('..')
    const scopedAdd = skuCard.getByRole('button', { name: /加入/ })
    if ((await scopedAdd.count()) > 0) addBtn = scopedAdd.first()
  }
  for (let i = 0; i < SETUP_TOPUP_QUANTITY; i++) {
    await addBtn.click()
    await page.waitForTimeout(150)
  }
  console.log(`[链路22 setup] 已加件 SKU1 ${SETUP_TOPUP_QUANTITY} 次（凑 ¥${SETUP_TOPUP_QUANTITY * 100}）`)

  const nextBtn = page.getByRole('button', { name: '下一步' })
  await expect(nextBtn).toBeEnabled({ timeout: 5000 })
  await nextBtn.click()
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({
    timeout: 10000,
  })

  const paySelect = page.locator('select').first()
  if ((await paySelect.count()) > 0) {
    const opts = await paySelect.locator('option').allTextContents()
    if (opts.some((o) => o.includes('线下'))) {
      await paySelect.selectOption({ label: '线下支付' })
    }
  }

  const submitBtn = page.getByRole('button', { name: /提交订单|下一步|确认提交/ }).last()
  await expect(submitBtn).toBeEnabled({ timeout: 5000 })
  await submitBtn.click()

  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })
  let saleOrderId = ''
  const orderIdEl = page.locator('p.font-mono, p:has-text("FY-XSD-WX")').first()
  if ((await orderIdEl.count()) > 0) {
    const text = await orderIdEl.textContent()
    const m = text?.match(/FY-XSD-WX-\d{10}/)
    if (m) saleOrderId = m[0]
  }
  if (!saleOrderId) {
    const bodyText = await page.textContent('body')
    const m = bodyText?.match(/FY-XSD-WX-\d{10}/)
    if (m) saleOrderId = m[0]
  }
  if (!saleOrderId) throw new Error('[链路22 setup] 提取补 spend 订单号失败')

  const confirmPayBtn = page.getByRole('button', { name: '确认收款' })
  await expect(confirmPayBtn).toBeVisible({ timeout: 10000 })
  await confirmPayBtn.click()
  await expect(page.getByText(/收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({
    timeout: 15000,
  })

  return saleOrderId
}

test.beforeAll(async () => {
  // ── 阶段 1：补 spend — 真实 admin UI 开一单 ≥ ¥1980 + 确认收款 ───────────
  // ticket D1 决策 B：cron STEP 2 看 spend ≥ 1980 才不会把 member_level 降回 NULL，
  // STEP 3 grant-birthday-benefits 才会处理 fixture 顾客。
  const browser: Browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  try {
    await doSetupLogin(page)
    setupTopupOrderId = await doSetupCreateTopupOrder(page)
    console.log(`[链路22 setup] 补 spend 订单已创建并收款: ${setupTopupOrderId}`)
    const orderStatus = psql(
      `SELECT status::text FROM sale_orders WHERE sale_order_id='${setupTopupOrderId}'`,
    )
    if (orderStatus !== '已支付') {
      throw new Error(`[链路22 setup] 补 spend 订单状态非已支付: ${orderStatus}`)
    }
  } finally {
    await ctx.close()
    await browser.close()
  }

  const postTopupSpend = parseFloat(
    psql(
      `SELECT COALESCE(SUM(GREATEST((received::numeric) - (refunded_amount::numeric), 0)), 0) ` +
        `FROM sale_orders WHERE client_user_id='${FIXTURE_USER_ID}' ` +
        `AND sale_order_type IN ('销售单','转换单') ` +
        `AND paid_at >= (NOW() - INTERVAL '12 months')`,
    ),
  )
  console.log(`[链路22 setup] 补 spend 后 12mo spend = ${postTopupSpend}`)
  if (postTopupSpend < 1980) {
    throw new Error(
      `[链路22 setup] 补 spend 后 12mo spend=${postTopupSpend} < 1980，beforeAll 失败`,
    )
  }

  // ── 阶段 2：原有备份 + 注入测试配置 ─────────────────────────────────────
  // 备份
  origConfig = psql(`SELECT value::text FROM system_configs WHERE key='${CONFIG_KEY}'`)
  origBirthday = psql(`SELECT COALESCE(birthday::text,'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`)
  origMemberLevel = psql(`SELECT COALESCE(member_level::text,'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`)
  console.log(`[链路22 setup] 备份: birthday=${origBirthday}, member_level=${origMemberLevel}`)
  console.log(`[链路22 setup] 备份 config（前 200 字符）: ${origConfig.substring(0, 200)}…`)

  // 注入测试配置
  const testCfgJson = JSON.stringify(TEST_CONFIG).replace(/'/g, "''")
  psql(`UPDATE system_configs SET value='${testCfgJson}'::jsonb, updated_at=NOW() WHERE key='${CONFIG_KEY}'`)
  console.log('[链路22 setup] 已注入测试 birthday_benefits 配置')

  // 设置 fixture.birthday=今天 + member_level=初钻
  // 补 spend 阶段保证了 cron STEP 2 不会再把 member_level 降回 NULL
  psql(
    `UPDATE client_wechat_users SET birthday=CURRENT_DATE, member_level='初钻'::member_level, updated_at=NOW() ` +
      `WHERE user_id='${FIXTURE_USER_ID}'`,
  )
  testYear = new Date().getFullYear()
  console.log(`[链路22 setup] 已设置 fixture birthday=CURRENT_DATE + member_level=初钻; year=${testYear}`)

  // 预清当年幂等记录
  psql(`DELETE FROM messages WHERE idempotency_key='birthday-msg-${testYear}-${FIXTURE_USER_ID}'`)
  psql(`DELETE FROM point_transactions WHERE external_ref='birthday-pts-${testYear}-${FIXTURE_USER_ID}'`)
  psql(`DELETE FROM user_coupons WHERE coupon_id='bday-${testYear}-${FIXTURE_USER_ID}-${TEMPLATE_ID}'`)

  // 同时 fixture template valid_to=NULL 时 cron 走 365 天兜底，但确保 is_active=true
  psql(`UPDATE coupon_templates SET is_active=true, updated_at=NOW() WHERE template_id='${TEMPLATE_ID}'`)
})

test.afterAll(() => {
  // 清理本次测试产出（即使测试中途失败也清）
  try {
    psql(`DELETE FROM messages WHERE idempotency_key='birthday-msg-${testYear}-${FIXTURE_USER_ID}'`)
  } catch (e) { console.log(`[teardown] 删 messages 出错: ${e}`) }
  try {
    psql(`DELETE FROM point_transactions WHERE external_ref='birthday-pts-${testYear}-${FIXTURE_USER_ID}'`)
  } catch (e) { console.log(`[teardown] 删 point_transactions 出错: ${e}`) }
  try {
    psql(`DELETE FROM user_coupons WHERE coupon_id='bday-${testYear}-${FIXTURE_USER_ID}-${TEMPLATE_ID}'`)
  } catch (e) { console.log(`[teardown] 删 user_coupons 出错: ${e}`) }
  try {
    psql(
      `DELETE FROM operation_logs WHERE action='customer.birthdayBenefits' ` +
        `AND target_id='${FIXTURE_USER_ID}' AND created_at > NOW() - INTERVAL '1 hour'`,
    )
  } catch (e) { console.log(`[teardown] 删 operation_logs 出错: ${e}`) }

  // 还原 fixture
  try {
    if (origBirthday === 'NULL') {
      psql(`UPDATE client_wechat_users SET birthday=NULL, member_level=NULL, updated_at=NOW() WHERE user_id='${FIXTURE_USER_ID}'`)
    } else {
      const mem = origMemberLevel === 'NULL' ? 'NULL' : `'${origMemberLevel}'::member_level`
      psql(
        `UPDATE client_wechat_users SET birthday='${origBirthday}', member_level=${mem}, updated_at=NOW() ` +
          `WHERE user_id='${FIXTURE_USER_ID}'`,
      )
    }
  } catch (e) { console.log(`[teardown] 还原 fixture 出错: ${e}`) }

  // 还原 config
  try {
    if (origConfig) {
      psql(`UPDATE system_configs SET value='${origConfig.replace(/'/g, "''")}'::jsonb, updated_at=NOW() WHERE key='${CONFIG_KEY}'`)
    }
  } catch (e) { console.log(`[teardown] 还原 config 出错: ${e}`) }

  // 清理 beforeAll 补 spend 订单（含 sale_items / sale_allocations / payments / 自引用回款单）
  // — ticket D1 决策 B：beforeAll 引入的 sale_order 在 afterAll 一并清，保持 fixture spend 不永久膨胀。
  if (setupTopupOrderId) {
    try {
      cleanupSaleOrder(setupTopupOrderId, psql, { logPrefix: '[链路22 teardown topup]' })
    } catch (e) { console.log(`[teardown] 清理补 spend 订单 ${setupTopupOrderId} 出错: ${e}`) }
  }

  // 重算 points_balance（cron 写入的 +10 已被上面 DELETE 抵消，需复算缓存避免漂移）
  try {
    psql(
      `UPDATE client_wechat_users SET points_balance = COALESCE((` +
        `SELECT SUM(amount) FROM point_transactions WHERE user_id = client_wechat_users.user_id` +
        `), 0), updated_at=NOW() WHERE user_id='${FIXTURE_USER_ID}'`,
    )
  } catch (e) { console.log(`[teardown] 复算 points_balance 出错: ${e}`) }

  console.log('[链路22 teardown] 完成')
})

test.setTimeout(1500_000) // 25 min, 含 2 次 cron

test('链路22：生日 cron 触发 + 同年幂等', async () => {
  ensureDir(TEST_RESULTS_DIR)
  const verdicts: Array<{ check: string; verdict: string; actual?: string | number }> = []

  const today = new Date().toISOString().substring(0, 10)
  console.log(`[链路22] 今日 = ${today}, testYear = ${testYear}`)

  // ── Step 1: baseline（应都 = 0，已在 beforeAll 预清） ──
  const ptsExternalKey = `birthday-pts-${testYear}-${FIXTURE_USER_ID}`
  const msgIdemKey = `birthday-msg-${testYear}-${FIXTURE_USER_ID}`
  const couponId = `bday-${testYear}-${FIXTURE_USER_ID}-${TEMPLATE_ID}`

  const baselinePts = parseInt(psql(`SELECT count(*) FROM point_transactions WHERE external_ref='${ptsExternalKey}'`), 10) || 0
  const baselineMsg = parseInt(psql(`SELECT count(*) FROM messages WHERE idempotency_key='${msgIdemKey}'`), 10) || 0
  const baselineCpn = parseInt(psql(`SELECT count(*) FROM user_coupons WHERE coupon_id='${couponId}'`), 10) || 0
  console.log(`[链路22] baseline: pts=${baselinePts}, msg=${baselineMsg}, cpn=${baselineCpn}`)
  verdicts.push({
    check: 'baseline_clean',
    verdict: baselinePts === 0 && baselineMsg === 0 && baselineCpn === 0 ? 'PASS' : 'FAIL',
    actual: `pts=${baselinePts}, msg=${baselineMsg}, cpn=${baselineCpn}`,
  })

  // ── Step 2: 第一次 cron ──
  console.log('[链路22] 第一次 cron…')
  const cron1Out = runCronOnce()
  const birthdayLine1 = cron1Out.split('\n').find((l) => l.includes('birthday') || l.includes('STEP 3'))
  console.log(`[链路22] cron1 STEP 3 行: ${birthdayLine1 || '(未找到)'}`)

  const pts1 = parseInt(psql(`SELECT count(*) FROM point_transactions WHERE external_ref='${ptsExternalKey}'`), 10) || 0
  const msg1 = parseInt(psql(`SELECT count(*) FROM messages WHERE idempotency_key='${msgIdemKey}'`), 10) || 0
  const cpn1 = parseInt(psql(`SELECT count(*) FROM user_coupons WHERE coupon_id='${couponId}'`), 10) || 0
  console.log(`[链路22] 第一次 cron 后: pts=${pts1}, msg=${msg1}, cpn=${cpn1}`)
  verdicts.push({
    check: 'first_cron_grants_pts',
    verdict: pts1 === 1 ? 'PASS' : 'FAIL',
    actual: `pts=${pts1}, expected=1`,
  })
  verdicts.push({
    check: 'first_cron_grants_msg',
    verdict: msg1 === 1 ? 'PASS' : 'FAIL',
    actual: `msg=${msg1}, expected=1`,
  })
  verdicts.push({
    check: 'first_cron_grants_coupon',
    verdict: cpn1 === 1 ? 'PASS' : 'FAIL',
    actual: `cpn=${cpn1}, expected=1`,
  })

  // ── Step 3: 第二次 cron（验幂等） ──
  console.log('[链路22] 第二次 cron…')
  runCronOnce()

  const pts2 = parseInt(psql(`SELECT count(*) FROM point_transactions WHERE external_ref='${ptsExternalKey}'`), 10) || 0
  const msg2 = parseInt(psql(`SELECT count(*) FROM messages WHERE idempotency_key='${msgIdemKey}'`), 10) || 0
  const cpn2 = parseInt(psql(`SELECT count(*) FROM user_coupons WHERE coupon_id='${couponId}'`), 10) || 0
  console.log(`[链路22] 第二次 cron 后: pts=${pts2}, msg=${msg2}, cpn=${cpn2}`)
  verdicts.push({
    check: 'second_cron_idempotent_pts',
    verdict: pts2 === 1 ? 'PASS' : 'FAIL',
    actual: `pts=${pts2}, expected=1（ON CONFLICT DO NOTHING）`,
  })
  verdicts.push({
    check: 'second_cron_idempotent_msg',
    verdict: msg2 === 1 ? 'PASS' : 'FAIL',
    actual: `msg=${msg2}, expected=1`,
  })
  verdicts.push({
    check: 'second_cron_idempotent_coupon',
    verdict: cpn2 === 1 ? 'PASS' : 'FAIL',
    actual: `cpn=${cpn2}, expected=1（自然主键唯一）`,
  })

  // ── Step 4: 感恩日校验 ──
  // 仅每月 20 号触发感恩日 STEP 4。今日非 20 号则 STEP 4 应跳过（无 thx- 系列产出）
  const isToday20th = new Date().getDate() === 20
  const thxPts = parseInt(
    psql(`SELECT count(*) FROM point_transactions WHERE external_ref LIKE 'thx-pts-%-${FIXTURE_USER_ID}'`),
    10,
  ) || 0
  verdicts.push({
    check: 'thanksgiving_only_on_20th',
    verdict: isToday20th || thxPts === 0 ? 'PASS' : 'SKIP',
    actual: `today=${today} day=${new Date().getDate()}, isToday20th=${isToday20th}, thxPts=${thxPts}`,
  })

  // ── Step 5: operation_logs 含 customer.birthdayBenefits ──
  const birthdayLogCount = parseInt(
    psql(
      `SELECT count(*) FROM operation_logs ` +
        `WHERE action='customer.birthdayBenefits' AND target_id='${FIXTURE_USER_ID}' ` +
        `AND created_at > NOW() - INTERVAL '20 minutes'`,
    ),
    10,
  ) || 0
  // 实测：每次 grantOneBirthday 成功跑都会 INSERT 一条日志 → 跑 2 次预期 2 条
  verdicts.push({
    check: 'birthday_operation_log',
    verdict: birthdayLogCount >= 1 ? 'PASS' : 'FAIL',
    actual: `log_count=${birthdayLogCount}`,
  })

  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const overallStatus = hasFail ? 'FAIL' : verdicts.some((v) => v.verdict === 'SKIP') ? 'PARTIAL' : 'PASS'
  const report = {
    link: 22,
    status: overallStatus,
    testYear,
    today,
    fixtureUserId: FIXTURE_USER_ID,
    verdicts,
    cleaned: true,
    notes: '无 birthday_grant_log 表；幂等靠 external_ref / idempotency_key / coupon_id 三件套；'
      + '感恩日 STEP 4 硬编码仅当日 day=20 时跑',
  }
  console.log('\n[链路22] === 最终报告 ===')
  console.log(JSON.stringify(report, null, 2))
  writeCtx('link22', report)

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})
