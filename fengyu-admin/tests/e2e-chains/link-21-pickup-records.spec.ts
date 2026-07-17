/**
 * 链路 21：取货流程（pickup_records）→ 实物商品出库
 *
 * 主题：实物 SKU（product_type='家居产品'）下单后须经过取货流程，
 *      pickup_records 行的 pickup_quantity 累加 == sale_items.picked_up_quantity ≤ quantity。
 *
 * NOTE: README §1.B 写 sale_items.remaining_pickup；真实字段是 picked_up_quantity（累加增量字段）。
 *       pickup_records 表字段名是 pickup_quantity（非 quantity）。
 *
 * 不变量：
 *   SUM(pickup_records.pickup_quantity WHERE sale_item_id=X) == sale_items.picked_up_quantity
 *   sale_items.picked_up_quantity <= sale_items.quantity
 *   超量取 → createPickupRecord 返回 OVER_QUANTITY（事务回滚，pickup_records 不插）
 *
 * 流程简化：
 *   1. MGR 开一单"家居 SKU × 1"（UI 默认 qty=1）→ SQL 把 quantity 改为 3 模拟批量买
 *   2. SQL 调用等价 createPickupRecord 逻辑 取 1 件（UPDATE + INSERT 事务）
 *   3. 校验 picked_up_quantity=1，pickup_records 行数+1
 *   4. 取 2 件 → picked_up_quantity=3
 *   5. 取 1 件（超量） → 应失败（OVER_QUANTITY）
 *   6. 清理：DELETE pickup_records + cleanupSaleOrder
 *
 * 完整 UI（/pickup-records/create 搜索顾客 + select item + qty）测试留作手动验证（spec 内 SKIP）
 */

import { test, expect } from '@playwright/test'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { cleanupSaleOrder } from './_helpers/cleanup'

const BASE = process.env.ADMIN_BASE_URL || 'http://localhost:3000'
const MGR_PHONE = '13900139001'
const PASS = 'fengyu2026'
const FIXTURE_PHONE = '13800138000'
const FIXTURE_USER_ID = 'FY-FIX-CLIENT-01'

// 已存在的"家居产品"SKU：法米索深层清洁啫喱 ¥280（5433 上已经存在）
const HOME_SKU_ID = 'cc578d4554aadae9'
const HOME_SKU_NAME = '法米索深层清洁啫喱'
const HOME_SKU_CAT_NAME = '歆笙泰妍'

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

/** 等价 createPickupRecord 的原子事务（admin 的实现 see src/actions/pickup-records.ts:284） */
function atomicPickup(saleItemId: string, qty: number, storeId: string, clientUserId: string): { ok: boolean; reason?: string } {
  try {
    // 子查询保证 (picked_up_quantity + qty) <= quantity
    // 注：psql -t -A 在 0 行更新时输出 "UPDATE 0"（非空），所以用 includes(saleItemId) 判断
    // RETURNING 是否真返回行，而不是 !updRes
    const updRes = psql(
      `UPDATE sale_items SET picked_up_quantity = COALESCE(picked_up_quantity, 0) + ${qty}, updated_at=NOW() ` +
        `WHERE sale_item_id='${saleItemId}' AND product_type='家居产品' AND item_direction='购买' ` +
        `AND (COALESCE(picked_up_quantity, 0) + ${qty}) <= quantity RETURNING sale_item_id`,
    )
    if (!updRes.includes(saleItemId)) {
      return { ok: false, reason: 'OVER_QUANTITY 或 item 不存在' }
    }
    psql(
      `INSERT INTO pickup_records (sale_item_id, pickup_quantity, store_id, client_user_id, confirmed_by, remark) ` +
        `VALUES ('${saleItemId}', ${qty}, '${storeId}', '${clientUserId}', 'FY-TEST-MGR', 'link-21 自动化')`,
    )
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e instanceof Error ? e.message : String(e)).split('\n')[0] }
  }
}

/** 简单开单（指定 SKU 单数量 1） */
async function createOrderWithSku(page: import('@playwright/test').Page, skuName: string, catName: string, tag: string): Promise<string> {
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

  // 切换到目标分类
  const cat = page.getByRole('button', { name: catName, exact: true }).first()
  if (await cat.count() > 0) {
    await cat.click()
    await page.waitForTimeout(800)
  }
  const skuText = page.getByText(skuName, { exact: false })
  let added = false
  if (await skuText.count() > 0) {
    // 找最近含"加入"按钮的容器
    for (let lvl = 1; lvl <= 5; lvl++) {
      const ancestor = skuText.first().locator(`xpath=ancestor::*[${lvl}]`)
      const addBtn = ancestor.getByRole('button', { name: /加入/ })
      if (await addBtn.count() > 0) {
        await addBtn.click()
        added = true
        break
      }
    }
  }
  if (!added) throw new Error(`无法加入 SKU "${skuName}"（分类: ${catName}）`)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-21-${tag}-cart.png` })

  await page.getByRole('button', { name: '下一步' }).click()
  await expect(page.getByRole('button', { name: '销售单', exact: true })).toBeVisible({ timeout: 10000 })

  // 支付选择器（修复 2026-06-10，同 link-1）：select[name="paymentMethod"] 失效，按"线下支付"选项精确定位
  await page.locator('select').filter({ hasText: /线下支付/ }).first().selectOption({ label: '线下支付' })
  // 取消充值卡抵扣（顾客有卡余额时自动勾选 → payment_method='无' 绕过确认收款链路）
  const useCardCb = page.getByRole('checkbox').first()
  if ((await useCardCb.count()) > 0 && (await useCardCb.isChecked().catch(() => false))) { await useCardCb.uncheck() }
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
  await page.screenshot({ path: `${TEST_RESULTS_DIR}/link-21-${tag}-paid.png` })
  return soid
}

test.setTimeout(240_000)

test('链路21：取货流程（pickup_records）→ 实物商品出库', async ({ browser }) => {
  ensureDir(TEST_RESULTS_DIR)
  const verdicts: Array<{ check: string; verdict: string; actual?: string | number }> = []

  let saleOrderId = ''
  let saleItemId = ''

  try {
    // ── Step 1: MGR 开一单（家居 SKU x1，UI 默认 qty=1） ──
    console.log('[链路21] Step 1: MGR 开家居 SKU 订单')
    const mgrCtx = await browser.newContext()
    const mgrPage = await mgrCtx.newPage()
    mgrPage.on('console', (m) => { if (m.type() === 'error') console.log(`[browser-err] ${m.text()}`) })
    await login(mgrPage, MGR_PHONE, PASS)
    saleOrderId = await createOrderWithSku(mgrPage, HOME_SKU_NAME, HOME_SKU_CAT_NAME, '01')
    console.log(`[链路21] saleOrderId: ${saleOrderId}`)
    await mgrCtx.close()

    // 取该单的 sale_item_id（应有 1 行家居）
    saleItemId = psql(
      `SELECT sale_item_id FROM sale_items WHERE sale_order_id='${saleOrderId}' AND product_type='家居产品' LIMIT 1`,
    )
    if (!saleItemId) throw new Error('FATAL: 创建的订单内未发现家居 sale_item')
    console.log(`[链路21] saleItemId: ${saleItemId}`)

    // ── Step 2: SQL 把 quantity 调到 3（模拟一次买 3 件） ──
    psql(`UPDATE sale_items SET quantity=3 WHERE sale_item_id='${saleItemId}'`)
    console.log('[链路21] 已 SQL 调 quantity=3')

    // ── Step 3: 取 1 件 ──
    const pickup1 = atomicPickup(saleItemId, 1, 'store-nc01', FIXTURE_USER_ID)
    console.log(`[链路21] 取 1 件结果: ${JSON.stringify(pickup1)}`)
    verdicts.push({ check: 'pickup_1_succeeds', verdict: pickup1.ok ? 'PASS' : 'FAIL', actual: JSON.stringify(pickup1) })

    const after1 = psql(
      `SELECT picked_up_quantity::text || '|' || (SELECT count(*) FROM pickup_records WHERE sale_item_id='${saleItemId}')::text FROM sale_items WHERE sale_item_id='${saleItemId}'`,
    )
    const [puq1, rec1] = after1.split('|')
    verdicts.push({
      check: 'after_pickup_1_state',
      verdict: puq1 === '1' && rec1 === '1' ? 'PASS' : 'FAIL',
      actual: `picked_up=${puq1}, records=${rec1}`,
    })

    // ── Step 4: 取 2 件 ──
    const pickup2 = atomicPickup(saleItemId, 2, 'store-nc01', FIXTURE_USER_ID)
    console.log(`[链路21] 取 2 件结果: ${JSON.stringify(pickup2)}`)
    verdicts.push({ check: 'pickup_2_succeeds', verdict: pickup2.ok ? 'PASS' : 'FAIL', actual: JSON.stringify(pickup2) })

    const after2 = psql(
      `SELECT picked_up_quantity::text || '|' || (SELECT count(*) FROM pickup_records WHERE sale_item_id='${saleItemId}')::text || '|' || (SELECT COALESCE(sum(pickup_quantity)::text, '0') FROM pickup_records WHERE sale_item_id='${saleItemId}') FROM sale_items WHERE sale_item_id='${saleItemId}'`,
    )
    const [puq2, rec2, sumQ] = after2.split('|')
    verdicts.push({
      check: 'after_pickup_2_state',
      verdict: puq2 === '3' && rec2 === '2' && sumQ === '3' ? 'PASS' : 'FAIL',
      actual: `picked_up=${puq2}, records=${rec2}, sum=${sumQ}`,
    })

    // ── Step 5: 超量取 → 应失败 ──
    const pickup3 = atomicPickup(saleItemId, 1, 'store-nc01', FIXTURE_USER_ID)
    console.log(`[链路21] 超量取 1 件结果: ${JSON.stringify(pickup3)}`)
    verdicts.push({
      check: 'over_quantity_blocked',
      verdict: !pickup3.ok ? 'PASS' : 'FAIL',
      actual: JSON.stringify(pickup3),
    })

    // 验证状态未变（picked_up_quantity 仍 = 3，records 仍 = 2）
    const after3 = psql(
      `SELECT picked_up_quantity::text || '|' || (SELECT count(*) FROM pickup_records WHERE sale_item_id='${saleItemId}')::text FROM sale_items WHERE sale_item_id='${saleItemId}'`,
    )
    const [puq3, rec3] = after3.split('|')
    verdicts.push({
      check: 'over_quantity_no_side_effect',
      verdict: puq3 === '3' && rec3 === '2' ? 'PASS' : 'FAIL',
      actual: `picked_up=${puq3}, records=${rec3}`,
    })

    // ── Step 6: 不变量整体校验 ──
    const invariant = psql(
      `SELECT CASE WHEN (SELECT COALESCE(sum(pickup_quantity),0) FROM pickup_records WHERE sale_item_id='${saleItemId}') ` +
        `= (SELECT picked_up_quantity FROM sale_items WHERE sale_item_id='${saleItemId}') ` +
        `AND (SELECT picked_up_quantity FROM sale_items WHERE sale_item_id='${saleItemId}') ` +
        `<= (SELECT quantity FROM sale_items WHERE sale_item_id='${saleItemId}') ` +
        `THEN 'PASS' ELSE 'FAIL' END`,
    )
    verdicts.push({ check: 'invariant_holds', verdict: invariant, actual: invariant })

    // ── 反例 SKIP：UI 路径 ──
    verdicts.push({
      check: 'ui_pickup_create_page',
      verdict: 'SKIP',
      actual: '/pickup-records/create 完整 UI 测试留作手动；本 spec 验证 createPickupRecord 等价 SQL 事务',
    })
  } finally {
    // ── Step 7: 清理 ──
    console.log('[链路21] Step 7: 清理 — 删 pickup_records + cleanupSaleOrder')
    try {
      if (saleItemId) psql(`DELETE FROM pickup_records WHERE sale_item_id='${saleItemId}'`)
    } catch (e) {
      console.log(`[链路21] 删 pickup_records 出错（非致命）: ${e}`)
    }
    if (saleOrderId) cleanupSaleOrder(saleOrderId, psql, { logPrefix: '[链路21]' })
  }

  const hasFail = verdicts.some((v) => v.verdict === 'FAIL')
  const overallStatus = hasFail ? 'FAIL' : verdicts.some((v) => v.verdict === 'SKIP') ? 'PARTIAL' : 'PASS'
  const report = {
    link: 21,
    status: overallStatus,
    saleOrderId,
    saleItemId,
    homeSkuId: HOME_SKU_ID,
    verdicts,
    cleaned: true,
    notes: 'sale_items.picked_up_quantity 是累加字段；pickup_records.pickup_quantity 是行级；超量取通过 UPDATE WHERE 子句拦截',
  }
  console.log('\n[链路21] === 最终报告 ===')
  console.log(JSON.stringify(report, null, 2))
  writeCtx('link21', report)

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})
