/**
 * 链路 17：数据看板三角色聚合一致性
 *
 * 主题：同一时段，admin / 市场 manager / 门店 manager 在 /dashboard 看到的
 *      "今日业绩"应满足包含关系（admin ≥ market ≥ store）；
 *      当 store-nc01 是仅有的有营业额的店时，三角色看到的数值应完全相等。
 *
 * NOTE: README §1.B 写"URL ?storeFilter=别店"反例；/dashboard 实际无 storeFilter URL 入参
 *       （scope 全部由 server-side session 自动注入），所以越权反例 SKIP。
 *
 * 实现路径：
 *   1. MGR 在 store-nc01 开一单 ¥100，确认收款（贡献当日营业额）
 *   2. 3 个 browser.newContext() 分别以 ADM/MKT/MGR 登录 /dashboard
 *   3. 抓"今日业绩"卡片的金额数字（¥xxx）
 *   4. 校验：
 *      - admin ≥ market ≥ store（包含关系）
 *      - SQL 对账：store-nc01 当日 SUM(received - refunded_amount) 与 store 角色数字一致
 *   5. 清理：cleanupSaleOrder
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = process.env.ADMIN_BASE_URL || 'http://localhost:3000'
const ADM_PHONE = '13900139000'
const MKT_PHONE = '13900139006'
const MGR_PHONE = '13900139001'
const PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const SKU1_NAME = '洗-无创纹身'

const TEST_RESULTS_DIR = path.resolve(__dirname, '../../test-results')
const CONTEXT_FILE = path.resolve(__dirname, './.last-test-context.json')

function ensureDir(d: string) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) }

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

/** 从 dashboard 页抓"今日业绩"卡片金额数字（去除 ¥, 千分位） */
async function readTodayRevenue(page: import('@playwright/test').Page, tag: string): Promise<number> {
  await page.goto(`${BASE}/dashboard`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-17-${tag}-dashboard.png` })

  // 业务角色（manager/finance）显示"今日业绩"卡片；admin/hr/product 显示统计类卡片不一定有"今日业绩"
  // 用 getByText 找文本 → 取其同级/邻近的金额数字
  const bodyText = await page.textContent('body')
  if (!bodyText) return 0

  // 找 "今日业绩" 旁边的 ¥xxx 数字
  // 优先：用 locator 找 .text-2xl.font-bold 兄弟节点
  try {
    const labelEl = page.getByText('今日业绩', { exact: true }).first()
    if (await labelEl.count() > 0) {
      // 找包含该 label 的 Card → 找 Card 内的 .text-2xl
      const card = labelEl.locator('xpath=ancestor::*[contains(@class,"Card") or self::div][1]').first()
      // 通用 fallback：找该 label 下方的 .text-2xl.font-bold
      const valueEl = card.locator('p.text-2xl.font-bold').first()
      if (await valueEl.count() > 0) {
        const valText = await valueEl.textContent()
        const cleaned = valText?.replace(/[¥,\s]/g, '') || '0'
        const n = parseFloat(cleaned) || 0
        console.log(`[链路17/${tag}] 今日业绩 = ${valText} → ${n}`)
        return n
      }
    }
  } catch {/* fallback */}

  // 降级：从 bodyText 找 ¥xxx 紧邻"今日业绩"的数字
  const m = bodyText.match(/今日业绩[\s\S]{0,80}?¥\s*([\d,]+(?:\.\d+)?)/)
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, '')) || 0
    console.log(`[链路17/${tag}] 今日业绩（降级）= ¥${m[1]} → ${n}`)
    return n
  }

  // admin/hr/product 角色可能没有"今日业绩"卡，返回 -1 表示 N/A
  console.log(`[链路17/${tag}] 未找到"今日业绩"卡片`)
  return -1
}

/** 简单开单 ¥100 + 确认收款 */
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
    if (await addBtn.count() > 0) { await addBtn.click(); added = true }
  }
  if (!added) {
    const all = page.getByRole('button', { name: /加入/ })
    if (await all.count() > 0) { await all.first().click() }
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
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-17-${tag}-paid.png` })
  return soid
}

test.setTimeout(300_000)

test('链路17：数据看板三角色聚合一致性', async ({ browser }) => {
  ensureDir(TEST_RESULTS_DIR)
  const verdicts: Array<{ check: string; verdict: string; actual?: string | number }> = []

  let saleOrderId = ''

  // ── Step 0: 预清理 — 删除 fixture 顾客残留的 待支付 订单 ──
  // createOrder 内有 D1 守卫："该顾客已有待支付订单 X，请先关闭后再创建新订单"
  // 上一轮测试若在 saleOrderId 解析前异常退出，会留下孤儿 待支付 行阻塞本轮 Step 1。
  // 必须在登录前直 SQL 清理（spec 自身无法靠 UI 关闭因为它还没拿到 orderId）。
  const orphanIdsRaw = psql(
    `SELECT sale_order_id FROM sale_orders WHERE client_user_id='FY-FIX-CLIENT-01' AND status='待支付' AND sale_order_type IN ('销售单','转换单')`,
  )
  const orphanIds = orphanIdsRaw.split('\n').map((s) => s.trim()).filter(Boolean)
  for (const oid of orphanIds) {
    console.log(`[链路17/preclean] 清理残留 待支付 订单 ${oid}`)
    cleanupSaleOrder(oid, psql, { logPrefix: '[链路17/preclean]' })
  }

  // ── Step 1: MGR 开一单 ¥100 贡献当日营业额 ──
  console.log('[链路17] Step 1: MGR 开一单贡献当日营业额')
  const mgrSetupCtx = await browser.newContext()
  const mgrSetupPage = await mgrSetupCtx.newPage()
  mgrSetupPage.on('console', (m) => { if (m.type() === 'error') console.log(`[mgr-setup-err] ${m.text()}`) })
  await login(mgrSetupPage, MGR_PHONE, PASS)
  saleOrderId = await createSimpleOrder(mgrSetupPage, '01-setup')
  console.log(`[链路17] saleOrderId: ${saleOrderId}`)
  await mgrSetupCtx.close()

  try {
    // ── Step 2: 3 角色并行读 dashboard ──
    console.log('[链路17] Step 2: 三角色并行读 dashboard')
    const ctxAdm = await browser.newContext()
    const ctxMkt = await browser.newContext()
    const ctxMgr = await browser.newContext()
    const pAdm = await ctxAdm.newPage()
    const pMkt = await ctxMkt.newPage()
    const pMgr = await ctxMgr.newPage()
    for (const p of [pAdm, pMkt, pMgr]) {
      p.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    }

    await Promise.all([
      login(pAdm, ADM_PHONE, PASS),
      login(pMkt, MKT_PHONE, PASS),
      login(pMgr, MGR_PHONE, PASS),
    ])

    const [admRev, mktRev, mgrRev] = await Promise.all([
      readTodayRevenue(pAdm, '02-adm'),
      readTodayRevenue(pMkt, '03-mkt'),
      readTodayRevenue(pMgr, '04-mgr'),
    ])
    console.log(`[链路17] revenue: admin=${admRev} market=${mktRev} store=${mgrRev}`)

    // SQL 直查 store-nc01 今日 received - refunded_amount（管理员视角下的应见数字）
    // 与 getDashboardStats (src/actions/dashboard.ts:83-143) 完全对齐：
    //   - paid_at::date（库存北京墙钟字面，直接取日期；与 NOW() 的北京今天比较）
    //   - status IN ('已支付','已完成')（不含'部分支付'）
    //   - sale_order_type IN ('销售单','转换单')
    const dbStoreRevenue = parseFloat(psql(
      `SELECT COALESCE(SUM(received::numeric - refunded_amount::numeric), 0)::text ` +
        `FROM sale_orders ` +
        `WHERE store_id='store-nc01' ` +
        `AND paid_at::date = (NOW() AT TIME ZONE 'Asia/Shanghai')::date ` +
        `AND sale_order_type IN ('销售单','转换单') AND status IN ('已支付','已完成')`,
    )) || 0
    console.log(`[链路17] SQL: store-nc01 当日 SUM(received-refunded)=${dbStoreRevenue}`)

    // ── Step 3: 校验包含关系 ──
    // 注：admin 角色可能展示的是 admin 看板（roleContext='admin'）而非业务看板，未必有"今日业绩"卡。
    // 若 admin 抓不到（返回 -1），SKIP 该项断言但保留 market/store 比对
    const adminBusinessCard = admRev >= 0
    verdicts.push({
      check: 'admin_dashboard_has_today_revenue',
      verdict: adminBusinessCard ? 'PASS' : 'SKIP',
      actual: `admin todayRevenue = ${admRev}（-1 表示 admin roleContext 不渲染该卡片）`,
    })

    if (adminBusinessCard) {
      verdicts.push({
        check: 'admin_ge_market',
        verdict: admRev >= mktRev ? 'PASS' : 'FAIL',
        actual: `${admRev} >= ${mktRev}`,
      })
    } else {
      verdicts.push({ check: 'admin_ge_market', verdict: 'SKIP', actual: 'admin 无业务看板卡' })
    }

    verdicts.push({
      check: 'market_ge_store',
      verdict: mktRev >= mgrRev ? 'PASS' : 'FAIL',
      actual: `${mktRev} >= ${mgrRev}`,
    })

    // ── Step 4: store 角色数字 ≈ SQL 直查（容差 ±0.5） ──
    verdicts.push({
      check: 'store_role_matches_sql',
      verdict: Math.abs(mgrRev - dbStoreRevenue) < 0.5 ? 'PASS' : 'FAIL',
      actual: `mgrRev=${mgrRev}, dbStoreRevenue=${dbStoreRevenue}, diff=${(mgrRev - dbStoreRevenue).toFixed(2)}`,
    })

    // ── Step 5: 反例 SKIP — store 角色 URL 越权（dashboard 无 storeFilter 入参） ──
    verdicts.push({
      check: 'neg_url_storeFilter_bypass',
      verdict: 'SKIP',
      actual: 'admin /dashboard 无 storeFilter URL 入参；getDashboardStats 全靠 session.scopeStoreIds 决定可见范围',
    })

    await ctxAdm.close()
    await ctxMkt.close()
    await ctxMgr.close()
  } finally {
    // ── 清理 ──
    if (saleOrderId) cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路17]' })
  }

  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const overallStatus = hasFail ? 'FAIL' : verdicts.some((v) => v.verdict === 'SKIP') ? 'PARTIAL' : 'PASS'
  const report = {
    link: 17,
    status: overallStatus,
    saleOrderId,
    verdicts,
    cleaned: true,
    notes: 'dashboard scope 全由 session 注入；admin 看板与业务看板字段不同（roleContext 区分）',
  }
  console.log('\n[链路17] === 最终报告 ===')
  console.log(JSON.stringify(report, null, 2))
  writeCtx('link17', report)

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})
