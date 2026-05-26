/**
 * 链路 37：跨店操作 server-side 拦截
 *
 * 主题：店长 A (FY-TEST-MGR, scope=store-nc01) 不能对店 B 的订单执行写操作。
 *       即使绕过 UI 直接访问详情页/分配页/退款页，server 也应拒绝。
 *
 * 涉及 server action 入口：
 *   - getOrderById        actions/orders.ts:415  scopeCondition(saleOrders.storeId) → 返回 undefined
 *   - getOrderAllocations actions/allocations.ts:38 verifyOrderScope → 空数组
 *   - saveAllocations     actions/allocations.ts:43 verifyOrderScope → {success:false}
 *   - createRefund        actions/refunds.ts:201 scopeCondition → throw 'NOT_FOUND: 原订单不存在或无权访问'
 *   - recordPayment       actions/orders.ts:504/568 scopeCondition WHERE 子句
 *
 * 实现：
 *   1. seed 一笔 store-nc02 订单（含 sale_item）
 *   2. 以 FY-TEST-MGR（店长 A nc01）登录
 *   3. 试图访问下列页面 → 应被拦截：
 *      a) /orders/[soid]          → 404 / 无权
 *      b) /allocations/[soid]     → 空 / 无权
 *      c) /refunds/create?orderId=[soid]  → 404 / 无权
 *   4. DB invariant：上述访问前后 sale_orders 数据完全不变（status/received/refunded_amount/updated_at）
 *   5. cleanup
 *
 * 注：本测试不试图模拟用户「fetch /__nextjs_action_xxx」直接 POST，
 *      因为 Server Action 端点是动态混淆名；UI 路径已能覆盖所有入口。
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  TEST_PHONES, SCOPE_CLIENTS, TOPOLOGY,
  psql, login, detailPageDenied, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN37'
const SOID = `FY-${TAG}-WX-0001`
const SIID = `FY-${TAG}-WX-0001-01`

function seed(): void {
  cleanup()
  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount
    ) VALUES (
      '${SOID}', '已支付', '销售单', '南昌市场', '${TOPOLOGY.STORE_NC02}',
      NOW(), '${SCOPE_CLIENTS.NC02}', '13800138002', 'NC02测试客',
      200.00, '线下', 'FY-TEST-MGR2', NOW(), NOW(),
      200.00, 200.00, 0, 0
    )
    ON CONFLICT (sale_order_id) DO NOTHING
  `)
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, sku_spec_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      '${SIID}', '${SOID}', '${TOPOLOGY.STORE_NC02}', '购买', 'c79157b29c9e974c',
      '洗-无创纹身', '洗-无创纹身 疗程卡', '疗程卡', 1, 2,
      100.00, 2, 100.00, 200.00, 200.00,
      0, false, NOW(), NOW()
    ) ON CONFLICT (sale_item_id) DO NOTHING
  `)
}

function cleanup(): void {
  cleanupSaleOrder(SOID, psql, { logPrefix: '[链路37]' })
}

function snapshotOrder(): string {
  return psql(`
    SELECT status || '|' || received::text || '|' || refunded_amount::text || '|' || updated_at::text
    FROM sale_orders WHERE sale_order_id='${SOID}'
  `).trim()
}

test.setTimeout(180_000)

test('链路37：跨店操作 server-side 拦截', async ({ browser }) => {
  const verdicts: Verdict[] = []
  seed()

  const before = snapshotOrder()
  console.log(`[链路37] 操作前 snapshot: ${before}`)

  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  try {
    await login(page, TEST_PHONES.MGR)

    // ── 探测 1: /orders/[soid] 详情页 ──
    const orderDenied = await detailPageDenied(page, `/orders/${SOID}`)
    recordVerdict(verdicts, 'order_detail_denied', orderDenied, `denied=${orderDenied}`)

    // ── 探测 2: /allocations/[soid] 分配页 ──
    const allocDenied = await detailPageDenied(page, `/allocations/${SOID}`)
    recordVerdict(verdicts, 'allocations_page_denied', allocDenied, `denied=${allocDenied}`)

    // ── 探测 3: /refunds/create?orderId=[soid] 退款创建页 ──
    // 退款页面：/refunds/create 表单内通过 orderId search param 预填，预填查 getOrderById → scope 拦截
    const refundDenied = await detailPageDenied(page, `/refunds/create?orderId=${SOID}`)
    recordVerdict(verdicts, 'refund_create_denied', refundDenied, `denied=${refundDenied}`)
  } finally {
    await ctx.close()
  }

  // ── DB invariant: 操作后 snapshot 完全不变 ──
  const after = snapshotOrder()
  console.log(`[链路37] 操作后 snapshot: ${after}`)
  recordVerdict(verdicts, 'db_invariant_unchanged', before === after, `before=${before} after=${after}`)

  cleanup()
  const overall = summarize(37, verdicts, { soid: SOID })
  writeContext('link37', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
