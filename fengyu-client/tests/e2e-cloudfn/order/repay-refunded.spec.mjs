#!/usr/bin/env bun
/**
 * clientApi.order.repay 行级退款感知（ticket 2026-07-21 已退款行不可继续支付）
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js
 *   - list/detail/scanDetail：返回 item.refunded_amount（行级退款额，从 note.items[].refundAmount 聚合）
 *   - repay：有退款时 remaining = Σ「未退且未付清」行欠款（已退行不计入），capture 定向到未退行
 *
 * 核心场景（用户报告 bug）：单行 1000，付 300 退 300 → 顾客端不应再显示/受理「继续支付」。
 * 行级精确：多行（A 已退 + B 未付清）→ 允许继续支付 B，A 不复活。
 *
 * 造数要点：
 *   - status='部分支付' + received（毛，不减退款）+ refunded_amount（正数）
 *   - 种 1 行已支付「首次支付」撑住 received 不变量
 *   - 种 1 行已支付「退款」（amount<0，note.items[].refundAmount + refSaleItemId）
 *   - 同步 sale_items.received 为净额（等价 recalcPaidSessionsForOrder STEP1.5：毛 - 退款）
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID, TEST_SKU_NORMAL_ID,
} from '../setup.mjs'
import { invokeAs } from '../helpers/invoke-client.mjs'
import { createTestClient, cleanupTestData } from '../helpers/fixtures.mjs'
import {
  createTestPendingSaleOrder, createTestPrepaidCard, cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'

/** 种一行已支付「首次支付」（撑 received 不变量） */
async function seedFirstPayment(orderNo, amount, txnSuffix) {
  await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, external_txn_id,
       status, source_end, paid_at, created_at
     ) VALUES ($1, '首次支付', $2, '微信', $3, '已支付', 'client', NOW(), NOW())`,
    [orderNo, amount, `${NS}_${txnSuffix}_PAY`]
  )
}

/** 种一行已支付「退款」（amount<0，note.items[].refundAmount 指向行） */
async function seedRefundPayment(orderNo, refundAmount, saleItemId, productType = '疗程卡', fullItem = true) {
  await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, status, source_end, note, created_at, paid_at
     ) VALUES ($1, '退款', $2, '线下', '已支付', 'staff', $3, NOW(), NOW())`,
    [
      orderNo,
      -refundAmount,
      JSON.stringify({
        _v: 2,
        refundByCard: 0,
        refundByOrigin: refundAmount,
        isWholeOrderRefund: false,
        items: [{
          refSaleItemId: saleItemId,
          quantity: 1,
          refundAmount,
          productType,
          isFullItemRefund: fullItem,
          isOverpay: false,
        }],
      }),
    ]
  )
}

// 场景1（用户报告 bug）：单行 1000 疗程卡，付 300 退 300 → repay 必须被拒（无未退可付行）
async function caseRepayRefundedSingleLineRejected() {
  await createTestClient()
  const orderNo = `${NS}_RFRF1`.slice(0, 30)
  const { saleItemId } = await createTestPendingSaleOrder({
    saleOrderId: orderNo, totalAmount: 1000, productType: '疗程卡', sessionCount: 5,
  })
  await pgQuery(
    `UPDATE sale_orders SET status='部分支付', received=300, refunded_amount=300, payable_amount=1000
     WHERE sale_order_id = $1`,
    [orderNo]
  )
  await seedFirstPayment(orderNo, 300, 'RFRF1')
  await seedRefundPayment(orderNo, 300, saleItemId, '疗程卡', false)
  // 行净额：毛 300 - 退 300 = 0（等价 STEP1.5）
  await pgQuery(`UPDATE sale_items SET received=0 WHERE sale_item_id=$1`, [saleItemId])

  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo, paymentMethod: '储值卡', repayAmount: 0, prepaidCardAmount: 700,
  })
  if (res.code === 0) throw new Error(`expect reject, got success: ${JSON.stringify(res.data)}`)
  // 行级 remaining=0（唯一行已退）→ INVALID_STATE: 订单无欠款
  if (!String(res.message || '').includes('欠款')) {
    throw new Error(`expect message 含"欠款", got: ${res.message}`)
  }
}

// 场景2：detail / list 返回 item.refunded_amount（前端据此算 canContinuePay）
async function caseDetailListExposeRefundedAmount() {
  await createTestClient()
  const orderNo = `${NS}_RFRF2`.slice(0, 30)
  const { saleItemId } = await createTestPendingSaleOrder({
    saleOrderId: orderNo, totalAmount: 1000, productType: '疗程卡', sessionCount: 5,
  })
  await pgQuery(
    `UPDATE sale_orders SET status='部分支付', received=300, refunded_amount=300, payable_amount=1000
     WHERE sale_order_id = $1`,
    [orderNo]
  )
  await seedFirstPayment(orderNo, 300, 'RFRF2')
  await seedRefundPayment(orderNo, 300, saleItemId, '疗程卡', false)
  await pgQuery(`UPDATE sale_items SET received=0 WHERE sale_item_id=$1`, [saleItemId])

  const detail = await invokeAs(TEST_CLIENT_OPENID, 'order.detail', { saleOrderId: orderNo })
  if (detail.code !== 0) throw new Error(`detail failed: ${detail.message}`)
  const dItem = (detail.data?.items || []).find((i) => i.sale_item_id === saleItemId)
  if (!dItem) throw new Error('detail missing item')
  if (Number(dItem.refunded_amount) !== 300) {
    throw new Error(`expect detail item.refunded_amount=300, got: ${dItem.refunded_amount}`)
  }

  const list = await invokeAs(TEST_CLIENT_OPENID, 'order.list', { statuses: ['部分支付'] })
  if (list.code !== 0) throw new Error(`list failed: ${list.message}`)
  const lOrder = (list.data?.orders || []).find((o) => o.sale_order_id === orderNo)
  if (!lOrder) throw new Error('list missing order')
  const lItem = (lOrder.items || []).find((i) => i.sale_item_id === saleItemId)
  if (!lItem) throw new Error('list missing item')
  if (Number(lItem.refunded_amount) !== 300) {
    throw new Error(`expect list item.refunded_amount=300, got: ${lItem.refunded_amount}`)
  }
}

// 场景3（回归保护）：无退款回款正常 —— else 分支沿用订单级口径，不破坏现有行为
async function caseRepayNoRefundRegression() {
  await createTestClient()
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '500.00' })
  const orderNo = `${NS}_RFRF3`.slice(0, 30)
  await createTestPendingSaleOrder({
    saleOrderId: orderNo, totalAmount: 200, productType: '疗程卡', sessionCount: 5,
  })
  await pgQuery(
    `UPDATE sale_orders SET status='部分支付', received=80, payable_amount=200
     WHERE sale_order_id = $1`,
    [orderNo]
  )
  await seedFirstPayment(orderNo, 80, 'RFRF3')
  // 无退款：欠 120，强制全额 → received=200/已支付
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo, paymentMethod: '储值卡', repayAmount: 0, prepaidCardAmount: 120,
  })
  if (res.code !== 0) throw new Error(`expect success, got ${res.code}: ${res.message}`)
  const rows = await pgQuery(
    `SELECT received, status FROM sale_orders WHERE sale_order_id = $1`, [orderNo]
  )
  if (Number(rows[0].received) !== 200) throw new Error(`expect received=200, got: ${rows[0].received}`)
  if (rows[0].status !== '已支付') throw new Error(`expect status=已支付, got: ${rows[0].status}`)
}

// 场景4（行级精确，区分方案A/B的关键）：多行 A 付清退 700 + B 未付 300
//   → 允许继续支付 300（B），A 行 received 不复活（仍 0）
async function caseRepayMixedDirectedToNonRefundedRow() {
  await createTestClient()
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '500.00' })
  const orderNo = `${NS}_RFRF4`.slice(0, 30)
  // 造 total=1000 单行（A），再改造成两行 A=700 / B=300（家居产品，无次数，简化）
  const { saleItemId: itemA } = await createTestPendingSaleOrder({
    saleOrderId: orderNo, totalAmount: 1000, productType: '家居产品', sessionCount: null,
  })
  const itemB = `${orderNo}_I2`.slice(0, 30)
  await pgQuery(
    `UPDATE sale_items SET sale_amount=700, received=0 WHERE sale_item_id = $1`, [itemA]
  )
  await pgQuery(
    `INSERT INTO sale_items (
       sale_item_id, sale_order_id, store_id, item_direction, sku_id, product_name, product_type,
       unit_price, quantity, unit_real_price, sale_amount, received, is_experience
     ) VALUES ($1, $2, $3, '购买'::item_direction, $4, $5, '家居产品'::product_type,
               300, 1, 300, 300, 0, false)`,
    [itemB, orderNo, TEST_STORE_ID, TEST_SKU_NORMAL_ID, `${NS}_B商品`]
  )
  // 订单：A 付 700 退 700，B 未付。received=700（A 毛），refunded=700
  await pgQuery(
    `UPDATE sale_orders SET status='部分支付', received=700, refunded_amount=700, payable_amount=1000
     WHERE sale_order_id = $1`,
    [orderNo]
  )
  await seedFirstPayment(orderNo, 700, 'RFRF4')
  await seedRefundPayment(orderNo, 700, itemA, '家居产品', true)
  // A 净额 = 700 - 700 = 0
  await pgQuery(`UPDATE sale_items SET received=0 WHERE sale_item_id = $1`, [itemA])

  // 继续支付 300（B 欠款）→ 定向到 B
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.repay', {
    saleOrderId: orderNo, paymentMethod: '储值卡', repayAmount: 0, prepaidCardAmount: 300,
  })
  if (res.code !== 0) throw new Error(`expect success, got ${res.code}: ${res.message}`)
  // A 仍 0（不复活，STEP1.5 扣退兜底），B 补足 300
  const items = await pgQuery(
    `SELECT sale_item_id, received::numeric AS received FROM sale_items WHERE sale_order_id = $1`,
    [orderNo]
  )
  const aRow = items.find((r) => r.sale_item_id === itemA)
  const bRow = items.find((r) => r.sale_item_id === itemB)
  if (Number(aRow.received) !== 0) {
    throw new Error(`expect A(revoked) received=0 not revived, got: ${aRow.received}`)
  }
  if (Number(bRow.received) !== 300) {
    throw new Error(`expect B received=300, got: ${bRow.received}`)
  }
  // 验证 spai（营业额分配基数）只落到 B（directedItems 生效），A 无本次回款提成
  const spai = await pgQuery(
    `SELECT sale_item_id, amount::numeric AS amount
       FROM sale_payment_allocatable_items
       WHERE sale_order_id = $1 AND sale_item_id IN ($2, $3)`,
    [orderNo, itemA, itemB]
  )
  const aSpai = spai.filter((r) => r.sale_item_id === itemA).reduce((s, r) => s + Number(r.amount), 0)
  const bSpai = spai.filter((r) => r.sale_item_id === itemB).reduce((s, r) => s + Number(r.amount), 0)
  if (aSpai > 0) throw new Error(`expect A spai=0 (refunded row no commission), got: ${aSpai}`)
  if (Math.abs(bSpai - 300) > 0.01) throw new Error(`expect B spai=300, got: ${bSpai}`)
}

const CASES = [
  ['单行 付300退300 → repay 被拒（无未退可付行）', caseRepayRefundedSingleLineRejected],
  ['detail/list 返回 item.refunded_amount=300', caseDetailListExposeRefundedAmount],
  ['无退款回款正常（回归保护）', caseRepayNoRefundRegression],
  ['多行 A退700+B未付300 → 定向付 B、A 不复活、spai 只落 B', caseRepayMixedDirectedToNonRefundedRow],
]

let pass = 0, fail = 0
console.log(`[order/repay-refunded.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[order/repay-refunded.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
