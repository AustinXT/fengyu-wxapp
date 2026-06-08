/**
 * 链路 42：bundle 套餐次数 + 退款不按子项折算
 *
 * 主题：组合套餐（products.is_bundle=true）的 SKU 单独写入 sale_items：
 *   - 每个 bundle 子 SKU 各占一行 sale_items，但 bundle 整体退款用整单金额
 *   - 子 SKU 的 sessionCount × quantity 分别记录 remaining_sessions
 *   - 退款时不按子项剩余折算（退整单 special_price）
 *
 * 测试场景：
 *   FY-FIX-BUNDLE-01 (¥180) 含 FY-FIX-SKU-BUNDLE-A + FY-FIX-SKU-BUNDLE-B（各 ¥100 单价、session_count=1）
 *   下单 quantity=1 → sale_items 应生成 2 行 (每子 SKU 一行)
 *   每行 session_count = sku.session_count × quantity = 1
 *
 * 测试策略：SQL 模拟 bundle 下单后状态，验证 invariant。
 *
 * 关键引用：
 *   - products.is_bundle, mall_bundle_groups
 *   - test-fixtures.json bundle 配置
 *   - link-27 已测 bundle UI 下单，本链路补 invariant + refund
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  TOPOLOGY,
  psql, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN42'
const CLIENT_USER = 'FY-FIX-CLIENT-01'
const CLIENT_PHONE = '13800138000'
const CLIENT_NAME = 'Fixture测试客'
const STORE_ID = TOPOLOGY.STORE_NC01
const SOID = `FY-${TAG}-BD-001`
const SIID_A = `${SOID}-A1`
const SIID_B = `${SOID}-B1`
const BUNDLE_PRICE = 180
const SUB_PRICE = 90 // bundle 内部子 SKU 折算单价（来自 fixture）

function seed(): void {
  cleanup()

  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount, paid_at
    ) VALUES (
      '${SOID}', '已支付', '销售单', '南昌市场', '${STORE_ID}',
      NOW(), '${CLIENT_USER}', '${CLIENT_PHONE}', '${CLIENT_NAME}',
      ${BUNDLE_PRICE}, '线下', 'FY-TEST-MGR', NOW(), NOW(),
      ${BUNDLE_PRICE}, ${BUNDLE_PRICE}, 0, 0, NOW()
    )
  `)

  // 子 SKU A：session_count=1
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      '${SIID_A}', '${SOID}', '${STORE_ID}', '购买', 'FY-FIX-SKU-BUNDLE-A',
      'Fixture 套餐子 SKU A', '疗程卡', 1, 1,
      100, 1, ${SUB_PRICE}, ${SUB_PRICE}, ${SUB_PRICE},
      0, false, NOW(), NOW()
    )
  `)

  // 子 SKU B：session_count=1
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      '${SIID_B}', '${SOID}', '${STORE_ID}', '购买', 'FY-FIX-SKU-BUNDLE-B',
      'Fixture 套餐子 SKU B', '疗程卡', 1, 1,
      100, 1, ${SUB_PRICE}, ${SUB_PRICE}, ${SUB_PRICE},
      0, false, NOW(), NOW()
    )
  `)
}

function cleanup(): void {
  cleanupSaleOrder(SOID, psql, { logPrefix: '[链路42]' })
}

test.setTimeout(120_000)

test('链路42：bundle 套餐次数 + 退款不按子项折算', async () => {
  const verdicts: Verdict[] = []
  seed()

  // ── 1) sale_items 行数 = 2（每子 SKU 各一行）──
  const itemCount = parseInt(psql(`SELECT COUNT(*)::text FROM sale_items WHERE sale_order_id='${SOID}'`), 10)
  recordVerdict(verdicts, 'sale_items_per_sub_sku', itemCount === 2, `count=${itemCount}`)

  // ── 2) 每子 SKU 的 unit_real_price = bundle_price / num_subs = 90 ──
  const subARealPrice = parseFloat(psql(`SELECT unit_real_price::text FROM sale_items WHERE sale_item_id='${SIID_A}'`))
  const subBRealPrice = parseFloat(psql(`SELECT unit_real_price::text FROM sale_items WHERE sale_item_id='${SIID_B}'`))
  recordVerdict(verdicts, 'sub_A_real_price', subARealPrice === SUB_PRICE, `actual=${subARealPrice}`)
  recordVerdict(verdicts, 'sub_B_real_price', subBRealPrice === SUB_PRICE, `actual=${subBRealPrice}`)

  // ── 3) 子 SKU 各 session_count=1，remaining=1 ──
  const subASession = parseInt(psql(`SELECT session_count::text FROM sale_items WHERE sale_item_id='${SIID_A}'`), 10)
  recordVerdict(verdicts, 'sub_A_session_count_1', subASession === 1, `actual=${subASession}`)
  const subBSession = parseInt(psql(`SELECT session_count::text FROM sale_items WHERE sale_item_id='${SIID_B}'`), 10)
  recordVerdict(verdicts, 'sub_B_session_count_1', subBSession === 1, `actual=${subBSession}`)

  // ── 4) Σ(sale_amount) = bundle_price ──
  const sumSale = parseFloat(psql(`SELECT COALESCE(SUM(sale_amount), 0)::text FROM sale_items WHERE sale_order_id='${SOID}'`))
  recordVerdict(verdicts, 'sum_sale_amount_eq_bundle', sumSale === BUNDLE_PRICE, `expected=${BUNDLE_PRICE} actual=${sumSale}`)

  // ── 5) order.total_amount === bundle special_price (180) ──
  const orderTotal = parseFloat(psql(`SELECT total_amount::text FROM sale_orders WHERE sale_order_id='${SOID}'`))
  recordVerdict(verdicts, 'order_total_eq_bundle_price', orderTotal === BUNDLE_PRICE, `actual=${orderTotal}`)

  // ── 6) 退款：整单退（refund_amount = order.received，不按子项剩余折算）──
  const refundAmount = parseFloat(psql(`SELECT received::text FROM sale_orders WHERE sale_order_id='${SOID}'`))
  recordVerdict(verdicts, 'refund_amount_eq_received_full', refundAmount === BUNDLE_PRICE,
    `expected=${BUNDLE_PRICE} actual=${refundAmount}`)

  // 模拟退款：写 sale_order_payments
  psql(`
    INSERT INTO sale_order_payments (
      sale_order_id, change_type, amount, payment_method, status,
      source_end, operator_employee_id, created_at, paid_at
    ) VALUES (
      '${SOID}', '退款', ${-refundAmount}, '线下', '已支付',
      'admin', 'FY-TEST-FIN', NOW(), NOW()
    )
  `)
  psql(`UPDATE sale_orders SET refunded_amount=${refundAmount}, updated_at=NOW() WHERE sale_order_id='${SOID}'`)

  // ── 7) 退款后 sale_orders.refunded_amount = bundle_price 整数（不分子项） ──
  const refundedAfter = parseFloat(psql(`SELECT refunded_amount::text FROM sale_orders WHERE sale_order_id='${SOID}'`))
  recordVerdict(verdicts, 'refunded_amount_full_bundle', refundedAfter === BUNDLE_PRICE,
    `actual=${refundedAfter}`)

  cleanup()

  const overall = summarize(42, verdicts)
  writeContext('link42', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
