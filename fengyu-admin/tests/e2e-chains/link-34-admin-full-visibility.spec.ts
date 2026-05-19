/**
 * 链路 34：总部 admin 全量可见基线
 *
 * 主题：FY-TEST-ADM（scope='总部'，scope_id=16d1184b46db099a）作为对照组，
 *       应见 link-32 / link-33 同样的跨店/跨市场订单。验证 scopeCondition()
 *       对 admin 角色返回 undefined（无过滤），即没有 WHERE 条件附加。
 *
 * 实现：
 *   1. seed 与 link-33 同样 3 笔订单（store-nc01 / store-nc02 / 跨市场）
 *   2. 以 FY-TEST-ADM 登录，访问 /orders 列表
 *   3. 全部 3 笔订单都应命中
 *   4. DB invariant：admin scope_id = 总部 16d1184b46db099a
 *
 * 关键引用：
 *   - lib/permissions.ts:265 scopeCondition() — admin 返回 undefined
 *   - lib/permissions.ts:189 expandScopeStoreIds() — 总部 scope 走 stores 全量返回
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  TEST_PHONES, SCOPE_CLIENTS, TOPOLOGY,
  psql, login, pageContainsKeyword, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN34'
const SOID_A = `FY-${TAG}-WX-0001`
const SOID_B = `FY-${TAG}-WX-0002`
const SOID_C = `FY-${TAG}-WX-0003`

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
  for (const id of [SOID_A, SOID_B, SOID_C]) cleanupSaleOrder(id, psql, { logPrefix: '[链路34]' })
}

test.setTimeout(120_000)

test('链路34：总部 admin 全量可见基线', async ({ browser }) => {
  const verdicts: Verdict[] = []
  cleanupAll()

  insertOrder(SOID_A, TOPOLOGY.STORE_NC01, SCOPE_CLIENTS.NC01, 'Fixture测试客', '13800138000')
  insertOrder(SOID_B, TOPOLOGY.STORE_NC02, SCOPE_CLIENTS.NC02, 'NC02测试客', '13800138002')
  insertOrder(SOID_C, TOPOLOGY.STORE_OTHER_MARKET, SCOPE_CLIENTS.OTHER_MARKET, 'OM测试客', '13800138003')

  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  try {
    await login(page, TEST_PHONES.ADM)

    for (const soid of [SOID_A, SOID_B, SOID_C]) {
      const seen = await pageContainsKeyword(page, `/orders?q=${soid}`, soid)
      recordVerdict(verdicts, `admin_sees_${soid.slice(-4)}`, seen, `${soid} visible=${seen}`)
    }

    // DB invariant: admin role 的 scope_id = 总部 + scope type='总部'
    const adminScopeRow = psql(`
      SELECT pr.scope_id || ':' || o.type
      FROM permission_roles pr JOIN org_nodes o ON pr.scope_id=o.id
      WHERE pr.employee_id='FY-TEST-ADM' AND pr.role='admin'
    `).trim()
    recordVerdict(verdicts, 'admin_scope_is_headquarters', adminScopeRow === `${TOPOLOGY.HQ_ORG_ID}:总部`, `actual=${adminScopeRow}`)
  } finally {
    await ctx.close()
    cleanupAll()
  }

  const overall = summarize(34, verdicts)
  writeContext('link34', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
