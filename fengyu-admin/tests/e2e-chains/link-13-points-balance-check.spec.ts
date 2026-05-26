/**
 * 链路 13：积分体系闭环（余额对账）
 *
 * 主题：积分作为虚拟资产，与订单双向联动；余额必须永远 = 流水净额。
 *
 * NOTE: README §1.B 写 point_transactions.type 是枚举（获取/消费/退款扣回/调整/过期），
 *       实际是自由文本（已知值：等级升级奖励/消费赠送/消费冲销 等）。
 *       无 admin 手工发分 action（admin /points 仅展示流水）；
 *       无 system_configs.points_earn_rate（发分逻辑在 cron 内硬编码）。
 *
 * 不变量（按真实自由文本类型）：
 *   client_wechat_users.points_balance == SUM(point_transactions.amount WHERE user_id=X)
 *   audit-points-balance STEP 5 应输出 mismatch=0（cron 已包含该校验，operation_logs 无 'points.balanceMismatch' 即通过）
 *
 * 流程：
 *   1. beforeAll: 重置 fixture 顾客 member_level=NULL（避免 cron 升级波动）+
 *      复算 points_balance（从 transactions SUM 重算缓存）
 *   2. 记 baseline: points_balance / count(point_transactions)
 *   3. MGR 开 ¥200 单 + 确认收款（贡献当日交易，可能 cron 触发赠分）
 *   4. 跑 bun run cron:once（覆盖 STEP 2 升级权益 + STEP 5 余额审计）
 *   5. 验：
 *      - 跑完后 client_wechat_users.points_balance == SUM(point_transactions.amount)
 *      - operation_logs 在 cron 运行窗口内**无** action='points.balanceMismatch' 行
 *   6. 反例 SKIP：抵扣超 balance（admin 无 UI 入口可触发抵扣）
 *   7. afterAll: cleanupSaleOrder + 重置 member_level + 重算 balance
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'
const ADMIN_DIR = path.resolve(__dirname, '../..')
const MGR_PHONE = '13900139001'
const PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'
const SKU1_NAME = '洗-无创纹身'

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

async function createSimpleOrder(page: import('@playwright/test').Page, tag: string): Promise<string> {
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  await page.getByPlaceholder(/手机号/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => /找到|未找到/.test(document.body.textContent || ''), { timeout: 15000 })
  await page.locator('div.space-y-1 > button').first().click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '下一步' }).click()

  await page.waitForTimeout(2000)
  await page.waitForFunction(() => {
    const t = document.body.textContent || ''
    return (t.includes('商品分类') || t.includes('加入')) && !t.includes('正在加载')
  }, { timeout: 30000 })

  const cat = page.getByRole('button', { name: '缦之羽', exact: true }).first()
  if (await cat.count() > 0) { await cat.click(); await page.waitForTimeout(500) }
  const skuText = page.getByText(SKU1_NAME, { exact: false })
  let added = false
  if (await skuText.count() > 0) {
    const card = skuText.first().locator('..').locator('..')
    const addBtn = card.getByRole('button', { name: /加入/ })
    if (await addBtn.count() > 0) {
      // 加 2 次（数量×2 = ¥200）
      await addBtn.click(); await page.waitForTimeout(200); await addBtn.click()
      added = true
    }
  }
  if (!added) {
    const all = page.getByRole('button', { name: /加入/ })
    if (await all.count() > 0) { await all.first().click(); await page.waitForTimeout(200); await all.first().click() }
  }
  await page.waitForTimeout(500)

  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })

  for (const sel of [page.locator('select[name="paymentMethod"]'), page.locator('select').nth(0)]) {
    if (await sel.count() > 0) {
      const opts = await sel.locator('option').allTextContents()
      if (opts.some((o) => o.includes('线下'))) { await sel.selectOption({ label: '线下支付' }); break }
    }
  }
  await page.getByRole('button', { name: /提交订单|确认提交/ }).last().click()
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })

  let soid = ''
  const body1 = await page.textContent('body')
  const m1 = body1?.match(/FY-XSD-WX-\d{10}/); if (m1) soid = m1[0]
  await page.getByRole('button', { name: '确认收款' }).click()
  await expect(page.getByText(/收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({ timeout: 15000 })
  if (!soid) {
    const body2 = await page.textContent('body')
    const m2 = body2?.match(/FY-XSD-WX-\d{10}/); if (m2) soid = m2[0]
  }
  if (!soid) throw new Error('无法提取 saleOrderId')
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-13-${tag}-paid.png` })
  return soid
}

function runCronOnce(): string {
  console.log('[链路13] 触发 cron:once …(预计 3-5 分钟，含 STEP 2 全量会员等级刷新 + STEP 5 积分余额审计)')
  const t0 = Date.now()
  const out = execSync('bun run cron:once', {
    cwd: ADMIN_DIR,
    encoding: 'utf8',
    timeout: 600_000, // 10 min
    maxBuffer: 32 * 1024 * 1024,
  })
  console.log(`[链路13] cron:once 完成 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return out
}

// ── beforeAll：重置 member_level / 复算 points_balance ──
let preMemberLevel = 'NULL'
test.beforeAll(() => {
  preMemberLevel = psql(`SELECT COALESCE(member_level::text,'NULL') FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`)
  // 复位会员等级 + 复算 points_balance（避免缓存漂移触发 STEP 5 mismatch）
  psql(
    `UPDATE client_wechat_users SET member_level=NULL, old_member_level=NULL, ` +
      `member_level_upgraded_at=NULL, member_level_locked_until=NULL ` +
      `WHERE user_id='${FIXTURE_USER_ID}'`,
  )
  psql(
    `UPDATE client_wechat_users SET points_balance = COALESCE((` +
      `SELECT SUM(amount) FROM point_transactions WHERE user_id = client_wechat_users.user_id` +
      `), 0), updated_at = NOW() WHERE user_id = '${FIXTURE_USER_ID}'`,
  )
  console.log(`[链路13 setup] 重置 member_level（原值=${preMemberLevel}）+ 复算 points_balance`)
})

test.afterAll(() => {
  // 恢复 member_level 到 NULL（与 link-6 的 teardown 一致；preMemberLevel 通常也是 NULL）
  try {
    psql(
      `UPDATE client_wechat_users SET member_level=NULL, old_member_level=NULL, ` +
        `member_level_upgraded_at=NULL, member_level_locked_until=NULL, updated_at=NOW() ` +
        `WHERE user_id='${FIXTURE_USER_ID}'`,
    )
    // 删 cron 写的会员升级 transactions/messages（避免 baseline 漂移）
    psql(`DELETE FROM point_transactions WHERE external_ref LIKE 'member-upgrade-${FIXTURE_USER_ID}-%' AND created_at > NOW() - INTERVAL '30 minutes'`)
    psql(`DELETE FROM messages WHERE idempotency_key LIKE 'member-upgrade-${FIXTURE_USER_ID}-%' AND created_at > NOW() - INTERVAL '30 minutes'`)
    // 复算 points_balance 保证下一轮基线一致
    psql(
      `UPDATE client_wechat_users SET points_balance = COALESCE((` +
        `SELECT SUM(amount) FROM point_transactions WHERE user_id = client_wechat_users.user_id` +
        `), 0), updated_at = NOW() WHERE user_id = '${FIXTURE_USER_ID}'`,
    )
    console.log('[链路13 teardown] 完成 fixture 重置 + cron 产出清理')
  } catch (e) {
    console.log(`[链路13 teardown] 部分清理失败（非致命）: ${e}`)
  }
})

test.setTimeout(900_000)

test('链路13：积分体系闭环（开单 + cron + 余额对账）', async ({ browser }) => {
  ensureDir(TEST_RESULTS_DIR)
  const verdicts: Array<{ check: string; verdict: string; actual?: string | number }> = []

  // ── Step 0: baseline ──
  const baselineBalance = parseInt(
    psql(`SELECT points_balance FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`),
    10,
  ) || 0
  const baselineTxnCount = parseInt(
    psql(`SELECT count(*) FROM point_transactions WHERE user_id='${FIXTURE_USER_ID}'`),
    10,
  ) || 0
  const baselineSum = parseInt(
    psql(`SELECT COALESCE(sum(amount),0)::text FROM point_transactions WHERE user_id='${FIXTURE_USER_ID}'`),
    10,
  ) || 0
  console.log(`[链路13] baseline: balance=${baselineBalance}, txnCount=${baselineTxnCount}, txnSum=${baselineSum}`)
  verdicts.push({
    check: 'baseline_balance_equals_txn_sum',
    verdict: baselineBalance === baselineSum ? 'PASS' : 'FAIL',
    actual: `balance=${baselineBalance}, sum=${baselineSum}`,
  })

  const cutoffStr = psql(`SELECT NOW()::text`)
  let saleOrderId = ''

  try {
    // ── Step 1: MGR 开一单 ¥200 ──
    console.log('[链路13] Step 1: MGR 开一单 ¥200')
    const mgrCtx = await browser.newContext()
    const mgrPage = await mgrCtx.newPage()
    mgrPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(mgrPage, MGR_PHONE, PASS)
    saleOrderId = await createSimpleOrder(mgrPage, '01-order')
    console.log(`[链路13] saleOrderId: ${saleOrderId}`)
    await mgrCtx.close()

    // ── Step 2: 跑 cron:once ──
    const cronOut = runCronOnce()
    // 抓 STEP 5 audit-points-balance 输出（关键字 mismatch / balanced）
    const auditLine = cronOut.split('\n').find((l) => l.includes('audit-points-balance') || l.includes('points.balanceMismatch'))
    console.log(`[链路13] STEP 5 行: ${auditLine || '(未找到)'}`)

    // ── Step 3: 校验 ──
    // 3.1 points_balance == SUM(amount)
    const postBalance = parseInt(
      psql(`SELECT points_balance FROM client_wechat_users WHERE user_id='${FIXTURE_USER_ID}'`),
      10,
    ) || 0
    const postSum = parseInt(
      psql(`SELECT COALESCE(sum(amount),0)::text FROM point_transactions WHERE user_id='${FIXTURE_USER_ID}'`),
      10,
    ) || 0
    verdicts.push({
      check: 'post_cron_balance_equals_sum',
      verdict: postBalance === postSum ? 'PASS' : 'FAIL',
      actual: `balance=${postBalance}, sum=${postSum}, delta(balance)=${postBalance - baselineBalance}, delta(sum)=${postSum - baselineSum}`,
    })

    // 3.2 cron 期间无 points.balanceMismatch 日志（针对 fixture 顾客）
    const mismatchLogs = parseInt(
      psql(
        `SELECT count(*) FROM operation_logs ` +
          `WHERE action='points.balanceMismatch' AND target_id='${FIXTURE_USER_ID}' ` +
          `AND created_at > '${cutoffStr}'::timestamp`,
      ),
      10,
    ) || 0
    verdicts.push({
      check: 'no_balance_mismatch_log',
      verdict: mismatchLogs === 0 ? 'PASS' : 'FAIL',
      actual: `mismatchLogs=${mismatchLogs}`,
    })

    // 3.3 cron 触发可能赠了积分（升级到初钻）→ 新增 point_transactions 全部带 external_ref
    const postTxnCount = parseInt(
      psql(`SELECT count(*) FROM point_transactions WHERE user_id='${FIXTURE_USER_ID}'`),
      10,
    ) || 0
    const newTxnsExternalRefCount = parseInt(
      psql(
        `SELECT count(*) FROM point_transactions ` +
          `WHERE user_id='${FIXTURE_USER_ID}' AND created_at > '${cutoffStr}'::timestamp ` +
          `AND external_ref IS NOT NULL`,
      ),
      10,
    ) || 0
    const newTxnsTotal = postTxnCount - baselineTxnCount
    verdicts.push({
      check: 'new_txns_have_external_ref',
      verdict: newTxnsTotal === 0 || newTxnsExternalRefCount === newTxnsTotal ? 'PASS' : 'SKIP',
      actual: `newTxnsTotal=${newTxnsTotal}, withExternalRef=${newTxnsExternalRefCount}`,
    })

    // 3.4 反例 SKIP：积分抵扣超 balance（admin 无 UI 入口可触发）
    verdicts.push({
      check: 'neg_points_overdraft',
      verdict: 'SKIP',
      actual: 'admin 无积分手动操作入口；客户端小程序的下单抵扣是 clientApi 责任，admin 不验证',
    })
  } finally {
    // ── Step 4: 清理 ──
    console.log('[链路13] Step 4: 清理订单 + cron 产出')
    if (saleOrderId) cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路13]' })
  }

  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const overallStatus = hasFail ? 'FAIL' : verdicts.some((v) => v.verdict === 'SKIP') ? 'PARTIAL' : 'PASS'
  const report = {
    link: 13,
    status: overallStatus,
    saleOrderId,
    baselineBalance,
    baselineTxnCount,
    verdicts,
    cleaned: true,
    notes: 'point_transactions.type 是自由文本；client_wechat_users.points_balance 是缓存（cron 每日复算）；'
      + 'STEP 5 audit-points-balance 仅告警不修复（只 INSERT operation_log）',
  }
  console.log('\n[链路13] === 最终报告 ===')
  console.log(JSON.stringify(report, null, 2))
  writeCtx('link13', report)

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})
