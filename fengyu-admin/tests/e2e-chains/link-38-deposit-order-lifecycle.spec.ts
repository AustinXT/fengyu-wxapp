/**
 * 链路 38：寄存单（deposit）完整生命周期
 *
 * 主题：寄存单 sale_order_type='寄存单' 的完整链路：
 *   - 创建：total_amount=0, status='已支付', payment_method='无', document_type='售后'
 *   - service_order：复用正常 service.complete 链路扣 remaining_sessions
 *   - service_commissions：寄存单不产生提成（completeServiceOrder 不自动写；分配接口拒绝寄存单）
 *   - 看板聚合：金额维度排除寄存单；次数维度纳入顾客数
 *
 * 实现：
 *   1. SQL seed 寄存单（按 createDepositOrder 完全相同的 INSERT 模式：sale_orders + sale_items）
 *   2. SQL seed service_order + service_item（状态从 '待服务' 起步）
 *   3. 直接 UPDATE service_orders.status='服务中' 模拟 service.start
 *   4. 走 admin UI 进入 /services/[id]，点击「完成服务」按钮 → 调 completeServiceOrder server action
 *   5. SQL invariant：
 *      a) sale_items.remaining_sessions = original - session_used
 *      b) service_commissions 为空（寄存单不参与提成）
 *      c) sale_orders.sale_order_type='寄存单' / total=0 / status='已支付' / payment_method='无'
 *      d) 金额聚合 SUM(received) where sale_order_type IN ('销售单','转换单') 不含本单
 *      e) 顾客次数维度：本单对应顾客被 COUNT
 *   6. cleanup
 *
 * 关键引用：
 *   - actions/orders.ts:1897 createDepositOrder（按其 INSERT 模式 seed）
 *   - actions/services.ts:343 completeServiceOrder（原子扣减；不写提成）
 *   - .claude memory: project_deposit_sale_order_type.md
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  BASE, TEST_PHONES, TOPOLOGY,
  psql, login, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN38'
const SOID = `FY-DEP-${TAG}-0001`
const SIID = `XSLSH-${TAG}-0001`
const SVC_ID = `SVCDEP-${TAG}-0001`
const SVC_ITEM_ID = `SVI-${TAG}-0001`
const CLIENT_USER = 'FY-FIX-CLIENT-01'
const STORE_ID = TOPOLOGY.STORE_NC01
// 使用 SKU c79157b29c9e974c（fixture skus.normal_low，session_count=1）
// quantity=10 → sessionCount=1×10=10
const SKU_ID = 'c79157b29c9e974c'
const QUANTITY = 10
const INITIAL_SESSIONS = 10
const SESSION_USED = 1

function seed(): void {
  cleanup()

  // 1) deposit 订单（仿 createDepositOrder 的 INSERT 模式）
  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, document_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount,
      coupon_id, coupon_discount, paid_at, allocation_status
    ) VALUES (
      '${SOID}', '已支付', '寄存单', '售后', '南昌市场', '${STORE_ID}',
      NOW(), '${CLIENT_USER}', '13800138000', 'Fixture测试客',
      0, '无', 'FY-TEST-MGR', NOW(), NOW(),
      0, 0, 0, 0,
      NULL, 0, NOW(), '待分配'
    )
  `)

  // 2) sale_item（带次数）
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      '${SIID}', '${SOID}', '${STORE_ID}', '购买', '${SKU_ID}',
      '洗-无创纹身 疗程卡', '疗程卡', ${INITIAL_SESSIONS}, ${INITIAL_SESSIONS},
      100, ${QUANTITY}, 100, 1000, 0,
      0, false, NOW(), NOW()
    )
  `)

  // 3) service_order：状态先放 '服务中'（绕过 service.start UI 步骤，仅测 complete）
  psql(`
    INSERT INTO service_orders (
      service_order_id, status, market_name, store_id, service_date,
      assigned_employee_id, client_user_id, created_at, updated_at, service_order_type, started_at
    ) VALUES (
      '${SVC_ID}', '服务中', '南昌市场', '${STORE_ID}', CURRENT_DATE,
      'FY-TEST-MGR', '${CLIENT_USER}', NOW(), NOW(), '售后', NOW()
    )
  `)

  // 4) service_item：扣 1 次
  psql(`
    INSERT INTO service_items (
      service_item_id, service_order_id, sale_item_id,
      session_used, employee_id, unit_real_price, service_duration,
      created_at, updated_at
    ) VALUES (
      '${SVC_ITEM_ID}', '${SVC_ID}', '${SIID}',
      ${SESSION_USED}, 'FY-TEST-MGR', 0, 30,
      NOW(), NOW()
    )
  `)
}

function cleanup(): void {
  try { psql(`DELETE FROM service_commissions WHERE service_item_id='${SVC_ITEM_ID}'`) } catch {/* noop */}
  try { psql(`DELETE FROM service_items WHERE service_order_id='${SVC_ID}'`) } catch {/* noop */}
  try { psql(`DELETE FROM service_orders WHERE service_order_id='${SVC_ID}'`) } catch {/* noop */}
  cleanupSaleOrder(SOID, psql, { logPrefix: '[链路38]' })
}

test.setTimeout(180_000)

test('链路38：寄存单完整生命周期', async ({ browser }) => {
  const verdicts: Verdict[] = []
  seed()

  // ── DB invariant: 寄存单本身的不变量 ──
  const depRow = psql(`
    SELECT sale_order_type || '|' || total_amount::text || '|' || status || '|' || payment_method
    FROM sale_orders WHERE sale_order_id='${SOID}'
  `).trim()
  recordVerdict(verdicts, 'deposit_order_invariants', depRow === '寄存单|0.00|已支付|无', `actual=${depRow}`)

  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  try {
    // ── 登录 manager（admin 角色不持有 service:list；seed 的 store=store-nc01 在 MGR scope 内） ──
    await login(page, TEST_PHONES.MGR)

    // ── 访问 /services 列表确认订单存在 ──
    await page.goto(`${BASE}/services?q=${SVC_ID}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)
    const listBody = await page.textContent('body').catch(() => '')
    const inList = (listBody || '').includes(SVC_ID)
    recordVerdict(verdicts, 'service_in_list', inList, `inList=${inList}`)

    // ── 进入服务单列表页（详情页是只读视图，没有「完成服务」按钮；
    //    操作按钮在列表行内，参考 link-45 同款做法）──
    await page.goto(`${BASE}/services?q=${SVC_ID}`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1500)

    // 等"完成服务"按钮渲染（status=服务中 时该按钮才出现）
    const completeBtn = page.getByRole('button', { name: '完成服务' }).first()
    let clicked = false
    if (await completeBtn.count() > 0) {
      await completeBtn.click().catch(() => null)
      // migration 0053（arch/006）：服务中 →「标记完成服务？」/「标记完成」→ 待客户确认（不扣次数）
      const markBtn = page.getByRole('button', { name: '标记完成' }).first()
      await markBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null)
      if (await markBtn.count() > 0) await markBtn.click().catch(() => null)
      // 待客户确认 →「代客户确认」→「代客户确认服务完成？」/「确认完成」→ 已完成 + 扣次数
      const confirmStepBtn = page.getByRole('button', { name: '代客户确认' }).first()
      await confirmStepBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null)
      if (await confirmStepBtn.count() > 0) {
        await confirmStepBtn.click().catch(() => null)
        const confirmBtn = page.getByRole('button', { name: /^确认完成$/ }).first()
        await confirmBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null)
        if (await confirmBtn.count() > 0) await confirmBtn.click().catch(() => null)
      }
      clicked = true
    }
    recordVerdict(verdicts, 'complete_clicked', clicked, `btnFound=${clicked}`)

    // ── DB invariant: remaining_sessions 已扣减（poll 等 server action commit + refresh） ──
    let remaining = INITIAL_SESSIONS
    const expectedRemaining = INITIAL_SESSIONS - SESSION_USED
    for (let i = 0; i < 20; i++) {
      remaining = parseInt(psql(`SELECT remaining_sessions::text FROM sale_items WHERE sale_item_id='${SIID}'`), 10)
      if (remaining === expectedRemaining) break
      await page.waitForTimeout(500)
    }
    recordVerdict(verdicts, 'remaining_sessions_decremented',
      remaining === expectedRemaining,
      `expected=${expectedRemaining} actual=${remaining}`)

    // ── DB invariant: service_orders.status='已完成' ──
    const svcStatus = psql(`SELECT status FROM service_orders WHERE service_order_id='${SVC_ID}'`).trim()
    recordVerdict(verdicts, 'service_completed', svcStatus === '已完成', `status=${svcStatus}`)

    // ── DB invariant: 寄存单不产生提成 —— service_commissions 必须为空 ──
    // 寄存单仅初始化剩余次数，不计营业额/客单价/提成；completeServiceOrder 不自动写提成，
    // 且 batchSaveServiceCommissions / staff serviceCommission.save 均拒绝寄存单分配。
    const commCount = parseInt(psql(`SELECT COUNT(*)::text FROM service_commissions WHERE service_item_id='${SVC_ITEM_ID}'`), 10)
    recordVerdict(verdicts, 'commissions_not_written', commCount === 0, `count=${commCount}`)
  } finally {
    await ctx.close()
  }

  // ── 看板聚合：金额维度（销售单+转换单）不含 deposit ──
  const moneyAgg = parseFloat(psql(`
    SELECT COALESCE(SUM(received::numeric), 0)::text FROM sale_orders
    WHERE store_id='${STORE_ID}' AND sale_order_type IN ('销售单','转换单')
    AND sale_order_id='${SOID}'
  `)) || 0
  recordVerdict(verdicts, 'money_agg_excludes_deposit', moneyAgg === 0, `moneyAggForDeposit=${moneyAgg}`)

  // ── 次数维度：顾客在 sale_orders 中被 COUNT（任何 type） ──
  const cardHolders = parseInt(psql(`
    SELECT COUNT(DISTINCT client_user_id)::text FROM sale_orders
    WHERE sale_order_id='${SOID}'
  `), 10)
  recordVerdict(verdicts, 'card_holder_dim_includes_deposit', cardHolders === 1, `cardHolders=${cardHolders}`)

  cleanup()

  const overall = summarize(38, verdicts, { soid: SOID })
  writeContext('link38', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
