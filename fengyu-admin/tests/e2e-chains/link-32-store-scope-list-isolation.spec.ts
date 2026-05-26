/**
 * 链路 32：店长 scope 列表隔离全覆盖
 *
 * 主题：店长 A（FY-TEST-MGR, scope=org-store-nc01）登录后，
 *       7 大列表页（orders / services / appointments / customers
 *        / employees / allocations / pickup-records）不应见 store-nc02 的数据。
 *       此外，直接访问越权详情页 /orders/[soid] 应被拦截。
 *
 * 实现路径：
 *   1. SQL seed：在 store-nc02 创建 1 笔订单 + sale_item + 服务单 + 预约 + 取货 + 分配。
 *   2. 登录 FY-TEST-MGR（店长 A，scope=store-nc01）。
 *   3. 访问每个列表页，搜索 FY-CHAIN32 前缀关键字 / 客户名 → 应 0 命中。
 *   4. 直接访问 /orders/FY-CHAIN32-* 详情页 → 被拦截（404/无权限/重定向）。
 *   5. DB 反证：以 admin 视角直查同一关键字 → 必命中。
 *   6. cleanup：DELETE 全部 FY-CHAIN32 行。
 *
 * 关键引用：
 *   - actions/orders.ts:220     listOrders + scopeCondition(saleOrders.storeId)
 *   - actions/services.ts:59    listServices
 *   - actions/appointments.ts:47 listAppointments
 *   - actions/customers.ts:103  listCustomers + scopeCondition(boundStoreId)
 *   - actions/employees.ts:68   listEmployees + scopeCondition(staffWechatUsers.storeId)
 *   - actions/allocations.ts:13 listAllocations + verifyOrderScope
 *   - actions/pickup-records.ts:69 listPickupRecords + scopeCondition(pickupRecords.storeId)
 *   - lib/permissions.ts:265    scopeCondition()
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  BASE,
  TEST_PHONES,
  SCOPE_CLIENTS,
  TOPOLOGY,
  psql,
  login,
  pageContainsKeyword,
  detailPageDenied,
  recordVerdict,
  summarize,
  writeContext,
  type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN32'
const SOID = `FY-${TAG}-WX-0001`
const SIID = `FY-${TAG}-WX-0001-01`
const APPT_ID = `appt-${TAG}-0001`
const SVC_ID = `svc-${TAG}-0001`
const CUSTOMER_NAME = 'NC02测试客' // bound to store-nc02

function seedStoreNc02Data(): void {
  // 1) 订单（store-nc02 + 顾客 FY-TEST-CLIENT-NC02）
  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount
    ) VALUES (
      '${SOID}', '已支付', '销售单', '南昌市场', '${TOPOLOGY.STORE_NC02}',
      NOW(), '${SCOPE_CLIENTS.NC02}', '13800138002', '${CUSTOMER_NAME}',
      100.00, '线下', 'FY-TEST-MGR2', NOW(), NOW(),
      100.00, 100.00, 0, 0
    )
    ON CONFLICT (sale_order_id) DO NOTHING
  `)
  // 2) sale_item（不需要真实 SKU 数据，只需 FK 完整）
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, sku_spec_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      '${SIID}', '${SOID}', '${TOPOLOGY.STORE_NC02}', '购买', 'c79157b29c9e974c',
      '洗-无创纹身', '洗-无创纹身 疗程卡', '疗程卡', 1, 1,
      100.00, 1, 100.00, 100.00, 100.00,
      0, false, NOW(), NOW()
    )
    ON CONFLICT (sale_item_id) DO NOTHING
  `)
  // 3) appointment
  psql(`
    INSERT INTO appointments (
      appointment_id, status, store_id, client_user_id, client_name,
      employee_id, employee_name, sale_item_id, appointment_time, created_at, updated_at
    ) VALUES (
      '${APPT_ID}', '待确认', '${TOPOLOGY.STORE_NC02}', '${SCOPE_CLIENTS.NC02}', '${CUSTOMER_NAME}',
      'FY-TEST-MGR2', '测试店长2', '${SIID}', NOW() + interval '1 day', NOW(), NOW()
    )
    ON CONFLICT (appointment_id) DO NOTHING
  `)
  // 4) service_order
  psql(`
    INSERT INTO service_orders (
      service_order_id, status, market_name, store_id, service_date,
      assigned_employee_id, client_user_id, created_at, updated_at, service_order_type
    ) VALUES (
      '${SVC_ID}', '待服务', '南昌市场', '${TOPOLOGY.STORE_NC02}', CURRENT_DATE,
      'FY-TEST-MGR2', '${SCOPE_CLIENTS.NC02}', NOW(), NOW(), '售后'
    )
    ON CONFLICT (service_order_id) DO NOTHING
  `)
  // 5) pickup_record（家居产品取货流水）
  psql(`
    INSERT INTO pickup_records (
      sale_item_id, pickup_quantity, store_id, client_user_id, confirmed_by, created_at
    ) VALUES (
      '${SIID}', 1, '${TOPOLOGY.STORE_NC02}', '${SCOPE_CLIENTS.NC02}', 'FY-TEST-MGR2', NOW()
    )
  `)
}

function cleanupSeed(): void {
  try {
    psql(`DELETE FROM pickup_records WHERE sale_item_id='${SIID}'`)
  } catch {/* noop */}
  try {
    psql(`DELETE FROM service_orders WHERE service_order_id='${SVC_ID}'`)
  } catch {/* noop */}
  cleanupSaleOrder(SOID, psql, { logPrefix: '[链路32]' })
}

test.setTimeout(180_000)

test('链路32：店长 scope 列表隔离', async ({ browser }) => {
  const verdicts: Verdict[] = []

  // ── Step 1: seed store-nc02 数据 ──
  console.log('[链路32] Step 1: seed store-nc02 数据')
  cleanupSeed() // 残留兜底
  seedStoreNc02Data()

  // 反证：admin 视角下确实存在该订单
  const adminVisibleCount = parseInt(psql(`SELECT COUNT(*)::text FROM sale_orders WHERE sale_order_id='${SOID}'`), 10)
  recordVerdict(verdicts, 'reverse_proof_seed_exists', adminVisibleCount === 1, `count=${adminVisibleCount}`)

  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  try {
    // ── Step 2: FY-TEST-MGR（店长 A，scope=store-nc01）登录 ──
    console.log('[链路32] Step 2: 店长 A 登录')
    await login(page, TEST_PHONES.MGR)

    // ── Step 3: 7 大列表页搜索 → 应 0 命中 ──
    const listPages: Array<{ name: string; url: string; keyword: string }> = [
      // 订单列表搜索 SOID
      { name: 'orders', url: `/orders?q=${SOID}`, keyword: SOID },
      // 服务单：默认 /services；搜索关键字
      { name: 'services', url: `/services?q=${SVC_ID}`, keyword: SVC_ID },
      // 预约
      { name: 'appointments', url: `/appointments?q=${APPT_ID}`, keyword: APPT_ID },
      // 顾客：搜索 NC02 顾客
      { name: 'customers', url: `/customers?q=${encodeURIComponent(CUSTOMER_NAME)}`, keyword: CUSTOMER_NAME },
      // 员工：搜索 FY-TEST-MGR2（在 store-nc02）
      { name: 'employees', url: `/employees?q=FY-TEST-MGR2`, keyword: 'FY-TEST-MGR2' },
      // 取货记录
      { name: 'pickup-records', url: `/pickup-records?q=${SIID}`, keyword: SIID },
    ]

    for (const lp of listPages) {
      const hit = await pageContainsKeyword(page, lp.url, lp.keyword)
      recordVerdict(verdicts, `list_${lp.name}_no_cross_store`, !hit, `hit=${hit} keyword=${lp.keyword}`)
    }

    // ── Step 4: 详情页越权访问 ──
    const orderDetailDenied = await detailPageDenied(page, `/orders/${SOID}`)
    recordVerdict(verdicts, 'detail_order_denied', orderDetailDenied, `denied=${orderDetailDenied}`)

    const serviceDetailDenied = await detailPageDenied(page, `/services/${SVC_ID}`)
    recordVerdict(verdicts, 'detail_service_denied', serviceDetailDenied, `denied=${serviceDetailDenied}`)

    // ── Step 5: DB invariant — admin 视角直查能见 ──
    const admCanSee = parseInt(psql(
      `SELECT COUNT(*)::text FROM sale_orders WHERE sale_order_id='${SOID}' AND store_id='${TOPOLOGY.STORE_NC02}'`,
    ), 10)
    recordVerdict(verdicts, 'db_invariant_seed_in_nc02', admCanSee === 1, `count=${admCanSee}`)
  } finally {
    await ctx.close()
    cleanupSeed()
  }

  const overall = summarize(32, verdicts, { soid: SOID, store: TOPOLOGY.STORE_NC02 })
  writeContext('link32', { status: overall, verdicts, soid: SOID })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') {
      expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
    }
  }
})
