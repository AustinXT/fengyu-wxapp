#!/usr/bin/env bun
/**
 * 逐项退款归因冒烟（2026-06-08 退款侧：received 变净额 + paid_sessions 按项扣减）
 *
 * 验证「退一项不连累其它行」：
 *   订单1（单项退款 ref_sale_item_id 设值）：3 张卡各 sale_amount=650/1次，付清 received=[650,650,650]。
 *     退卡C（单项）→ approveRefund STEP 1.5 按 note.items 扣 → received=[650,650,0]、paid_sessions=[1,1,0]；
 *     卡A/B 不变；SUM(received)=1300=净额；order.refunded_amount=650。
 *   订单2（多项退款 ref=NULL，明细在 note.items JSON 多元素）：同样 3 卡付清。
 *     一次退卡A+卡B → received=[0,0,650]、paid_sessions=[0,0,1]；卡C 不变；SUM=650；refunded=1300。
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
const r2 = (n) => Math.round(Number(n) * 100) / 100

// 建一个 3 卡付清单（各 650/1次），返回 [item1, item2, item3]
async function make3CardPaidOrder(orderNo) {
  const i2 = `${orderNo}_ITEM_2`, i3 = `${orderNo}_ITEM_3`
  await createTestSaleOrder({
    saleOrderId: orderNo, clientUserId: TEST_CLIENT_USER_ID,
    productName: `${NS}_卡1`, productType: '疗程卡', sessionCount: 1,
    totalAmount: 650, status: '已支付', salesCategory: '他销自耗',
  })
  await createTestSaleItem({
    saleOrderId: orderNo, saleItemId: i2, productName: `${NS}_卡2`,
    productType: '疗程卡', unitPrice: 650, quantity: 1, sessionCount: 1, salesCategory: '他销自耗',
  })
  await createTestSaleItem({
    saleOrderId: orderNo, saleItemId: i3, productName: `${NS}_卡3`,
    productType: '疗程卡', unitPrice: 650, quantity: 1, sessionCount: 1, salesCategory: '他销自耗',
  })
  await pgQuery(`UPDATE sale_orders SET total_amount=1950, payable_amount=1950, received=1950 WHERE sale_order_id=$1`, [orderNo])
  const rows = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id=$1 ORDER BY sale_item_id`, [orderNo])
  return rows.map((r) => r.sale_item_id)  // [ITEM_1, ITEM_2, ITEM_3]
}

async function fetchItems(orderNo) {
  const rows = await pgQuery(
    `SELECT sale_item_id, received, paid_sessions FROM sale_items WHERE sale_order_id=$1`, [orderNo])
  const map = Object.fromEntries(rows.map((x) => [x.sale_item_id, x]))
  const sum = r2(rows.reduce((s, x) => s + Number(x.received), 0))
  return { map, sum }
}

async function main() {
  rec(`[smoke-order-refund-per-item] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore(); await createTestStaff(); await createTestClient()
  const errors = []

  // ───────────── 订单1：单项退款（退卡C）─────────────
  const o1 = `${NS}_RPI1`
  const [a1, b1, c1] = await make3CardPaidOrder(o1)
  const ref1 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o1,
    items: [{ saleItemId: c1, refundQuantity: 1 }], refundReason: 'e2e_refund_single',
  })
  if (ref1.code !== 0) {
    errors.push(`订单1 createRefund 应成功，实际 code=${ref1.code} msg=${ref1.message}`)
  } else {
    const apr1 = await invokeStaffApi('order.approveRefund', {
      _testOpenid: TEST_MANAGER_OPENID, paymentId: ref1.data.paymentId, auditRemark: 'e2e',
    })
    if (apr1.code !== 0) {
      errors.push(`订单1 approveRefund 应成功，实际 code=${apr1.code} msg=${apr1.message}`)
    } else {
      const { map, sum } = await fetchItems(o1)
      const ord = await pgQuery(`SELECT refunded_amount FROM sale_orders WHERE sale_order_id=$1`, [o1])
      // 核心：退卡C → 卡C received=0/paid_sessions=0；卡A/B 完全不变
      if (r2(map[a1].received) !== 650) errors.push(`单项退后 卡A.received 应=650（不连累），实际 ${map[a1].received}`)
      if (r2(map[b1].received) !== 650) errors.push(`单项退后 卡B.received 应=650（不连累），实际 ${map[b1].received}`)
      if (r2(map[c1].received) !== 0)   errors.push(`单项退后 卡C.received 应=0（被退净额归零），实际 ${map[c1].received}`)
      if (Number(map[a1].paid_sessions) !== 1) errors.push(`单项退后 卡A.paid_sessions 应=1（不连累），实际 ${map[a1].paid_sessions}`)
      if (Number(map[b1].paid_sessions) !== 1) errors.push(`单项退后 卡B.paid_sessions 应=1（不连累），实际 ${map[b1].paid_sessions}`)
      if (Number(map[c1].paid_sessions) !== 0) errors.push(`单项退后 卡C.paid_sessions 应=0，实际 ${map[c1].paid_sessions}`)
      if (sum !== 1300) errors.push(`单项退后 SUM(received) 应=1300（净额=1950-650），实际 ${sum}`)
      if (r2(ord[0].refunded_amount) !== 650) errors.push(`单项退后 order.refunded_amount 应=650，实际 ${ord[0].refunded_amount}`)
      if (errors.length === 0) rec(`  ✅ 单项退款：卡C received=0/ps=0、卡A/B 不变、SUM=1300 净额`)
    }
  }

  // ───────────── 订单2：多项退款（一次退卡A+卡B，note.items 多元素）─────────────
  const pre2 = errors.length
  const o2 = `${NS}_RPI2`
  const [a2, b2, c2] = await make3CardPaidOrder(o2)
  const ref2 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o2,
    items: [{ saleItemId: a2, refundQuantity: 1 }, { saleItemId: b2, refundQuantity: 1 }],
    refundReason: 'e2e_refund_multi',
  })
  if (ref2.code !== 0) {
    errors.push(`订单2 createRefund(多项) 应成功，实际 code=${ref2.code} msg=${ref2.message}`)
  } else {
    // 多项退款 ref_sale_item_id 应为 NULL（明细在 note.items）
    const sop = await pgQuery(`SELECT ref_sale_item_id, note FROM sale_order_payments WHERE id=$1`, [ref2.data.paymentId])
    if (sop[0].ref_sale_item_id !== null) errors.push(`订单2 多项退款 ref_sale_item_id 应=NULL，实际 ${sop[0].ref_sale_item_id}`)
    const note = JSON.parse(sop[0].note || '{}')
    if (!Array.isArray(note.items) || note.items.length !== 2) errors.push(`订单2 note.items 应=2 元素，实际 ${note.items?.length}`)
    const apr2 = await invokeStaffApi('order.approveRefund', {
      _testOpenid: TEST_MANAGER_OPENID, paymentId: ref2.data.paymentId, auditRemark: 'e2e',
    })
    if (apr2.code !== 0) {
      errors.push(`订单2 approveRefund 应成功，实际 code=${apr2.code} msg=${apr2.message}`)
    } else {
      const { map, sum } = await fetchItems(o2)
      // 核心：一次退卡A+卡B → 各自独立归零，卡C 不变
      if (r2(map[a2].received) !== 0) errors.push(`多项退后 卡A.received 应=0，实际 ${map[a2].received}`)
      if (r2(map[b2].received) !== 0) errors.push(`多项退后 卡B.received 应=0，实际 ${map[b2].received}`)
      if (r2(map[c2].received) !== 650) errors.push(`多项退后 卡C.received 应=650（不连累），实际 ${map[c2].received}`)
      if (Number(map[a2].paid_sessions) !== 0) errors.push(`多项退后 卡A.paid_sessions 应=0，实际 ${map[a2].paid_sessions}`)
      if (Number(map[b2].paid_sessions) !== 0) errors.push(`多项退后 卡B.paid_sessions 应=0，实际 ${map[b2].paid_sessions}`)
      if (Number(map[c2].paid_sessions) !== 1) errors.push(`多项退后 卡C.paid_sessions 应=1（不连累），实际 ${map[c2].paid_sessions}`)
      if (sum !== 650) errors.push(`多项退后 SUM(received) 应=650（净额=1950-1300），实际 ${sum}`)
      if (errors.length === pre2) rec(`  ✅ 多项退款：卡A/B 各自归零、卡C 不变、SUM=650 净额`)
    }
  }

  await cleanupTestData(NS)
  await closePool()
  if (errors.length > 0) {
    rec(`[smoke-order-refund-per-item] FAIL`)
    for (const e of errors) rec(`  ❌ ${e}`)
    process.exit(1)
  }
  rec(`[smoke-order-refund-per-item] end | all passed`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
