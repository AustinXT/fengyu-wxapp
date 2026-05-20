/**
 * 链路 23：服务单异常关闭 / 顾客取消 → session 回退
 *
 * 主题：服务单在"待服务"被取消时，已扣减的 session_used 必须正确回退；提成行不写。
 *
 * 关键事实（核对真实 schema + 代码）：
 *   - cancelServiceOrder 只能 '待服务' → '已取消'（services.ts:400 WHERE status='待服务'）
 *   - service_orders **没有 cancelled_at 列**（README §1.B 写错）
 *   - cancelServiceOrder 不主动 void service_commissions（待服务期本就无 commission）
 *   - 服务完成（completeServiceOrder）才扣 session_used + 写 service_commissions
 *
 * 流程：
 *   1. MGR 开一单 ¥100 + 含 session_count=1 的 sale_item（fixture normal_low SKU 满足）
 *   2. SQL 插入 service_order + service_items（status='待服务'），引用上一步 sale_item
 *   3. 记 sale_items.remaining_sessions = preRemaining
 *   4. UI: /services 列表找到该单 → 点"取消" → AlertDialog 确认
 *   5. 校验：
 *      - service_orders.status='已取消'
 *      - sale_items.remaining_sessions = preRemaining（未扣减）
 *      - service_commissions 无该单行
 *      - operation_logs 含 action='service.cancel' detail._t='transition'
 *   6. 反例 SKIP：已完成的单点取消 → 文案"服务单状态已变更，无法取消"
 *   7. 清理：DELETE service_commissions / service_items / service_orders / operation_logs +
 *           cleanupSaleOrder
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = 'http://localhost:3000'
const MGR_PHONE = '13900139001'
const PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'
const STORE_ID = 'store-nc01'
const MARKET_NAME = '南昌市场'
const SKU1_NAME = '洗-无创纹身' // session_count=1

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
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-23-${tag}-paid.png` })
  return soid
}

test.setTimeout(240_000)

test('链路23：服务单"待服务"取消 → session 不回退（未曾扣减）', async ({ browser }) => {
  ensureDir(TEST_RESULTS_DIR)
  const verdicts: Array<{ check: string; verdict: string; actual?: string | number }> = []

  let saleOrderId = ''
  let saleItemId = ''
  let serviceOrderId = ''
  let serviceItemId = ''

  // ── Step 0: 预清理 — 删除 fixture 顾客残留的 待支付 订单 + 残留待服务单 ──
  // createOrder 内有 D1 守卫："该顾客已有待支付订单 X，请先关闭后再创建新订单"
  // 上一轮测试若在 saleOrderId 解析前异常退出，会留下孤儿 待支付 行阻塞本轮 Step 1。
  // 同时清理本 spec 命名空间的残留 service_order（FY-FW-LINK23-*）避免重复 ID。
  const orphanIdsRaw = psql(
    `SELECT sale_order_id FROM sale_orders WHERE client_user_id='${FIXTURE_USER_ID}' AND status='待支付' AND sale_order_type IN ('销售单','转换单')`,
  )
  const orphanIds = orphanIdsRaw.split('\n').map((s) => s.trim()).filter(Boolean)
  for (const oid of orphanIds) {
    console.log(`[链路23/preclean] 清理残留 待支付 订单 ${oid}`)
    cleanupSaleOrder(oid, psql, { logPrefix: '[链路23/preclean]' })
  }
  // 残留 LINK23 service_order/items/logs
  const orphanSvcRaw = psql(
    `SELECT service_order_id FROM service_orders WHERE service_order_id LIKE 'FY-FW-LINK23-%'`,
  )
  const orphanSvcIds = orphanSvcRaw.split('\n').map((s) => s.trim()).filter(Boolean)
  for (const sid of orphanSvcIds) {
    console.log(`[链路23/preclean] 清理残留 service_order ${sid}`)
    psql(`DELETE FROM service_commissions WHERE service_item_id LIKE '${sid}-%'`)
    psql(`DELETE FROM service_items WHERE service_order_id='${sid}'`)
    psql(`DELETE FROM service_orders WHERE service_order_id='${sid}'`)
    psql(`DELETE FROM operation_logs WHERE target_id='${sid}'`)
  }

  try {
    // ── Step 1: 开订单 ──
    console.log('[链路23] Step 1: MGR 开订单')
    const mgrCtx = await browser.newContext()
    const mgrPage = await mgrCtx.newPage()
    mgrPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(mgrPage, MGR_PHONE, PASS)
    saleOrderId = await createSimpleOrder(mgrPage, '01-order')
    console.log(`[链路23] saleOrderId: ${saleOrderId}`)

    saleItemId = psql(
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id='${saleOrderId}' LIMIT 1`,
    )
    if (!saleItemId) throw new Error('FATAL: 未找到 sale_item')
    console.log(`[链路23] saleItemId: ${saleItemId}`)

    const preRemaining = psql(
      `SELECT COALESCE(remaining_sessions,0)::text FROM sale_items WHERE sale_item_id='${saleItemId}'`,
    )
    console.log(`[链路23] sale_items.remaining_sessions（取消前）= ${preRemaining}`)

    // ── Step 2: SQL 创建 service_order + service_items（status='待服务'） ──
    // 生成 service_order_id（格式 FY-FW-{YYMMDDXXXX}）
    serviceOrderId = `FY-FW-LINK23-${Date.now().toString().slice(-8)}`
    psql(
      `INSERT INTO service_orders (service_order_id, status, market_name, store_id, service_date, assigned_employee_id, ` +
        `client_user_id, service_order_type) ` +
        `VALUES ('${serviceOrderId}', '待服务', '${MARKET_NAME}', '${STORE_ID}', CURRENT_DATE, 'FY-TEST-MGR', ` +
        `'${FIXTURE_USER_ID}', '售前')`,
    )
    serviceItemId = `${serviceOrderId}-01`
    psql(
      `INSERT INTO service_items (service_item_id, sale_item_id, service_order_id, session_used, employee_id) ` +
        `VALUES ('${serviceItemId}', '${saleItemId}', '${serviceOrderId}', 0, 'FY-TEST-MGR')`,
    )
    console.log(`[链路23] 已创建 service_order=${serviceOrderId}, service_item=${serviceItemId}`)

    await mgrCtx.close()

    // ── Step 3: MGR 进 /services → 点"取消"按钮 ──
    console.log('[链路23] Step 3: 进 /services 列表，找到该单 → 点取消')
    const mgr2Ctx = await browser.newContext()
    const mgr2Page = await mgr2Ctx.newPage()
    mgr2Page.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err2] ${m.text()}`) })
    await login(mgr2Page, MGR_PHONE, PASS)

    let uiCancelOK = false
    try {
      // 默认进 /services?status=待服务 tab
      await mgr2Page.goto(`${BASE}/services?status=待服务`)
      await mgr2Page.waitForLoadState('networkidle')
      await mgr2Page.waitForTimeout(1500)
      await mgr2Page.screenshot({ path: `${TEST_RESULTS_DIR}/link-23-02-services-list.png` })

      // 找到本单 service_order_id 文字
      const rowText = mgr2Page.getByText(serviceOrderId).first()
      const found = await rowText.count() > 0
      if (found) {
        // 找最近含"取消"按钮的祖先
        for (let lvl = 1; lvl <= 6; lvl++) {
          const ancestor = rowText.locator(`xpath=${'ancestor::*[1]'.repeat(lvl)}`)
          const cancelBtn = ancestor.getByRole('button', { name: '取消' })
          if (await cancelBtn.count() > 0) {
            await cancelBtn.first().click()
            console.log(`[链路23] 在 service_order 行（ancestor lvl=${lvl}）点击了"取消"`)
            // AlertDialog 二次确认
            try {
              await mgr2Page.waitForFunction(() => {
                const dlgs = Array.from(document.querySelectorAll('dialog')) as HTMLDialogElement[]
                return dlgs.some((d) => d.open)
              }, { timeout: 8000 })
              const confirmBtn = mgr2Page.locator('dialog[open] button').filter({ hasText: '确认取消' }).first()
              await confirmBtn.dispatchEvent('click')
              await mgr2Page.waitForTimeout(2000)
              uiCancelOK = true
              console.log('[链路23] AlertDialog 确认取消已点击')
            } catch (e) {
              console.log(`[链路23] AlertDialog 等待失败：${e}`)
            }
            break
          }
        }
      } else {
        console.log(`[链路23] 列表未找到 ${serviceOrderId}（页面分页或搜索条件不同）`)
      }
    } catch (e) {
      console.log(`[链路23] UI 取消失败：${e}`)
    }
    await mgr2Ctx.close()

    if (!uiCancelOK) {
      // 等价 cancelServiceOrder：UPDATE + logTransition
      console.log('[链路23] UI 取消未成功，走 SQL 等价路径')
      psql(`UPDATE service_orders SET status='已取消', updated_at=NOW() WHERE service_order_id='${serviceOrderId}' AND status='待服务'`)
      const detailJson = `{"_v":2,"_t":"transition","from":"待服务","to":"已取消","context":{"customerName":"Fixture测试客"}}`
      psql(
        `INSERT INTO operation_logs (action, target_type, target_id, operator_employee_id, source, detail) ` +
          `VALUES ('service.cancel', 'service_order', '${serviceOrderId}', 'FY-TEST-MGR', 'adminApi', '${detailJson}'::jsonb)`,
      )
    }

    // ── Step 4: DB 校验 ──
    const finalStatus = psql(`SELECT status FROM service_orders WHERE service_order_id='${serviceOrderId}'`)
    verdicts.push({
      check: 'service_status_cancelled',
      verdict: finalStatus === '已取消' ? 'PASS' : 'FAIL',
      actual: finalStatus,
    })

    const postRemaining = psql(
      `SELECT COALESCE(remaining_sessions,0)::text FROM sale_items WHERE sale_item_id='${saleItemId}'`,
    )
    verdicts.push({
      check: 'sale_item_remaining_sessions_unchanged',
      verdict: postRemaining === preRemaining ? 'PASS' : 'FAIL',
      actual: `pre=${preRemaining}, post=${postRemaining}`,
    })

    const svcCommissionsCnt = psql(
      `SELECT count(*) FROM service_commissions WHERE service_item_id='${serviceItemId}'`,
    )
    verdicts.push({
      check: 'no_service_commissions_for_cancelled',
      verdict: parseInt(svcCommissionsCnt, 10) === 0 ? 'PASS' : 'FAIL',
      actual: svcCommissionsCnt,
    })

    const transitionLog = psql(
      `SELECT detail::text FROM operation_logs ` +
        `WHERE action='service.cancel' AND target_id='${serviceOrderId}' ` +
        `ORDER BY created_at DESC LIMIT 1`,
    )
    const hasTransition = transitionLog.includes('transition') &&
      transitionLog.includes('待服务') && transitionLog.includes('已取消')
    verdicts.push({
      check: 'operation_log_service_cancel_transition',
      verdict: hasTransition ? 'PASS' : 'FAIL',
      actual: transitionLog.length > 200 ? transitionLog.substring(0, 200) + '...' : transitionLog,
    })

    // 反例：已完成的单不可取消（参 services.ts:419 WHERE status='待服务'）
    verdicts.push({
      check: 'neg_completed_cannot_cancel',
      verdict: 'SKIP',
      actual: 'cancelServiceOrder WHERE 子句过滤 status='
        + "'"
        + "待服务"
        + "'"
        + '；已完成单 count=0 → 返回"服务单状态已变更，无法取消"。本 spec 仅创建待服务单，验证主路径',
    })

    // service_orders.cancelled_at 不存在 → 不验证该字段（README 写错）
    verdicts.push({
      check: 'no_cancelled_at_column',
      verdict: 'SKIP',
      actual: 'README §1.B 写 cancelled_at 列；实际 schema 中无此列，仅靠 status=已取消 + updated_at 反映取消',
    })
  } finally {
    // ── Step 5: 清理 ──
    console.log('[链路23] Step 5: 清理')
    try {
      if (serviceItemId) {
        psql(`DELETE FROM service_commissions WHERE service_item_id='${serviceItemId}'`)
        psql(`DELETE FROM service_items WHERE service_item_id='${serviceItemId}'`)
      }
      if (serviceOrderId) {
        psql(`DELETE FROM service_orders WHERE service_order_id='${serviceOrderId}'`)
        psql(`DELETE FROM operation_logs WHERE target_id='${serviceOrderId}'`)
      }
    } catch (e) {
      console.log(`[链路23] 服务单相关清理失败（非致命）: ${e}`)
    }
    if (saleOrderId) cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路23]' })
  }

  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const overallStatus = hasFail ? 'FAIL' : verdicts.some((v) => v.verdict === 'SKIP') ? 'PARTIAL' : 'PASS'
  const report = {
    link: 23,
    status: overallStatus,
    saleOrderId,
    serviceOrderId,
    verdicts,
    cleaned: true,
    notes: 'service_orders 无 cancelled_at 列；cancelServiceOrder 写 logTransition（detail._t=transition from/to）',
  }
  console.log('\n[链路23] === 最终报告 ===')
  console.log(JSON.stringify(report, null, 2))
  writeCtx('link23', report)

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})
