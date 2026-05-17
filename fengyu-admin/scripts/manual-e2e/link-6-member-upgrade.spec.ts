/**
 * 链路 6：会员等级升级（cron 触发）
 *
 * 验证 cron STEP 2 `refresh-member-levels` 端到端：
 *   1. 重置 fixture 顾客 member_level=NULL（保留既有 sale_orders，rolling-12mo spend ≈ 2700+）
 *   2. MGR 在 admin 端再下一单 ¥200 + 确认收款（演示「跨阈值」流程，亦贡献新流水）
 *   3. `bun run cron:once` 触发；STEP 2 应判定 spend ≥ 1980 → 升级 NULL → 初钻
 *   4. DB 验证：
 *        - client_wechat_users.member_level='初钻'、old_member_level=NULL、
 *          member_level_upgraded_at 在最近窗口、member_level_locked_until ≈ +150 天
 *        - point_transactions 新增一行 external_ref='member-upgrade-FY-FIX-CLIENT-01-初钻'
 *          （初钻 points=0 → 不发奖励积分 → 流水不会生成；这里改为「不存在该行」断言）
 *        - messages 新增一行 idempotency_key='member-upgrade-FY-FIX-CLIENT-01-初钻'、
 *          recipient_type='客户'、recipient_id='FY-FIX-CLIENT-01'
 *        - user_coupons：因 member_level_benefits.初钻.couponTemplateIds=[] → 0 行新增
 *   5. 幂等性：再次跑 cron:once，messages 行计数 / member_level_upgraded_at 均不变
 *   6. 清理：删除测试销售单、删除 cron 产出的 messages/point_transactions，
 *      恢复 fixture 顾客等级为 NULL（与 beforeAll 起点一致）
 *
 * Schema 注（已与 5433 实际表结构核对，2026-05-17）：
 *   - messages 表使用 (recipient_type, recipient_id)，不是 recipient_user_id
 *   - point_transactions.external_ref = `member-upgrade-${userId}-${toLevel}`
 *     （uq_point_txns_external_ref 是幂等键；admin-chrome-e2e-plan.md 写的
 *      `level_upgrade_粉钻_2026` 是旧式样，最新实现见
 *      src/cron/steps/refresh-member-levels.ts L238）
 *   - member_level_benefits 当前 5 等级 couponTemplateIds 全空 → 升级不会发券
 *
 * 跑法：
 *   bunx playwright test --config=scripts/manual-e2e/playwright.manual.config.ts \
 *     link-6-member-upgrade.spec.ts --project=chromium --reporter=list
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'
const ADMIN_DIR = path.resolve(__dirname, '../..')

// ── 账号 / Fixture ───────────────────────────────────────────────────────────
const MGR_PHONE = '13900139001'
const MGR_PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'
const SKU1_NAME = '洗-无创纹身' // 缦之羽 SKU ¥100
const SKU2_NAME = '假性皱纹管家' // 其他 SKU ¥100

// 预期升级路径：当前 spend 2703.80 + ¥200 = 2903.80 ≥ 1980 → 初钻
const EXPECTED_LEVEL = '初钻'
const IDEM_KEY = `member-upgrade-${FIXTURE_USER_ID}-${EXPECTED_LEVEL}`

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')

// ── DB helper ────────────────────────────────────────────────────────────────
function psql(sql: string): string {
  try {
    return execSync(
      `PGPASSWORD=fengyu123 psql -h 47.113.202.7 -p 5433 -U fengyu -d fengyu_wxapp -t -A -c "${sql.replace(/"/g, '\\"')}"`,
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

// 跑 cron:once（spawn admin 子进程，长时跑 5 个 STEP；返回 stdout 用于日志）
//
// 实测耗时：STEP 2 refresh-member-levels 对 ~1648 个 '会员客' 做循环 spend 聚合，
// 单次跑下来 ~3.5 分钟（210s）。整体 cron:once ~3.5 分钟。timeout 给到 8 分钟兜底。
function runCronOnce(): string {
  console.log('[链路6] 触发 cron:once …(预计 3-5 分钟)')
  const t0 = Date.now()
  const out = execSync('bun run cron:once', {
    cwd: ADMIN_DIR,
    encoding: 'utf8',
    timeout: 480000, // 8 分钟
    maxBuffer: 32 * 1024 * 1024, // STEP 5 paymentInvariants 输出可达数 MB
  })
  console.log(`[链路6] cron:once 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return out
}

// ── beforeAll：重置 fixture 顾客等级到 NULL，记录基线计数 ───────────────────
let baselinePointTxnCount = 0
let baselineMessagesCount = 0
let baselineUserCouponsCount = 0

test.beforeAll(() => {
  // 重置顾客等级到 NULL（不动 sale_orders；既有 rolling-12mo spend ≈ 2700+ 仍生效）
  psql(
    `UPDATE client_wechat_users SET member_level=NULL, old_member_level=NULL, ` +
      `member_level_upgraded_at=NULL, member_level_locked_until=NULL ` +
      `WHERE user_id='${FIXTURE_USER_ID}'`,
  )
  console.log(`[链路6 setup] 已重置 fixture 顾客 ${FIXTURE_USER_ID} member_level=NULL`)

  // 预清理：删掉过去测试可能残留的同幂等键行（避免影响基线）
  psql(`DELETE FROM point_transactions WHERE external_ref='${IDEM_KEY}'`)
  psql(`DELETE FROM messages WHERE idempotency_key='${IDEM_KEY}'`)
  psql(`DELETE FROM user_coupons WHERE coupon_id LIKE 'cpn-up-${FIXTURE_USER_ID}-%'`)

  baselinePointTxnCount = parseInt(
    psql(`SELECT count(*) FROM point_transactions WHERE user_id='${FIXTURE_USER_ID}'`),
    10,
  ) || 0
  baselineMessagesCount = parseInt(
    psql(
      `SELECT count(*) FROM messages WHERE recipient_id='${FIXTURE_USER_ID}' AND recipient_type='客户'`,
    ),
    10,
  ) || 0
  baselineUserCouponsCount = parseInt(
    psql(`SELECT count(*) FROM user_coupons WHERE user_id='${FIXTURE_USER_ID}'`),
    10,
  ) || 0

  console.log(
    `[链路6 setup] 基线: point_transactions=${baselinePointTxnCount}, ` +
      `messages=${baselineMessagesCount}, user_coupons=${baselineUserCouponsCount}`,
  )
})

// ── afterAll：复位 fixture，删 cron 产出 ────────────────────────────────────
test.afterAll(() => {
  // 还原顾客等级到 NULL（与 beforeAll 起点一致）
  psql(
    `UPDATE client_wechat_users SET member_level=NULL, old_member_level=NULL, ` +
      `member_level_upgraded_at=NULL, member_level_locked_until=NULL ` +
      `WHERE user_id='${FIXTURE_USER_ID}'`,
  )

  // 删 cron 产出（幂等键唯一行）
  psql(`DELETE FROM point_transactions WHERE external_ref='${IDEM_KEY}'`)
  psql(`DELETE FROM messages WHERE idempotency_key='${IDEM_KEY}'`)
  psql(`DELETE FROM user_coupons WHERE coupon_id LIKE 'cpn-up-${FIXTURE_USER_ID}-%'`)

  // 删 cron 写的 operation_logs（target_id=user_id 且 source='cronTask'）
  psql(
    `DELETE FROM operation_logs ` +
      `WHERE target_id='${FIXTURE_USER_ID}' AND source='cronTask' ` +
      `AND action IN ('customer.memberLevelChange','customer.memberLevelHeld') ` +
      `AND created_at > NOW() - INTERVAL '1 hour'`,
  )
  console.log('[链路6 teardown] 已清理 cron 产出，复位 fixture 顾客状态为 NULL')
})

// ── 登录 ─────────────────────────────────────────────────────────────────────
async function login(page: import('@playwright/test').Page, phone: string, pass: string) {
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(400)
  await page.locator('#phone').click()
  await page.locator('#phone').pressSequentially(phone, { delay: 30 })
  await page.locator('#password').click()
  await page.locator('#password').pressSequentially(pass, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })
}

// ── 测试主体 ─────────────────────────────────────────────────────────────────

test('链路6：会员等级升级（cron 触发）', async ({ page }) => {
  // 单测整体超时：2 次 cron run × ~3.5 分钟 + UI ~1 分钟 + 缓冲 ⇒ 15 分钟
  test.setTimeout(900_000)
  ensureDir(TEST_RESULTS_DIR)

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[browser-error] ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    console.log(`[page-error] ${err.message}`)
  })

  // ──────────────────────────────────────────────────────────────────────
  // Step 0: 抓取 pre-state（rolling-12mo spend + level）
  // ──────────────────────────────────────────────────────────────────────
  const preSpend = parseFloat(
    psql(
      `SELECT COALESCE(SUM(GREATEST((received::numeric) - (refunded_amount::numeric), 0)), 0) ` +
        `FROM sale_orders WHERE client_user_id='${FIXTURE_USER_ID}' ` +
        `AND sale_order_type IN ('销售单','转换单') ` +
        `AND paid_at >= (NOW() - INTERVAL '12 months')`,
    ),
  )
  const preLevel = psql(`SELECT COALESCE(member_level::text, 'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`)
  console.log(`[链路6 Step0] pre-state: spend=${preSpend}, member_level=${preLevel}`)
  expect(preLevel).toBe('NULL')
  // 已超过初钻阈值 1980（即使本次不开新单也会触发升级；开单仅为演示 E2E 跨阈值流程）
  expect(preSpend).toBeGreaterThanOrEqual(1980)

  // ──────────────────────────────────────────────────────────────────────
  // Step 1: MGR 在 admin 端开一单（¥200）并确认收款
  //         （主要是演示「下单后 cron 推等级」E2E；亦贡献新流水）
  // ──────────────────────────────────────────────────────────────────────
  await login(page, MGR_PHONE, MGR_PASS)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-6-01-login.png` })

  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  // Step 1.1：选顾客
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

  // Step 1.2：选商品（沿用链路 1 套路 — 缦之羽 + 其他）
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

  // 加 SKU1
  const cat1Btn = page.getByRole('button', { name: '缦之羽', exact: true }).first()
  if ((await cat1Btn.count()) > 0) {
    await cat1Btn.click()
    await page.waitForTimeout(500)
  }
  let sku1Added = false
  const sku1NameEl = page.getByText(SKU1_NAME, { exact: false })
  if ((await sku1NameEl.count()) > 0) {
    const sku1Card = sku1NameEl.first().locator('..').locator('..')
    const addBtn1 = sku1Card.getByRole('button', { name: /加入/ })
    if ((await addBtn1.count()) > 0) {
      await addBtn1.click()
      sku1Added = true
    }
  }
  if (!sku1Added) {
    const allAddBtns = page.getByRole('button', { name: /加入/ })
    if ((await allAddBtns.count()) > 0) {
      await allAddBtns.first().click()
      sku1Added = true
    } else {
      throw new Error('Step 2: 页面没有"加入"按钮，无法添加商品')
    }
  }
  await page.waitForTimeout(500)

  // 加 SKU2
  const cat2Btn = page.getByRole('button', { name: '其他', exact: true })
  if ((await cat2Btn.count()) > 0) {
    await cat2Btn.click()
    await page.waitForTimeout(500)
  }
  let sku2Added = false
  const sku2NameEl = page.getByText(SKU2_NAME, { exact: false })
  if ((await sku2NameEl.count()) > 0) {
    const sku2Card = sku2NameEl.first().locator('..').locator('..')
    const addBtn2 = sku2Card.getByRole('button', { name: /加入/ })
    if ((await addBtn2.count()) > 0) {
      await addBtn2.click()
      sku2Added = true
    }
  }
  if (!sku2Added) {
    const addBtnsNow = page.getByRole('button', { name: /加入/ })
    const count2 = await addBtnsNow.count()
    if (count2 > 1) {
      await addBtnsNow.nth(1).click()
      sku2Added = true
    } else if (count2 > 0) {
      await addBtnsNow.first().click()
      sku2Added = true
    }
  }
  await page.waitForTimeout(500)
  console.log(`[链路6 Step1] sku1Added=${sku1Added} sku2Added=${sku2Added}`)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-6-02-cart.png` })

  // 下一步 → Step 3 确认订单
  const nextBtn = page.getByRole('button', { name: '下一步' })
  await expect(nextBtn).toBeEnabled({ timeout: 5000 })
  await nextBtn.click()

  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({
    timeout: 10000,
  })

  // 选线下支付
  const paymentSelects = [
    page.locator('select[name="paymentMethod"]'),
    page.locator('select').nth(0),
  ]
  for (const sel of paymentSelects) {
    if ((await sel.count()) > 0) {
      const opts = await sel.locator('option').allTextContents()
      if (opts.some((o) => o.includes('线下'))) {
        await sel.selectOption({ label: '线下支付' })
        break
      }
    }
  }

  // 提交订单
  const submitBtn = page.getByRole('button', { name: /提交订单|下一步|确认提交/ }).last()
  await expect(submitBtn).toBeEnabled({ timeout: 5000 })
  await submitBtn.click()

  // Step 4：完成 → 提取订单号 → 确认收款
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-6-03-created.png` })

  let saleOrderId = ''
  const orderIdEl = page.locator('p.font-mono, p:has-text("FY-XSD-WX")').first()
  if ((await orderIdEl.count()) > 0) {
    const text = await orderIdEl.textContent()
    const m = text?.match(/FY-XSD-WX-\d{6}\d{4}/)
    if (m) saleOrderId = m[0]
  }
  if (!saleOrderId) {
    const bodyText = await page.textContent('body')
    const m = bodyText?.match(/FY-XSD-WX-\d{6}\d{4}/)
    if (m) saleOrderId = m[0]
  }
  expect(saleOrderId).toMatch(/^FY-XSD-WX-\d{10}$/)
  console.log(`[链路6 Step1] saleOrderId = ${saleOrderId}`)

  const confirmPayBtn = page.getByRole('button', { name: '确认收款' })
  await expect(confirmPayBtn).toBeVisible({ timeout: 10000 })
  await confirmPayBtn.click()
  await expect(page.getByText(/收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({
    timeout: 15000,
  })
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-6-04-paid.png` })

  // 关键断言：order status = 已支付（cron 才会算进 spend）
  const orderStatus = psql(
    `SELECT status::text FROM sale_orders WHERE sale_order_id='${saleOrderId}'`,
  )
  expect(orderStatus).toBe('已支付')

  // ──────────────────────────────────────────────────────────────────────
  // Step 2: 触发 cron:once（STEP 1～5 串行，~5～30s）
  // ──────────────────────────────────────────────────────────────────────
  const cronOut1 = runCronOnce()
  // 期望日志里能看到 refresh-member-levels 完成（不强制 grep 关键字以兼容日志变更）
  console.log('[链路6 Step2] cron stdout 尾部:', cronOut1.slice(-300))

  // ──────────────────────────────────────────────────────────────────────
  // Step 3: DB 验证升级生效
  // ──────────────────────────────────────────────────────────────────────
  const postLevel = psql(
    `SELECT COALESCE(member_level::text, 'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`,
  )
  const postOldLevel = psql(
    `SELECT COALESCE(old_member_level::text, 'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`,
  )
  const postUpgradedAtRaw = psql(
    `SELECT COALESCE(member_level_upgraded_at::text, 'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`,
  )
  const postLockedUntilRaw = psql(
    `SELECT COALESCE(member_level_locked_until::text, 'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`,
  )
  console.log(
    `[链路6 Step3] post-state: level=${postLevel}, old=${postOldLevel}, ` +
      `upgraded_at=${postUpgradedAtRaw}, locked_until=${postLockedUntilRaw}`,
  )

  expect(postLevel).toBe(EXPECTED_LEVEL) // NULL → 初钻
  expect(postOldLevel).toBe('NULL') // 旧值是 NULL，被写入 old_member_level
  expect(postUpgradedAtRaw).not.toBe('NULL')
  expect(postLockedUntilRaw).not.toBe('NULL')

  // upgraded_at 在最近 5 分钟内
  const upgradedAt = new Date(postUpgradedAtRaw)
  const ageMs = Date.now() - upgradedAt.getTime()
  expect(ageMs).toBeGreaterThanOrEqual(0)
  expect(ageMs).toBeLessThan(5 * 60 * 1000)

  // locked_until 在 145～155 天后（实现为 +150 天）
  const lockedUntil = new Date(postLockedUntilRaw)
  const lockDeltaDays = (lockedUntil.getTime() - upgradedAt.getTime()) / 86400000
  expect(lockDeltaDays).toBeGreaterThan(145)
  expect(lockDeltaDays).toBeLessThan(155)

  // messages：幂等键唯一行
  const messagesRow = psql(
    `SELECT recipient_type::text || '|' || recipient_id || '|' || title ` +
      `FROM messages WHERE idempotency_key='${IDEM_KEY}'`,
  )
  console.log('[链路6 Step3] messages 行:', messagesRow)
  expect(messagesRow).not.toBe('')
  expect(messagesRow).toContain('客户')
  expect(messagesRow).toContain(FIXTURE_USER_ID)
  expect(messagesRow).toContain('初钻')

  // point_transactions：初钻 points=0 → 不会插入
  const ptRows = psql(
    `SELECT count(*) FROM point_transactions WHERE external_ref='${IDEM_KEY}'`,
  )
  console.log('[链路6 Step3] point_transactions 行数:', ptRows)
  expect(parseInt(ptRows, 10)).toBe(0)

  // user_coupons：初钻 couponTemplateIds=[] → 不会插入
  const couponRows = psql(
    `SELECT count(*) FROM user_coupons WHERE coupon_id LIKE 'cpn-up-${FIXTURE_USER_ID}-%'`,
  )
  console.log('[链路6 Step3] user_coupons 新增行数:', couponRows)
  expect(parseInt(couponRows, 10)).toBe(0)

  // operation_logs：customer.memberLevelChange 一条
  const oplogRow = psql(
    `SELECT count(*) FROM operation_logs ` +
      `WHERE action='customer.memberLevelChange' AND target_id='${FIXTURE_USER_ID}' ` +
      `AND source='cronTask' AND created_at > NOW() - INTERVAL '10 minutes'`,
  )
  expect(parseInt(oplogRow, 10)).toBeGreaterThanOrEqual(1)

  // ──────────────────────────────────────────────────────────────────────
  // Step 4: 幂等性 — 再跑一次 cron:once，关键计数不变
  // ──────────────────────────────────────────────────────────────────────
  const upgradedAtBefore = postUpgradedAtRaw
  const msgsCountBefore = parseInt(
    psql(`SELECT count(*) FROM messages WHERE idempotency_key='${IDEM_KEY}'`),
    10,
  )
  const ptCountBefore = parseInt(
    psql(`SELECT count(*) FROM point_transactions WHERE external_ref='${IDEM_KEY}'`),
    10,
  )
  const couponCountBefore = parseInt(
    psql(`SELECT count(*) FROM user_coupons WHERE coupon_id LIKE 'cpn-up-${FIXTURE_USER_ID}-%'`),
    10,
  )

  runCronOnce()

  const upgradedAtAfter = psql(
    `SELECT COALESCE(member_level_upgraded_at::text, 'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`,
  )
  const msgsCountAfter = parseInt(
    psql(`SELECT count(*) FROM messages WHERE idempotency_key='${IDEM_KEY}'`),
    10,
  )
  const ptCountAfter = parseInt(
    psql(`SELECT count(*) FROM point_transactions WHERE external_ref='${IDEM_KEY}'`),
    10,
  )
  const couponCountAfter = parseInt(
    psql(`SELECT count(*) FROM user_coupons WHERE coupon_id LIKE 'cpn-up-${FIXTURE_USER_ID}-%'`),
    10,
  )
  const levelAfter = psql(
    `SELECT COALESCE(member_level::text, 'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`,
  )

  console.log(
    `[链路6 Step4 幂等] level=${levelAfter}, upgraded_at 不变? ` +
      `${upgradedAtAfter === upgradedAtBefore}, ` +
      `messages=${msgsCountBefore}->${msgsCountAfter}, ` +
      `pt=${ptCountBefore}->${ptCountAfter}, ` +
      `coupon=${couponCountBefore}->${couponCountAfter}`,
  )

  // 等级保持，时间戳不变（因为 UPDATE WHERE member_level IS DISTINCT FROM 不命中）
  expect(levelAfter).toBe(EXPECTED_LEVEL)
  expect(upgradedAtAfter).toBe(upgradedAtBefore)

  // 幂等键拦截 → 0 新增
  expect(msgsCountAfter).toBe(msgsCountBefore)
  expect(ptCountAfter).toBe(ptCountBefore)
  expect(couponCountAfter).toBe(couponCountBefore)

  // ──────────────────────────────────────────────────────────────────────
  // Step 5: 清理（销售单走共享 helper；剩余 cron 产出由 afterAll 兜底）
  // ──────────────────────────────────────────────────────────────────────
  if (saleOrderId) {
    try {
      cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路6]' })
    } catch (e) {
      console.log(`[链路6] 清理 sale_order 出错（非致命）: ${e}`)
    }
  }

  console.log(`[链路6] 全部断言通过 — 升级路径 NULL → ${EXPECTED_LEVEL}，幂等 0 新增。`)
})
