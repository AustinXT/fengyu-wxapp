#!/usr/bin/env bun
/**
 * order.createRepayment 按子项定向回款冒烟（ticket 2026-05-21 REQ2）
 *
 * 验证「真·按子项定向」：付清 A 疗程卡 → 只解锁 A 的 paid_sessions，B 单品不动。
 *   订单：A 疗程卡(sale_amount=1000, 10次) + B 单品(sale_amount=500, 1次)，total=1500，待回款。
 *   1. 定向回款 A ¥1000（items[{A,1000}]）→ A.received=1000/paid_sessions=10；B.received=0/paid_sessions=0；
 *      order.received=1000、status=部分支付；回款 payment 行带 ref_sale_item_id=A；Σ(item.received)=order.received。
 *   2. 定向回款 B ¥500 → B.received=500/paid_sessions=1；order.received=1500、status=已支付。
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, createTestSaleItem, cleanupTestData,
} from './helpers/fixtures.mjs'

function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-order-repay-per-item] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const orderNo = `${NS}_RPI`
  // 订单 + item A（疗程卡 1000 / 10 次）
  await createTestSaleOrder({
    saleOrderId: orderNo, clientUserId: TEST_CLIENT_USER_ID,
    productName: `${NS}_A疗程卡`, productType: '疗程卡', sessionCount: 10,
    totalAmount: 1000, status: '部分支付', salesCategory: '他销自耗',
  })
  const itemA = `${orderNo}_ITEM_1`
  // 追加 item B（单品 500 / 1 次）
  const itemB = `${orderNo}_ITEM_2`
  await createTestSaleItem({
    saleOrderId: orderNo, saleItemId: itemB,
    productName: `${NS}_B单品`, productType: '单品', unitPrice: 500, quantity: 1,
    sessionCount: 1, salesCategory: '他销自耗',
  })
  // 订单总额改为 1500（A1000 + B500），received 起点 0
  await pgQuery(
    `UPDATE sale_orders SET total_amount = 1500, payable_amount = 1500, received = 0 WHERE sale_order_id = $1`,
    [orderNo]
  )
  // fixture 直插的 sale_items.received 默认 = sale_amount（绕过了 recalc）；
  // 真实 待支付/部分支付 单经 recalc STEP 1 后 received 应与 order.received 一致，此处归零模拟之。
  await pgQuery(`UPDATE sale_items SET received = 0 WHERE sale_order_id = $1`, [orderNo])

  const errors = []
  const r2 = (n) => Math.round(Number(n) * 100) / 100

  // ── 1. 定向回款 A ¥1000 ──
  const repA = await invokeStaffApi('order.createRepayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderNo,
    paymentMethod: '线下',
    items: [{ saleItemId: itemA, repayAmount: 1000 }],
    note: 'e2e_repay_A',
  })
  if (repA.code !== 0) {
    errors.push(`定向回款 A 应成功，实际 code=${repA.code} msg=${repA.message}`)
  } else {
    const rows = await pgQuery(
      `SELECT sale_item_id, received, paid_sessions FROM sale_items WHERE sale_order_id = $1 ORDER BY sale_item_id`,
      [orderNo]
    )
    const a = rows.find((x) => x.sale_item_id === itemA)
    const b = rows.find((x) => x.sale_item_id === itemB)
    if (r2(a.received) !== 1000) errors.push(`A.received 应=1000，实际 ${a.received}`)
    if (Number(a.paid_sessions) !== 10) errors.push(`A.paid_sessions 应=10，实际 ${a.paid_sessions}`)
    if (r2(b.received) !== 0) errors.push(`B.received 应=0（未定向），实际 ${b.received}`)
    if (Number(b.paid_sessions) !== 0) errors.push(`B.paid_sessions 应=0，实际 ${b.paid_sessions}`)

    const ord = await pgQuery(`SELECT received, status FROM sale_orders WHERE sale_order_id = $1`, [orderNo])
    if (r2(ord[0].received) !== 1000) errors.push(`order.received 应=1000，实际 ${ord[0].received}`)
    if (ord[0].status !== '部分支付') errors.push(`order.status 应=部分支付，实际 ${ord[0].status}`)
    const sumRecv = r2(rows.reduce((s, x) => s + Number(x.received), 0))
    if (sumRecv !== r2(ord[0].received)) errors.push(`Σ(item.received)=${sumRecv} 应=order.received=${ord[0].received}`)

    const payRow = await pgQuery(
      `SELECT ref_sale_item_id, amount FROM sale_order_payments
       WHERE sale_order_id = $1 AND change_type = '回款' AND status = '已支付'`,
      [orderNo]
    )
    if (payRow.length !== 1) errors.push(`应有 1 行 回款 payment，实际 ${payRow.length}`)
    else if (payRow[0].ref_sale_item_id !== itemA) errors.push(`回款行 ref_sale_item_id 应=${itemA}，实际 ${payRow[0].ref_sale_item_id}`)
    if (errors.length === 0) rec(`  ✅ 定向回款 A：A.paid_sessions=10、B=0、Σ守恒、payment.ref=A`)
  }

  // ── 2. 定向回款 B ¥500（付清）──
  const repB = await invokeStaffApi('order.createRepayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderNo,
    paymentMethod: '线下',
    items: [{ saleItemId: itemB, repayAmount: 500 }],
    note: 'e2e_repay_B',
  })
  if (repB.code !== 0) {
    errors.push(`定向回款 B 应成功，实际 code=${repB.code} msg=${repB.message}`)
  } else {
    const rows = await pgQuery(
      `SELECT sale_item_id, received, paid_sessions FROM sale_items WHERE sale_order_id = $1`,
      [orderNo]
    )
    const b = rows.find((x) => x.sale_item_id === itemB)
    if (r2(b.received) !== 500) errors.push(`B.received 应=500，实际 ${b.received}`)
    if (Number(b.paid_sessions) !== 1) errors.push(`B.paid_sessions 应=1，实际 ${b.paid_sessions}`)
    const ord = await pgQuery(`SELECT received, status FROM sale_orders WHERE sale_order_id = $1`, [orderNo])
    if (r2(ord[0].received) !== 1500) errors.push(`order.received 应=1500，实际 ${ord[0].received}`)
    if (ord[0].status !== '已支付') errors.push(`order.status 应=已支付，实际 ${ord[0].status}`)
    if (errors.filter((e) => e.includes('B ')).length === 0) rec(`  ✅ 定向回款 B：B.paid_sessions=1、order 付清=已支付`)
  }

  await cleanupTestData(NS)
  await closePool()

  if (errors.length > 0) {
    rec(`[smoke-order-repay-per-item] FAIL`)
    for (const e of errors) rec(`  ❌ ${e}`)
    process.exit(1)
  }
  rec(`[smoke-order-repay-per-item] end | all passed`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
