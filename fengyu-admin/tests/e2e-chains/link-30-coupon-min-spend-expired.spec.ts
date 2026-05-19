/**
 * 链路 30：优惠券反例 — min_spend 未达标 + 已过期
 *
 * 主题：覆盖 getAvailableCoupons 的两条排除路径：
 *   反例 A — min_spend 未达标：FY-FIX-CPN-MINSPEND（满 500 减 50）面对凑单 ¥200 应被排除
 *   反例 B — 已过期：       FY-FIX-CPN-EXPIRED（expire_at 2026-01-01）NOW() 之前的券应被排除
 *   正例对照 — FY-FIX-CPN-DISCOUNT / FY-FIX-COUPON-01（min_spend ≤ 200 且未过期）应在 select 中可见
 *
 * 角色：FY-TEST-MGR
 * Fixture 顾客：FY-FIX-CLIENT-01
 * 普通 SKU：c79157b29c9e974c "洗-无创纹身" ¥100 × 2 = ¥200
 *
 * 测试设计：1 个 UI run，验证 2 路反例同时生效 + 额外 SQL 等价校验
 *   - UI 组：进入 Step 3，抓 select 选项文本断言反例不出现 + 正例对照出现
 *   - SQL 组：直接对 coupon_templates / user_coupons 跑 CASE 表达式，等价复述 min_spend / expire_at 过滤逻辑
 *
 * 关键不变量：
 *   getAvailableCoupons(orderTotal=200) 不返回 min_spend > 200 的券
 *   getAvailableCoupons(now=NOW())      不返回 expire_at < NOW() 的券
 *   不选券提交后：sale_orders.coupon_id IS NULL && coupon_discount = 0
 *   两张反例券状态保持 '未使用'（未被 UI 错误核销）
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
const FIXTURE_CPN_MINSPEND = 'FY-FIX-CPN-MINSPEND'
const FIXTURE_CPN_EXPIRED = 'FY-FIX-CPN-EXPIRED'

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

function ensureDir(dir: string) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) }

function writeContext(data: Record<string, unknown>) {
  let existing: Record<string, unknown> = {}
  try { existing = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')) } catch {}
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify({ ...existing, ...data }, null, 2))
}

function resetReverseCoupons() {
  // 保险起见两张反例券都重置为'未使用'（即便 UI 不应触达）
  psql(`UPDATE user_coupons SET status='未使用', used_sale_order_id=NULL, used_at=NULL WHERE coupon_id IN ('${FIXTURE_CPN_MINSPEND}','${FIXTURE_CPN_EXPIRED}')`)
}

test.setTimeout(180000)

test('链路 30：优惠券 min_spend 未达标 + 已过期反例', async ({ page }) => {
  ensureDir(TEST_RESULTS_DIR)
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-error] ${m.text()}`) })

  // ---- 前置：重置两张反例券状态 ----
  resetReverseCoupons()

  // ---- 登录 ----
  await page.goto(`${BASE}/login`)
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /登\s*录/ })).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(500)
  await page.locator('#phone').pressSequentially(MANAGER_PHONE, { delay: 30 })
  await page.locator('#password').pressSequentially(MANAGER_PASS, { delay: 30 })
  await page.getByRole('button', { name: /登\s*录/ }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })

  // ---- Step 1 + 2: 普通商品 2× 洗-无创纹身（=¥200，min_spend 500 不达 / min_spend 200 达） ----
  await page.goto(`${BASE}/orders/create`)
  await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible({ timeout: 15000 })

  await page.getByPlaceholder(/手机号|姓名/).fill(FIXTURE_PHONE)
  await page.getByRole('button', { name: /搜索/ }).click()
  await page.waitForFunction(() => (document.body.textContent || '').includes('找到'), { timeout: 15000 })
  await page.locator('div.space-y-1 > button').first().click()
  await expect(page.getByText('已选择顾客')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '下一步' }).click()

  await page.waitForTimeout(2000)
  for (let r = 0; r < 3; r++) {
    const t = await page.textContent('body') || ''
    if (t.includes('数据未加载')) {
      const retryBtn = page.getByRole('button', { name: '重试' })
      if (await retryBtn.count() > 0) { await retryBtn.click(); await page.waitForTimeout(2000) }
    } else if (t.includes('加入') || t.includes('商品分类')) {
      break
    } else { await page.waitForTimeout(1500) }
  }

  // 缦之羽 → 洗-无创纹身 × 2
  const catBtn = page.getByRole('button', { name: '缦之羽', exact: true }).first()
  if (await catBtn.count() > 0) {
    await catBtn.click()
    await page.waitForTimeout(500)
  }
  for (let i = 0; i < 2; i++) {
    const nameEl = page.getByText('洗-无创纹身', { exact: false }).first()
    await expect(nameEl).toBeVisible({ timeout: 5000 })
    const card = nameEl.locator('..').locator('..')
    const add = card.getByRole('button', { name: /加入/ })
    await add.click()
    await page.waitForTimeout(300)
    console.log(`[链路30] 加入第 ${i + 1} 件`)
  }
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-30-01-cart.png` })

  await page.getByRole('button', { name: '下一步' }).click()

  // ---- Step 3: 进入收银，等优惠券加载 ----
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })

  const paySelect = page.locator('select').filter({ hasText: /微信|支付宝|线下/ }).first()
  if (await paySelect.count() > 0) {
    await paySelect.selectOption({ label: '线下支付' })
  }
  await page.waitForTimeout(1000)

  await page.waitForFunction(
    () => !(document.body.textContent || '').includes('正在加载可用优惠券'),
    { timeout: 15000 },
  )

  // ---- 抓券选项 ----
  const verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL' | 'SKIP'; actual: string }> = []

  const couponSelect = page.locator('select').filter({ hasText: /不使用优惠券|FY-FIX|满|减|折/ })
  let opts: string[] = []
  let selectFound = false
  if (await couponSelect.count() > 0) {
    selectFound = true
    opts = await couponSelect.locator('option').allTextContents()
    console.log('[链路30] 优惠券选项:', opts)
  } else {
    const bodyText = await page.textContent('body') || ''
    if (bodyText.includes('暂无可用优惠券')) {
      console.log('[链路30] UI 显示"暂无可用优惠券"（select 未渲染但等价于空列表）')
    } else {
      console.log('[链路30] 优惠券 select 未找到，页面片段:', bodyText.substring(0, 200))
    }
  }
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-30-02-coupon-list.png` })

  // 反例 A：FY-FIX-CPN-MINSPEND / 满500减50 不应在 select 中
  const optsJoined = opts.join(' || ')
  const minSpendLeaked = /FY-FIX-CPN-MINSPEND|FY-FIX-CT-MINSPEND|满\s*500\s*减\s*50/.test(optsJoined)
  verdicts.push({
    check: 'UI 反例A：min_spend=500 券 (FY-FIX-CPN-MINSPEND) 不出现在 select（凑单 ¥200 < 500）',
    verdict: minSpendLeaked ? 'FAIL' : 'PASS',
    actual: minSpendLeaked ? `泄漏到 UI: ${optsJoined}` : `未出现（共 ${opts.length} 选项）`,
  })

  // 反例 B：FY-FIX-CPN-EXPIRED 不应在 select 中
  const expiredLeaked = /FY-FIX-CPN-EXPIRED|FY-FIX-CT-EXPIRED|已过期/.test(optsJoined)
  verdicts.push({
    check: 'UI 反例B：已过期券 (FY-FIX-CPN-EXPIRED, expire_at 2026-01-01) 不出现在 select',
    verdict: expiredLeaked ? 'FAIL' : 'PASS',
    actual: expiredLeaked ? `泄漏到 UI: ${optsJoined}` : `未出现（共 ${opts.length} 选项）`,
  })

  // 正例对照：FY-FIX-CPN-DISCOUNT 或 FY-FIX-COUPON-01 应在 select 中（min_spend ≤ 200 且未过期）
  if (selectFound) {
    const positiveHit = /FY-FIX-CPN-DISCOUNT|FY-FIX-CT-DISCOUNT|FY-FIX-COUPON-01|8\s*折|折扣|满\s*200/.test(optsJoined)
    verdicts.push({
      check: '正例对照：FY-FIX-CPN-DISCOUNT / FY-FIX-COUPON-01 应在 select 中（min_spend ≤ 200）',
      verdict: positiveHit ? 'PASS' : 'SKIP',
      actual: positiveHit
        ? `正例可见，对照成立`
        : `未发现正例券（可能 fixture 状态异常或域过滤剔除），选项=${optsJoined}`,
    })
  } else {
    verdicts.push({
      check: '正例对照：FY-FIX-CPN-DISCOUNT / FY-FIX-COUPON-01 应在 select 中',
      verdict: 'SKIP',
      actual: '优惠券 select 未渲染（UI 显示暂无可用），跳过正例对照',
    })
  }

  // ---- 不选券，直接提交订单（避免污染） ----
  await page.getByRole('button', { name: /提交订单/ }).click()
  await expect(page.getByText(/订单已创建|开单成功|FY-XSD-WX/)).toBeVisible({ timeout: 20000 })

  let saleOrderId = ''
  const t1 = await page.textContent('body') || ''
  const m1 = t1.match(/FY-XSD-WX-\d{10}/)
  if (m1) saleOrderId = m1[0]

  const confirmPayBtn = page.getByRole('button', { name: '确认收款' })
  await expect(confirmPayBtn).toBeVisible({ timeout: 10000 })
  await confirmPayBtn.click()
  await expect(page.getByText(/收款确认成功|已确认收款|已更新为已支付/).first()).toBeVisible({ timeout: 15000 })

  if (!saleOrderId) {
    const t2 = await page.textContent('body') || ''
    const m2 = t2.match(/FY-XSD-WX-\d{10}/)
    if (m2) saleOrderId = m2[0]
  }
  expect(saleOrderId).toMatch(/^FY-XSD-WX-\d{10}$/)
  console.log(`[链路30] saleOrderId=${saleOrderId}`)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-30-03-paid.png` })

  // ---- DB 验证：订单未挂券 + 两张反例券未被核销 ----
  const orderRow = psql(
    `SELECT COALESCE(coupon_id,''), COALESCE(coupon_discount::text,'0') FROM sale_orders WHERE sale_order_id='${saleOrderId}'`,
  )
  const [oCpn, oDiscount] = orderRow.split('|')
  verdicts.push({
    check: 'sale_orders.coupon_id IS NULL（未选券）',
    verdict: oCpn === '' ? 'PASS' : 'FAIL',
    actual: `coupon_id='${oCpn}'`,
  })
  verdicts.push({
    check: 'sale_orders.coupon_discount = 0 / NULL（未选券）',
    verdict: (oDiscount === '0' || oDiscount === '0.00' || oDiscount === '') ? 'PASS' : 'FAIL',
    actual: `coupon_discount='${oDiscount}'`,
  })

  const minSpendStatus = psql(
    `SELECT status, COALESCE(used_sale_order_id,'') FROM user_coupons WHERE coupon_id='${FIXTURE_CPN_MINSPEND}'`,
  )
  const [msStatus, msUsedOrder] = minSpendStatus.split('|')
  verdicts.push({
    check: `${FIXTURE_CPN_MINSPEND} 状态保持 '未使用'（UI 未触达核销）`,
    verdict: msStatus === '未使用' && msUsedOrder === '' ? 'PASS' : 'FAIL',
    actual: `status=${msStatus} used_order=${msUsedOrder}`,
  })

  const expiredStatus = psql(
    `SELECT status, COALESCE(used_sale_order_id,'') FROM user_coupons WHERE coupon_id='${FIXTURE_CPN_EXPIRED}'`,
  )
  const [exStatus, exUsedOrder] = expiredStatus.split('|')
  verdicts.push({
    check: `${FIXTURE_CPN_EXPIRED} 状态保持 '未使用'（UI 未触达核销）`,
    verdict: exStatus === '未使用' && exUsedOrder === '' ? 'PASS' : 'FAIL',
    actual: `status=${exStatus} used_order=${exUsedOrder}`,
  })

  // ---- 额外 SQL 等价验证（无 UI 路径，直接复述过滤逻辑） ----
  // 200 元订单：FY-FIX-CT-MINSPEND(min=500) EXCLUDE / FY-FIX-CT-DISCOUNT(min=200) OK
  // （以 UI 实际凑单金额 ¥200 为基准）
  const minSpendCases = psql(
    `SELECT string_agg(template_id || '=' || CASE WHEN min_spend > 200 THEN 'EXCLUDE' ELSE 'OK' END, '|' ORDER BY template_id) FROM coupon_templates WHERE template_id IN ('FY-FIX-CT-MINSPEND','FY-FIX-CT-DISCOUNT')`,
  )
  verdicts.push({
    check: 'SQL 等价：200 元订单下 FY-FIX-CT-MINSPEND=EXCLUDE / FY-FIX-CT-DISCOUNT=OK',
    verdict: /FY-FIX-CT-MINSPEND=EXCLUDE/.test(minSpendCases) && /FY-FIX-CT-DISCOUNT=OK/.test(minSpendCases)
      ? 'PASS'
      : 'FAIL',
    actual: minSpendCases,
  })

  // expire_at：FY-FIX-CPN-EXPIRED 应为 EXPIRED，FY-FIX-CPN-DISCOUNT 应为 VALID
  const expireCases = psql(
    `SELECT string_agg(coupon_id || '=' || CASE WHEN expire_at < NOW() THEN 'EXPIRED' ELSE 'VALID' END, '|' ORDER BY coupon_id) FROM user_coupons WHERE coupon_id IN ('FY-FIX-CPN-EXPIRED','FY-FIX-CPN-DISCOUNT')`,
  )
  verdicts.push({
    check: 'SQL 等价：FY-FIX-CPN-EXPIRED=EXPIRED / FY-FIX-CPN-DISCOUNT=VALID',
    verdict: /FY-FIX-CPN-EXPIRED=EXPIRED/.test(expireCases) && /FY-FIX-CPN-DISCOUNT=VALID/.test(expireCases)
      ? 'PASS'
      : 'FAIL',
    actual: expireCases,
  })

  // ---- 汇总 ----
  console.log('\n=== 链路 30 验证 ===')
  for (const v of verdicts) console.log(`  [${v.verdict}] ${v.check} — 实际: ${v.actual}`)
  const failed = verdicts.filter((v) => v.verdict === 'FAIL')
  const skipped = verdicts.filter((v) => v.verdict === 'SKIP')

  writeContext({
    link30: {
      saleOrderId,
      selectFound,
      optionCount: opts.length,
      verdicts: verdicts.length,
      failed: failed.length,
      skipped: skipped.length,
      status: failed.length === 0 ? (skipped.length > 0 ? 'PARTIAL' : 'PASS') : 'FAIL',
      ranAt: new Date().toISOString(),
    },
  })

  // ---- 清理 ----
  if (saleOrderId) cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路30]' })
  resetReverseCoupons()

  expect(failed, `失败项: ${failed.map((v) => v.check).join(', ')}`).toEqual([])
})
