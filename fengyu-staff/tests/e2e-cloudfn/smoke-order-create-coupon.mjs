#!/usr/bin/env bun
/**
 * order.create 带优惠券开单冒烟（回归：券 claim FK 顺序）
 *
 * 回归点（2026-05-21 staff 端修复）：
 *   user_coupons.used_sale_order_id → sale_orders.sale_order_id 的 FK 非 deferrable（立即校验）。
 *   旧版 order.create 在 INSERT sale_orders 之前就 `UPDATE user_coupons SET used_sale_order_id=...`，
 *   引用的订单尚不存在 → FK 违约 → 全局 catch 降级成 {code:-1, errorType:null}。
 *   修复：把券 claim 移到 INSERT sale_orders 之后。
 *
 * 验证：
 *   1. 店长带 couponId 开销售单 → code=0（旧版会 -1）
 *   2. sale_orders.coupon_id / coupon_discount / total_amount 正确（500 - 30 = 470）
 *   3. user_coupons 原子 claim：status='已使用' + used_sale_order_id 指向本单（FK 顺序回归点）
 *
 * 失败时打印 result + diff 便于定位。
 */
import './setup.mjs'
import {
  NS,
  TEST_STORE_ID, TEST_MANAGER_OPENID,
  TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE,
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
  rec(`[smoke-order-create-coupon] start | ${new Date().toISOString()}`)

  // ─── 1. fixture ───
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // 店长
  await createTestClient() // 已绑店顾客
  const { skuId } = await createTestProduct({
    suffix: '1',
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销他耗',
    price: 500,
    sessionCount: 5,
    isShengmei: true,
  })
  // 满200减30 现金券（无品类/商品限制 → 适用全部商品）
  const { couponId } = await createTestCoupon({ couponType: '现金券', minSpend: 200, discountValue: 30 })
  rec(`  ✓ fixture: sku=${skuId} (¥500) coupon=${couponId} (满200减30)`)

  // ─── 2. 调用 order.create（带券）───
  const result = await invokeStaffApi('order.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    items: [{ skuId, quantity: 1 }],
    couponId,
    paymentMethod: '线下',
    saleOrderType: '销售单',
    remark: 'e2e-smoke-create-coupon',
  })
  rec(`  result.code=${result.code} message=${result.message}`)
  if (result.code !== 0) {
    // 旧版 FK 违约会走到这里：code=-1 / errorType=null / message='服务器内部错误'
    rec(`  ✗ FAIL: 期望 code=0（券 claim FK 顺序回归），实际 ${result.code} (${result.message})`)
    return
  }
  const { saleOrderId } = result.data
  rec(`  saleOrderId=${saleOrderId}`)

  const errors = []

  // ─── 3. 订单：total=470 / coupon_discount=30 / coupon_id=本券 ───
  const orders = await pgQuery(
    `SELECT total_amount, coupon_discount, coupon_id, status
     FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (orders.length !== 1) errors.push(`sale_orders 行数应=1，实际=${orders.length}`)
  else {
    const o = orders[0]
    if (Number(o.total_amount) !== 470) errors.push(`total_amount 应=470（500-30券），实际=${o.total_amount}`)
    if (Number(o.coupon_discount) !== 30) errors.push(`coupon_discount 应=30，实际=${o.coupon_discount}`)
    if (o.coupon_id !== couponId) errors.push(`coupon_id 应=${couponId}，实际=${o.coupon_id}`)
  }

  // ─── 4. 券原子 claim：status='已使用' + used_sale_order_id 指向本单（FK 顺序回归点）───
  const uc = await pgQuery(
    `SELECT status, used_sale_order_id FROM user_coupons WHERE coupon_id = $1`,
    [couponId]
  )
  if (uc.length !== 1) errors.push(`user_coupons 行数应=1，实际=${uc.length}`)
  else {
    if (uc[0].status !== '已使用') errors.push(`coupon status 应='已使用'，实际='${uc[0].status}'`)
    if (uc[0].used_sale_order_id !== saleOrderId) {
      errors.push(`used_sale_order_id 应=${saleOrderId}（FK 顺序回归点），实际=${uc[0].used_sale_order_id}`)
    }
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 带券开单链路正确（order=${saleOrderId}, 470 元, 券已原子 claim 指向本单）`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-create-coupon] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-create-coupon] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
