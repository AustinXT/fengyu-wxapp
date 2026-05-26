#!/usr/bin/env bun
/**
 * order.create 内部单冒烟
 *
 * 验证：
 *   1. saleOrderType='内部单' 时单价自动 ×50%（员工消费 5 折）
 *   2. 内部单不允许 customPrice
 *   3. 内部单不允许叠加优惠券
 *   4. 非店长调用必拒（PERMISSION_DENIED）
 *   5. sale_orders.sale_order_type='内部单' 落库
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_PHONE,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestProduct, createTestCoupon, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1

function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-order-create-internal] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // manager
  // 非店长员工（用于权限测试）
  await createTestStaff({
    employeeId: `${NS}_STAFF1`,
    openid: `${NS}_STAFF1_OPENID`,
    phone: '19999098003',
    name: `${NS}_美容师`,
    isManager: false,
    positionName: '美容师',
  })
  await createTestClient()
  const { skuId } = await createTestProduct({
    suffix: '1',
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销自耗',
    price: 800,
    sessionCount: 1,
  })
  rec(`  ✓ fixture: sku=${skuId} (¥800 单品)`)

  const errors = []

  // ─── 1. 非店长开内部单必拒 ───
  const denyResult = await invokeStaffApi('order.create', {
    _testOpenid: `${NS}_STAFF1_OPENID`,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    saleOrderType: '内部单',
  })
  if (denyResult.code === 0) {
    errors.push(`非店长开内部单应被拒，实际成功 saleOrderId=${denyResult.data?.saleOrderId}`)
  } else if (denyResult.code !== -403) {
    errors.push(`非店长应得 code=-403（PERMISSION_DENIED），实际 code=${denyResult.code} msg=${denyResult.message}`)
  } else {
    rec(`  ✓ 非店长开内部单被拒（code=-403, ${denyResult.message}）`)
  }

  // ─── 2. 内部单不允许优惠券 ───
  const { couponId } = await createTestCoupon({})
  const couponResult = await invokeStaffApi('order.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    saleOrderType: '内部单',
    couponId,
  })
  if (couponResult.code === 0) {
    errors.push(`内部单叠加优惠券应被拒，实际成功`)
  } else if (!String(couponResult.message || '').includes('优惠券')) {
    errors.push(`内部单 + 优惠券应得 INVALID_PARAMS:'内部单不允许叠加优惠券'，实际 ${couponResult.message}`)
  } else {
    rec(`  ✓ 内部单 + 优惠券被拒（${couponResult.message}）`)
  }

  // 注：行级 customPrice/discount 入参已于 order.js 废弃（静默忽略，不再报错），故不再断言其被拒。

  // ─── 3. 店长成功开内部单 → 5 折 ───
  const result = await invokeStaffApi('order.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    saleOrderType: '内部单',
  })
  if (result.code !== 0) {
    errors.push(`店长开内部单应成功，实际 code=${result.code} (${result.message})`)
  } else {
    const { saleOrderId, totalAmount } = result.data
    rec(`  ✓ 店长开内部单成功: ${saleOrderId} total=¥${totalAmount}`)
    // 5 折：800 × 50% = 400
    if (Math.abs(Number(totalAmount) - 400) > 0.001) {
      errors.push(`内部单 5 折后 totalAmount 应=400（800×50%），实际=${totalAmount}`)
    }
    // sale_orders.sale_order_type
    const orders = await pgQuery(
      `SELECT sale_order_type, total_amount FROM sale_orders WHERE sale_order_id = $1`,
      [saleOrderId]
    )
    if (orders.length !== 1) errors.push(`sale_orders 行数=${orders.length}`)
    else if (orders[0].sale_order_type !== '内部单') {
      errors.push(`sale_order_type 应='内部单'，实际='${orders[0].sale_order_type}'`)
    }
    // sale_items.unit_price=400 (内部单 unitPrice 已 ×50%)
    const items = await pgQuery(
      `SELECT unit_price, unit_real_price FROM sale_items WHERE sale_order_id = $1`,
      [saleOrderId]
    )
    if (items.length === 1) {
      if (Number(items[0].unit_price) !== 400) errors.push(`unit_price 应=400（5 折后），实际=${items[0].unit_price}`)
    }
  }

  // ─── 4. 同顾客已有待支付订单时，再开单必拒（一顾客一待支付单守卫）───
  // 步骤 3 已为 TEST_CLIENT 留下一张 '待支付' 内部单，此处再开单应被显式拒绝。
  const dupResult = await invokeStaffApi('order.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    items: [{ skuId, quantity: 1 }],
    paymentMethod: '线下',
    saleOrderType: '内部单',
  })
  if (dupResult.code === 0) {
    errors.push(`顾客已有待支付订单时再开单应被拒，实际成功 saleOrderId=${dupResult.data?.saleOrderId}`)
  } else if (!String(dupResult.message || '').includes('待支付订单')) {
    errors.push(`再开单应得 INVALID_PARAMS:'该顾客已有待支付订单…'，实际 code=${dupResult.code} msg=${dupResult.message}`)
  } else {
    rec(`  ✓ 顾客已有待支付订单时再开单被拒（${dupResult.message}）`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 内部单 5 折 + 守卫（非店长拒/优惠券拒/一顾客一待支付单拒）全部正确`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-create-internal] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-create-internal] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
