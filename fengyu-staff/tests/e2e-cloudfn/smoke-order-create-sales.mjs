#!/usr/bin/env bun
/**
 * order.create 销售单冒烟
 *
 * 验证：
 *   1. 店长用真实 SKU 开销售单（线下支付）
 *   2. sale_order_id = 'FY-XSD-WX-{YYMMDD}{4位}' 格式（advisory lock 路径）
 *   3. sale_items quantity / unit_price / received 计算正确
 *   4. payment_method = '线下' + 全额支付 → status = '待确认收款'
 *   5. sale_order_payments 立即写一行 change_type='首次支付' status='已支付'
 *   6. ref_order 写入 client_user_id 快照
 *
 * 失败时打印 result + diff 便于定位。
 */
import './setup.mjs'
import {
  NS,
  TEST_STORE_ID, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID,
  TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE,
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
  rec(`[smoke-order-create-sales] start | ${new Date().toISOString()}`)

  // ─── 1. fixture ───
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // 店长
  await createTestClient() // 已绑店顾客
  const { skuId, specName } = await createTestProduct({
    suffix: '1',
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销他耗',
    price: 500,
    sessionCount: 5,
    isShengmei: true,
  })
  rec(`  ✓ fixture: store=${TEST_STORE_ID} sku=${skuId} (¥500 × 5次)`)

  // ─── 2. 调用 order.create ───
  const result = await invokeStaffApi('order.create', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    items: [{ skuId, quantity: 2 }],
    paymentMethod: '线下',
    saleOrderType: '销售单',
    remark: 'e2e-smoke-create-sales',
  })
  rec(`  result.code=${result.code} message=${result.message}`)
  if (result.code !== 0) {
    rec(`  ✗ FAIL: 期望 code=0，实际 ${result.code} (${result.message})`)
    return
  }
  const { saleOrderId, totalAmount, status, paymentMethod, payableAmount } = result.data
  rec(`  saleOrderId=${saleOrderId} total=¥${totalAmount} status=${status} method=${paymentMethod} payable=${payableAmount}`)

  const errors = []

  // ─── 3. 关键断言 ───
  // 3.1 sale_order_id 格式
  if (!/^FY-XSD-WX-\d{6}\d{4}$/.test(saleOrderId)) {
    errors.push(`sale_order_id 格式不对（应 FY-XSD-WX-{YYMMDD}{4位}）: ${saleOrderId}`)
  }
  // 3.2 总价 = 500 × 2 = 1000
  if (Math.abs(Number(totalAmount) - 1000) > 0.001) {
    errors.push(`totalAmount 应=1000（500×2），实际=${totalAmount}`)
  }
  // 3.3 全额线下 + 无储值卡 → 状态 '待确认收款'
  if (status !== '待确认收款') {
    errors.push(`status 应='待确认收款'，实际='${status}'`)
  }
  if (paymentMethod !== '线下') {
    errors.push(`paymentMethod 应='线下'，实际='${paymentMethod}'`)
  }

  // 3.4 PG: sale_orders 行
  const orders = await pgQuery(
    `SELECT sale_order_id, status, total_amount, received, payable_amount,
            client_user_id, opened_by, sale_order_type, document_type, payment_method
     FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (orders.length !== 1) errors.push(`sale_orders 行数应=1，实际=${orders.length}`)
  else {
    const o = orders[0]
    if (o.client_user_id !== TEST_CLIENT_USER_ID) errors.push(`client_user_id 应=${TEST_CLIENT_USER_ID}, 实际=${o.client_user_id}`)
    if (o.opened_by !== TEST_MANAGER_EMP_ID) errors.push(`opened_by 应=${TEST_MANAGER_EMP_ID}, 实际=${o.opened_by}`)
    if (o.sale_order_type !== '销售单') errors.push(`sale_order_type 应='销售单'，实际='${o.sale_order_type}'`)
    if (Number(o.received) !== 1000) errors.push(`received 应=1000（线下全额已落账），实际=${o.received}`)
  }

  // 3.5 PG: sale_items 行
  const items = await pgQuery(
    `SELECT sale_item_id, sku_id, product_type, quantity, unit_price, unit_real_price,
            session_count, remaining_sessions, is_shengmei
     FROM sale_items WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (items.length !== 1) errors.push(`sale_items 行数应=1，实际=${items.length}`)
  else {
    const i = items[0]
    if (!/^XSLSH-WX-\d{8}\d{4}$/.test(i.sale_item_id)) errors.push(`sale_item_id 格式不对（应 XSLSH-WX-YYYYMMDD####）: ${i.sale_item_id}`)
    if (i.sku_id !== skuId) errors.push(`sku_id 应=${skuId}, 实际=${i.sku_id}`)
    if (Number(i.quantity) !== 2) errors.push(`quantity 应=2，实际=${i.quantity}`)
    if (Number(i.unit_price) !== 500) errors.push(`unit_price 应=500，实际=${i.unit_price}`)
    if (Number(i.unit_real_price) !== 500) errors.push(`unit_real_price 应=500（无优惠），实际=${i.unit_real_price}`)
    // 疗程卡 session_count = sku.session_count = 5
    if (Number(i.session_count) !== 5) errors.push(`session_count 应=5（疗程卡），实际=${i.session_count}`)
    if (i.is_shengmei !== true) errors.push(`is_shengmei 应=true（快照），实际=${i.is_shengmei}`)
  }

  // 3.6 PG: sale_order_payments 立即写"首次支付/已支付"
  const payments = await pgQuery(
    `SELECT change_type, amount, status, source_end, operator_employee_id
     FROM sale_order_payments WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (payments.length !== 1) errors.push(`sale_order_payments 行数应=1（线下全额开单立即落 '首次支付'），实际=${payments.length}`)
  else {
    const p = payments[0]
    if (p.change_type !== '首次支付') errors.push(`payments.change_type 应='首次支付'，实际='${p.change_type}'`)
    if (Number(p.amount) !== 1000) errors.push(`payments.amount 应=1000，实际=${p.amount}`)
    if (p.status !== '已支付') errors.push(`payments.status 应='已支付'，实际='${p.status}'`)
    if (p.source_end !== 'staff') errors.push(`payments.source_end 应='staff'，实际='${p.source_end}'`)
    if (p.operator_employee_id !== TEST_MANAGER_EMP_ID) errors.push(`payments.operator 应=${TEST_MANAGER_EMP_ID}, 实际=${p.operator_employee_id}`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 销售单开单完整链路正确（order=${saleOrderId}, 1000 元, 待确认收款）`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-create-sales] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-create-sales] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
