/**
 * 链路 33：市场经理跨市场隔离
 *
 * 主题：FY-TEST-MKT（market scope=南昌市场 6707cc8b88579108）应见所辖
 *       store-nc01 + store-nc02 的所有订单，但不见 南昌市场2 (ec9ca0f5c96be174)
 *       下任何门店的订单。
 *
 * 实现：
 *   1. SQL seed 3 笔订单：(a) store-nc01, (b) store-nc02, (c) 跨市场 b79a82e33d6cf4f3
 *   2. 以 FY-TEST-MKT 登录，查询 /orders 列表
 *   3. 断言：(a)(b) 命中；(c) 不命中
 *   4. SQL invariant：通过 admin SQL 直查 sale_orders + scope_id 路径反证
 *   5. cleanup 3 笔订单
 *
 * 关键引用：
 *   - lib/permissions.ts:189-231 expandScopeStoreIds（市场 → 所辖门店 store_id 列表）
 *   - actions/orders.ts:220 listOrders + scopeCondition(saleOrders.storeId)
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  TEST_PHONES, SCOPE_CLIENTS, TOPOLOGY,
  psql, login, pageContainsKeyword, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN33'
const SOID_A = `FY-${TAG}-WX-0001` // store-nc01
const SOID_B = `FY-${TAG}-WX-0002` // store-nc02
const SOID_C = `FY-${TAG}-WX-0003` // 跨市场 b79a82e33d6cf4f3

function insertOrder(soid: string, storeId: string, clientUserId: string, customerName: string, phone: string): void {
  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount
    ) VALUES (
      '${soid}', '已支付', '销售单', '南昌市场', '${storeId}',
      NOW(), '${clientUserId}', '${phone}', '${customerName}',
      100.00, '线下', 'FY-TEST-MGR2', NOW(), NOW(),
      100.00, 100.00, 0, 0
    )
    ON CONFLICT (sale_order_id) DO NOTHING
  `)
}

function cleanupAll(): void {
  for (const id of [SOID_A, SOID_B, SOID_C]) {
    cleanupSaleOrder(id, psql, { logPrefix: '[链路33]' })
  }
}

test.setTimeout(180_000)

test('链路33：市场经理跨市场隔离', async ({ browser }) => {
  const verdicts: Verdict[] = []
  cleanupAll() // 兜底

  // ── Step 1: seed 3 笔订单 ──
  insertOrder(SOID_A, TOPOLOGY.STORE_NC01, SCOPE_CLIENTS.NC01, 'Fixture测试客', '13800138000')
  insertOrder(SOID_B, TOPOLOGY.STORE_NC02, SCOPE_CLIENTS.NC02, 'NC02测试客', '13800138002')
  insertOrder(SOID_C, TOPOLOGY.STORE_OTHER_MARKET, SCOPE_CLIENTS.OTHER_MARKET, 'OM测试客', '13800138003')

  // ── Step 2: FY-TEST-MKT 登录并访问 /orders 列表 ──
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  try {
    await login(page, TEST_PHONES.MKT)

    // 注：分页+过滤可能要在 q 上下文里搜索；先按订单号精确搜索
    const seeA = await pageContainsKeyword(page, `/orders?q=${SOID_A}`, SOID_A)
    recordVerdict(verdicts, 'market_sees_store_nc01', seeA, `${SOID_A} visible=${seeA}`)

    const seeB = await pageContainsKeyword(page, `/orders?q=${SOID_B}`, SOID_B)
    recordVerdict(verdicts, 'market_sees_store_nc02', seeB, `${SOID_B} visible=${seeB}`)

    const seeC = await pageContainsKeyword(page, `/orders?q=${SOID_C}`, SOID_C)
    recordVerdict(verdicts, 'market_blocks_other_market', !seeC, `${SOID_C} visible=${seeC}（应不可见）`)

    // ── Step 3: DB invariant — 市场所辖 store_id 列表 ──
    const nanchangStoreIds = psql(`
      SELECT store_id FROM stores s
      JOIN org_nodes o ON s.org_node_id=o.id
      WHERE o.parent_id='${TOPOLOGY.MARKET_NC}'
      ORDER BY store_id
    `).split('\n').map((x) => x.trim()).filter(Boolean)

    recordVerdict(
      verdicts, 'market_scope_contains_nc01_nc02',
      nanchangStoreIds.includes(TOPOLOGY.STORE_NC01) && nanchangStoreIds.includes(TOPOLOGY.STORE_NC02),
      `nanchangStoreIds=${nanchangStoreIds.length} stores`,
    )

    recordVerdict(
      verdicts, 'market_scope_excludes_other_market',
      !nanchangStoreIds.includes(TOPOLOGY.STORE_OTHER_MARKET),
      `OTHER_MARKET ${TOPOLOGY.STORE_OTHER_MARKET} excluded=${!nanchangStoreIds.includes(TOPOLOGY.STORE_OTHER_MARKET)}`,
    )
  } finally {
    await ctx.close()
    cleanupAll()
  }

  const overall = summarize(33, verdicts)
  writeContext('link33', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
