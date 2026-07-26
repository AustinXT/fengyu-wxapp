#!/usr/bin/env bun
/**
 * order.create 疗程卡同名阶梯定价冒烟
 *
 * 规则：同一品项分类 + 同商品名称 + 疗程卡，按购物车总次数命中最高可用档位；
 * 命中后先得到 pre-coupon 行应收，再进入现有优惠券按行摊算。
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_OPENID,
  TEST_CLIENT_PHONE,
  pgQuery,
  closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore,
  createTestStaff,
  createTestClient,
  createTestProduct,
  createTestCoupon,
  cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1

function rec(line) { console.log(line) }

function closeTo(actual, expected, epsilon = 0.001) {
  return Math.abs(Number(actual) - expected) <= epsilon
}

async function assertOrderLines({ saleOrderId, expectedTotal, expectedRows, label }) {
  const orders = await pgQuery(
    `SELECT total_amount, coupon_discount FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId],
  )
  const errors = []
  if (orders.length !== 1) {
    errors.push(`[${label}] sale_orders 行数应=1，实际=${orders.length}`)
  } else {
    if (!closeTo(orders[0].total_amount, expectedTotal)) {
      errors.push(`[${label}] total_amount 应=${expectedTotal}，实际=${orders[0].total_amount}`)
    }
  }

  const rows = await pgQuery(
    `SELECT sku_id, session_count, quantity, sale_amount, unit_price, unit_real_price,
            received, pending_received
       FROM sale_items
      WHERE sale_order_id = $1
      ORDER BY session_count DESC, sku_id`,
    [saleOrderId],
  )
  if (rows.length !== expectedRows.length) {
    errors.push(`[${label}] sale_items 行数应=${expectedRows.length}，实际=${rows.length}`)
  } else {
    for (let i = 0; i < expectedRows.length; i++) {
      const actual = rows[i]
      const expected = expectedRows[i]
      if (actual.sku_id !== expected.skuId) errors.push(`[${label}] row${i}.sku_id 应=${expected.skuId}，实际=${actual.sku_id}`)
      if (Number(actual.quantity) !== 1) errors.push(`[${label}] row${i}.quantity 应=1，实际=${actual.quantity}`)
      if (Number(actual.session_count) !== expected.sessionCount) {
        errors.push(`[${label}] row${i}.session_count 应=${expected.sessionCount}，实际=${actual.session_count}`)
      }
      if (!closeTo(actual.sale_amount, expected.saleAmount)) {
        errors.push(`[${label}] row${i}.sale_amount 应=${expected.saleAmount}，实际=${actual.sale_amount}`)
      }
      if (!closeTo(actual.unit_real_price, expected.unitRealPrice)) {
        errors.push(`[${label}] row${i}.unit_real_price 应=${expected.unitRealPrice}，实际=${actual.unit_real_price}`)
      }
      if (!closeTo(actual.pending_received, expected.saleAmount)) {
        errors.push(`[${label}] row${i}.pending_received 应=${expected.saleAmount}，实际=${actual.pending_received}`)
      }
      if (Number(actual.received) !== 0) {
        errors.push(`[${label}] row${i}.received 应=0（开单两步式不入账），实际=${actual.received}`)
      }
    }
  }

  return errors
}

async function main() {
  rec(`[smoke-order-tier-pricing] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const categoryId = `${NS}_CAT_TIER`
  const sharedName = `${NS}_净化美人`
  const sku15 = await createTestProduct({
    suffix: 'TIER15',
    categoryId,
    specName: sharedName,
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销他耗',
    price: 3000,
    sessionCount: 15,
    isShengmei: true,
  })
  const sku1 = await createTestProduct({
    suffix: 'TIER01',
    categoryId,
    specName: sharedName,
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销他耗',
    price: 300,
    sessionCount: 1,
    isShengmei: true,
  })
  rec(`  ✓ fixture: ${sharedName} 15次=¥3000, 1次=¥300`)

  const basePayload = {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    items: [
      { skuId: sku15.skuId, quantity: 1 },
      { skuId: sku1.skuId, quantity: 1 },
    ],
    paymentMethod: '线下',
    saleOrderType: '销售单',
  }

  const result = await invokeStaffApi('order.create', {
    ...basePayload,
    remark: 'e2e-smoke-tier-pricing',
  })
  rec(`  no-coupon result.code=${result.code} message=${result.message}`)
  if (result.code !== 0) {
    rec(`  ✗ FAIL: 无券阶梯价订单应成功，实际 ${result.code} (${result.message})`)
    return
  }

  const noCouponErrors = await assertOrderLines({
    saleOrderId: result.data.saleOrderId,
    expectedTotal: 3200,
    expectedRows: [
      { skuId: sku15.skuId, sessionCount: 15, saleAmount: 3000, unitRealPrice: 200 },
      { skuId: sku1.skuId, sessionCount: 1, saleAmount: 200, unitRealPrice: 200 },
    ],
    label: '无券',
  })
  await pgQuery(
    `UPDATE sale_orders SET status = '已关闭' WHERE sale_order_id = $1`,
    [result.data.saleOrderId],
  )

  const { couponId } = await createTestCoupon({
    couponId: `${NS}_UC_TIER`,
    templateId: `${NS}_CTPL_TIER`,
    couponType: '现金券',
    minSpend: 100,
    discountValue: 200,
  })
  const couponResult = await invokeStaffApi('order.create', {
    ...basePayload,
    couponId,
    remark: 'e2e-smoke-tier-pricing-coupon',
  })
  rec(`  coupon result.code=${couponResult.code} message=${couponResult.message}`)
  if (couponResult.code !== 0) {
    rec(`  ✗ FAIL: 带券阶梯价订单应成功，实际 ${couponResult.code} (${couponResult.message})`)
    return
  }

  const couponErrors = await assertOrderLines({
    saleOrderId: couponResult.data.saleOrderId,
    expectedTotal: 3000,
    expectedRows: [
      { skuId: sku15.skuId, sessionCount: 15, saleAmount: 2812.5, unitRealPrice: 187.5 },
      { skuId: sku1.skuId, sessionCount: 1, saleAmount: 187.5, unitRealPrice: 187.5 },
    ],
    label: '带券',
  })

  const errors = [...noCouponErrors, ...couponErrors]
  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec('  ✅ PASS — 阶梯价先重算行基线，再按优惠券比例摊到 SKU 行')
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-tier-pricing] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-tier-pricing] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
