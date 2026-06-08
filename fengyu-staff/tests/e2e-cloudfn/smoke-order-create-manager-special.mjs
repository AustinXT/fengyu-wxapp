#!/usr/bin/env bun
/**
 * order.create 店长特别优惠（is_manager_special）冒烟
 *
 * 验证：
 *   1. SKU 标记 is_manager_special=true 时，店长开销售单可把应付金额下调到标价以下
 *   2. sale_items.sale_amount 落库 = 店长改后的低应付（真打折，营业额按低额计）
 *   3. sale_items.is_manager_special 行级快照 = true（权威 = DB，不信前端）
 *   4. unit_real_price = sale_amount / session_count（per-session 派生正确）
 *
 * 前端门控 + 后端透传方案：后端不新增按 is_manager_special 的强校验，
 * 沿用现有「成交价 ≤ 标价」防涨价上界（已允许下调）。本 smoke 验证落库口径。
 */
import './setup.mjs'
import {
  NS,
  TEST_STORE_ID, TEST_MANAGER_OPENID,
  TEST_CLIENT_PHONE,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestProduct, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1

function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-order-create-manager-special] start | ${new Date().toISOString()}`)

  // ─── 1. fixture：建普通商品 SKU（price=500, session_count=5），再标 is_manager_special=true ───
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
  // 标记为店长特别优惠（createTestProduct 不含该参数，单独 UPDATE）
  await pgQuery(`UPDATE product_skus SET is_manager_special = true WHERE sku_id = $1`, [skuId])
  rec(`  ✓ fixture: sku=${skuId} (¥500 × 5次, is_manager_special=true)`)

  // ─── 2. 调用 order.create：店长把应付从 500 下调到 300（qty=1）───
  //   前端透传：unitPrice=标价 500、unitRealPrice=应付/qty=300、saleAmount=300、received=300
  const result = await invokeStaffApi('order.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    items: [{
      skuId,
      quantity: 1,
      unitPrice: '500',
      unitRealPrice: '300',
      saleAmount: '300',
      received: 300,
    }],
    paymentMethod: '线下',
    saleOrderType: '销售单',
    remark: 'e2e-smoke-manager-special',
  })
  rec(`  result.code=${result.code} message=${result.message}`)
  if (result.code !== 0) {
    rec(`  ✗ FAIL: 期望 code=0，实际 ${result.code} (${result.message})`)
    return
  }
  const { saleOrderId, totalAmount } = result.data
  rec(`  saleOrderId=${saleOrderId} total=¥${totalAmount}`)

  const errors = []

  // 2.1 营业额 = 改后低应付 300（真打折）
  if (Math.abs(Number(totalAmount) - 300) > 0.001) {
    errors.push(`totalAmount 应=300（店长改后应付），实际=${totalAmount}`)
  }

  // ─── 3. PG: sale_items 行级断言 ───
  const items = await pgQuery(
    `SELECT sale_item_id, sku_id, quantity, unit_price, unit_real_price,
            sale_amount, session_count, is_manager_special, received, pending_received
     FROM sale_items WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (items.length !== 1) {
    errors.push(`sale_items 行数应=1，实际=${items.length}`)
  } else {
    const i = items[0]
    if (i.is_manager_special !== true) errors.push(`is_manager_special 应=true（DB 权威快照），实际=${i.is_manager_special}`)
    if (Math.abs(Number(i.sale_amount) - 300) > 0.001) errors.push(`sale_amount 应=300（店长改后应付落库），实际=${i.sale_amount}`)
    // per-session：unit_real_price = sale_amount / session_count = 300/5 = 60
    if (Math.abs(Number(i.unit_real_price) - 60) > 0.001) errors.push(`unit_real_price 应=60（300/5），实际=${i.unit_real_price}`)
    // unit_price 标价快照 = 标价行总额 / session_count = 500/5 = 100（不随改应付变动）
    if (Math.abs(Number(i.unit_price) - 100) > 0.001) errors.push(`unit_price 应=100（标价 500/5，不随改应付变动），实际=${i.unit_price}`)
    // 实付草稿落 pending_received = 改后应付 300；行 received 两步式开单恒 0
    if (Number(i.received) !== 0) errors.push(`received 应=0（两步式开单不记账），实际=${i.received}`)
    if (Math.abs(Number(i.pending_received) - 300) > 0.001) errors.push(`pending_received 应=300（行实付草稿=改后应付），实际=${i.pending_received}`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 店长特别优惠改应付链路正确（order=${saleOrderId}, 应付 500→300, is_manager_special 快照=true）`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-create-manager-special] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-create-manager-special] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
