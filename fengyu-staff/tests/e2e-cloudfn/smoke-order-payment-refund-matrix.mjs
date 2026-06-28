#!/usr/bin/env bun
/**
 * 订单支付/回款/退款全场景矩阵冒烟（2026-06-28）
 *
 * 覆盖 15 个交叉场景：支付类型(首次/回款) × 储值卡(有/无) × 定向 × 退款(有/无) × 单卡/多卡。
 * 核心规则：
 * 1. 退款全部走现金（refundByCard=0），不回冲储值卡
 * 2. confirmOffline 通过 pending_received 实现定向；createRepayment 通过 items[] 定向
 * 3. 现金+储值卡混合回款用 paymentMethod='线下'（'储值卡' 仅纯储值卡回款）
 * 4. 疗程卡退款必须整卡全退（退 remainingSessions），金额 = remainingSessions × unit_real_price
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID, pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, createTestSaleItem, createTestPrepaidCard, cleanupTestData,
} from './helpers/fixtures.mjs'

function rec(line) { console.log(line) }
const r2 = (n) => Math.round(Number(n) * 100) / 100
const errors = []

async function fetchItems(orderNo) {
  return await pgQuery(
    `SELECT sale_item_id, received, paid_sessions, pending_received, remaining_sessions, session_count, sale_amount
     FROM sale_items WHERE sale_order_id=$1 ORDER BY sale_item_id`, [orderNo])
}
async function fetchOrder(orderNo) {
  const rows = await pgQuery(
    `SELECT received, status, prepaid_card_amount, refunded_amount, payable_amount
     FROM sale_orders WHERE sale_order_id=$1`, [orderNo])
  return rows[0]
}
async function fetchCardBalance() {
  const rows = await pgQuery(`SELECT balance FROM prepaid_cards WHERE user_id=$1`, [TEST_CLIENT_USER_ID])
  return rows.length ? r2(rows[0].balance) : 0
}
// 写一条已支付首次支付流水（让退款 refundCap 依赖的 paymentsNet 有值）
async function seedPaidPayment(orderNo, amount) {
  await pgQuery(
    `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at, paid_at)
     VALUES ($1, '首次支付', $2, '线下', '已支付', 'test', NOW(), NOW())`,
    [orderNo, amount])
}
async function refundApprove(orderNo, itemIds, reason) {
  const items = itemIds.map(([id, qty]) => ({ saleItemId: id, refundQuantity: qty }))
  const ref = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o_ref, items, refundReason: reason,
  })
}
let o_ref = null
function check(label, cond, detail) {
  if (!cond) errors.push(`${label}: ${detail || ''}`)
}

// 把疗程卡订单"付清"：写流水 + 设 received/paid_sessions + 翻已支付
async function markOrderFullyPaid(orderNo, received, itemReceivedPaid) {
  await seedPaidPayment(orderNo, received)
  await pgQuery(`UPDATE sale_orders SET received=$1, status='已支付' WHERE sale_order_id=$2`, [received, orderNo])
  for (const [itemId, rec, ps] of itemReceivedPaid) {
    await pgQuery(`UPDATE sale_items SET received=$1, paid_sessions=$2 WHERE sale_item_id=$3`, [rec, ps, itemId])
  }
}

async function main() {
  rec(`[smoke-order-payment-refund-matrix] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore(); await createTestStaff(); await createTestClient()

  // ════════════════════════════════════════════════════════════════
  // 场景 1：单卡·首次支付·无储值卡·定向（基础场景）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M01`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M01`, productType: '疗程卡', sessionCount: 10,
      totalAmount: 1000, status: '待支付', salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_items SET pending_received=600 WHERE sale_order_id=$1`, [o])
    const conf = await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 600,
    })
    let itm = await fetchItems(o), ord = await fetchOrder(o)
    check('M01 首付 received', r2(itm[0].received) === 600, `got ${itm[0].received}`)
    check('M01 首付 paid_sessions', Number(itm[0].paid_sessions) === 6, `got ${itm[0].paid_sessions}`)
    check('M01 首付 status', ord.status === '部分支付', `got ${ord.status}`)
    const item1 = itm[0].sale_item_id
    const rep = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: item1, repayAmount: 400 }], note: 'M01_repay',
    })
    itm = await fetchItems(o); ord = await fetchOrder(o)
    check('M01 回款 received', r2(itm[0].received) === 1000, `got ${itm[0].received}`)
    check('M01 回款 paid_sessions', Number(itm[0].paid_sessions) === 10, `got ${itm[0].paid_sessions}`)
    check('M01 回款 status', ord.status === '已支付', `got ${ord.status}`)
    check('M01 Σ守恒', r2(itm.reduce((s, x) => s + Number(x.received), 0)) === r2(ord.received))
    if (rep.code !== 0) check('M01 createRepayment', false, rep.message)
    if (conf.code !== 0) check('M01 confirmOffline', false, conf.message)
    rec('  ✅ M01 单卡·首次支付·无储值卡·定向')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 2：单卡·首次支付·有储值卡抵扣·定向
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M02`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M02`, productType: '疗程卡', sessionCount: 10,
      totalAmount: 1000, status: '待支付', salesCategory: '他销自耗',
      prepaidCardAmount: 200,
    })
    await pgQuery(`UPDATE sale_items SET pending_received=500 WHERE sale_order_id=$1`, [o])
    await createTestPrepaidCard({ initialBalance: 500 })
    const conf = await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 300,
    })
    const itm = await fetchItems(o), ord = await fetchOrder(o), bal = await fetchCardBalance()
    check('M02 received', r2(itm[0].received) === 500, `got ${itm[0].received}`)
    check('M02 prepaid_card_amount', r2(ord.prepaid_card_amount) === 200, `got ${ord.prepaid_card_amount}`)
    check('M02 paid_sessions', Number(itm[0].paid_sessions) === 5, `got ${itm[0].paid_sessions}`)
    check('M02 status', ord.status === '部分支付', `got ${ord.status}`)
    check('M02 储值卡余额', bal === 300, `got ${bal}（500-200）`)
    if (conf.code !== 0) check('M02 confirmOffline', false, conf.message)
    rec('  ✅ M02 单卡·首次支付·有储值卡抵扣·定向')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 3：单卡·回款·无储值卡·定向
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M03`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M03`, productType: '疗程卡', sessionCount: 10,
      totalAmount: 1000, status: '待支付', salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_items SET pending_received=400 WHERE sale_order_id=$1`, [o])
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 400,
    })
    const item1 = (await fetchItems(o))[0].sale_item_id
    let itm = await fetchItems(o), ord = await fetchOrder(o)
    check('M03 首付 received', r2(itm[0].received) === 400, `got ${itm[0].received}`)
    check('M03 首付 status', ord.status === '部分支付', `got ${ord.status}`)
    const rep = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: item1, repayAmount: 600 }], note: 'M03_repay',
    })
    itm = await fetchItems(o); ord = await fetchOrder(o)
    check('M03 回款 received', r2(itm[0].received) === 1000, `got ${itm[0].received}`)
    check('M03 回款 paid_sessions', Number(itm[0].paid_sessions) === 10, `got ${itm[0].paid_sessions}`)
    check('M03 回款 status', ord.status === '已支付', `got ${ord.status}`)
    if (rep.code !== 0) check('M03 createRepayment', false, rep.message)
    rec('  ✅ M03 单卡·回款·无储值卡·定向')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 4：单卡·回款·有储值卡抵扣·定向（现金+储值卡混合走线下）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M04`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M04`, productType: '疗程卡', sessionCount: 10,
      totalAmount: 1000, status: '待支付', salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_items SET pending_received=300 WHERE sale_order_id=$1`, [o])
    await createTestPrepaidCard({ initialBalance: 500 })
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 300,
    })
    const item1 = (await fetchItems(o))[0].sale_item_id
    let bal = await fetchCardBalance()
    check('M04 首付后储值卡余额', bal === 500, `got ${bal}（首付无卡）`)
    const rep = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: item1, repayAmount: 200, prepaidCardAmount: 500 }], note: 'M04_repay',
    })
    const itm = await fetchItems(o), ord = await fetchOrder(o)
    bal = await fetchCardBalance()
    check('M04 回款 received', r2(itm[0].received) === 1000, `got ${itm[0].received}`)
    check('M04 prepaid_card_amount', r2(ord.prepaid_card_amount) === 500, `got ${ord.prepaid_card_amount}`)
    check('M04 储值卡余额', bal === 0, `got ${bal}（500-500）`)
    check('M04 paid_sessions', Number(itm[0].paid_sessions) === 10, `got ${itm[0].paid_sessions}`)
    check('M04 status', ord.status === '已支付', `got ${ord.status}`)
    if (rep.code !== 0) check('M04 createRepayment', false, rep.message)
    rec('  ✅ M04 单卡·回款·有储值卡抵扣·定向')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 5：多卡·首次支付·定向（各卡不同实付）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M05`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M05_1`, productType: '疗程卡', sessionCount: 1,
      totalAmount: 650, status: '待支付', salesCategory: '他销自耗',
    })
    const i2 = `${o}_ITEM_2`, i3 = `${o}_ITEM_3`
    await createTestSaleItem({
      saleOrderId: o, saleItemId: i2, productName: `${NS}_M05_2`,
      productType: '疗程卡', unitPrice: 650, quantity: 1, sessionCount: 1, salesCategory: '他销自耗',
    })
    await createTestSaleItem({
      saleOrderId: o, saleItemId: i3, productName: `${NS}_M05_3`,
      productType: '疗程卡', unitPrice: 650, quantity: 1, sessionCount: 1, salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_orders SET total_amount=1950, payable_amount=1950 WHERE sale_order_id=$1`, [o])
    const itemIds = (await fetchItems(o)).map((x) => x.sale_item_id) // [ITEM_1, ITEM_2, ITEM_3]
    await pgQuery(`UPDATE sale_items SET pending_received=650 WHERE sale_item_id=$1`, [itemIds[0]])
    await pgQuery(`UPDATE sale_items SET pending_received=150 WHERE sale_item_id=$1`, [i2])
    await pgQuery(`UPDATE sale_items SET pending_received=0 WHERE sale_item_id=$1`, [i3])
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 800,
    })
    let itm = await fetchItems(o), ord = await fetchOrder(o)
    check('M05 首付 received[0]', r2(itm[0].received) === 650, `got ${itm[0].received}`)
    check('M05 首付 received[1]', r2(itm[1].received) === 150, `got ${itm[1].received}`)
    check('M05 首付 received[2]', r2(itm[2].received) === 0, `got ${itm[2].received}`)
    check('M05 首付 order.received', r2(ord.received) === 800, `got ${ord.received}`)
    const rep = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: i2, repayAmount: 500 }, { saleItemId: i3, repayAmount: 650 }], note: 'M05_repay',
    })
    itm = await fetchItems(o); ord = await fetchOrder(o)
    check('M05 回款 received[0]', r2(itm[0].received) === 650, '')
    check('M05 回款 received[1]', r2(itm[1].received) === 650, '')
    check('M05 回款 received[2]', r2(itm[2].received) === 650, '')
    check('M05 回款 order.received', r2(ord.received) === 1950, `got ${ord.received}`)
    check('M05 Σ守恒', r2(itm.reduce((s, x) => s + Number(x.received), 0)) === r2(ord.received))
    if (rep.code !== 0) check('M05 createRepayment', false, rep.message)
    rec('  ✅ M05 多卡·首次支付·定向（各卡不同实付）')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 6：多卡·首次支付·有储值卡抵扣·定向
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M06`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M06_1`, productType: '疗程卡', sessionCount: 6,
      totalAmount: 600, status: '待支付', salesCategory: '他销自耗',
      prepaidCardAmount: 300,
    })
    const i2 = `${o}_ITEM_2`
    await createTestSaleItem({
      saleOrderId: o, saleItemId: i2, productName: `${NS}_M06_2`,
      productType: '疗程卡', unitPrice: 400, quantity: 1, sessionCount: 4, salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_orders SET total_amount=1000, payable_amount=700 WHERE sale_order_id=$1`, [o])
    const itemIds = (await fetchItems(o)).map((x) => x.sale_item_id)
    await pgQuery(`UPDATE sale_items SET pending_received=350 WHERE sale_item_id=$1`, [itemIds[0]])
    await pgQuery(`UPDATE sale_items SET pending_received=250 WHERE sale_item_id=$1`, [i2])
    await createTestPrepaidCard({ initialBalance: 500 })
    const conf = await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 300,
    })
    const itm = await fetchItems(o), ord = await fetchOrder(o), bal = await fetchCardBalance()
    check('M06 received[0]', r2(itm[0].received) === 350, `got ${itm[0].received}`)
    check('M06 received[1]', r2(itm[1].received) === 250, `got ${itm[1].received}`)
    check('M06 prepaid_card_amount', r2(ord.prepaid_card_amount) === 300, `got ${ord.prepaid_card_amount}`)
    check('M06 paid_sessions[0]', Number(itm[0].paid_sessions) === 3, `got ${itm[0].paid_sessions}`)
    check('M06 paid_sessions[1]', Number(itm[1].paid_sessions) === 2, `got ${itm[1].paid_sessions}`)
    check('M06 储值卡余额', bal === 200, `got ${bal}（500-300）`)
    if (conf.code !== 0) check('M06 confirmOffline', false, conf.message)
    rec('  ✅ M06 多卡·首次支付·有储值卡抵扣·定向')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 7：多卡·回款·无储值卡·定向（子项 capped）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M07`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M07_1`, productType: '疗程卡', sessionCount: 6,
      totalAmount: 600, status: '待支付', salesCategory: '他销自耗',
    })
    const i2 = `${o}_ITEM_2`
    await createTestSaleItem({
      saleOrderId: o, saleItemId: i2, productName: `${NS}_M07_2`,
      productType: '疗程卡', unitPrice: 400, quantity: 1, sessionCount: 4, salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_orders SET total_amount=1000, payable_amount=1000 WHERE sale_order_id=$1`, [o])
    const itemIds = (await fetchItems(o)).map((x) => x.sale_item_id)
    await pgQuery(`UPDATE sale_items SET pending_received=400 WHERE sale_item_id=$1`, [itemIds[0]])
    await pgQuery(`UPDATE sale_items SET pending_received=200 WHERE sale_item_id=$1`, [i2])
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 600,
    })
    const rep1 = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: itemIds[0], repayAmount: 200 }], note: 'M07_r1',
    })
    const rep2 = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: i2, repayAmount: 200 }], note: 'M07_r2',
    })
    const itm = await fetchItems(o), ord = await fetchOrder(o)
    check('M07 received[0]', r2(itm[0].received) === 600, `got ${itm[0].received}`)
    check('M07 received[1]', r2(itm[1].received) === 400, `got ${itm[1].received}`)
    check('M07 order.received', r2(ord.received) === 1000, `got ${ord.received}`)
    check('M07 status', ord.status === '已支付', `got ${ord.status}`)
    if (rep1.code !== 0) check('M07 rep1', false, rep1.message)
    if (rep2.code !== 0) check('M07 rep2', false, rep2.message)
    rec('  ✅ M07 多卡·回款·无储值卡·定向（子项 capped）')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 8：多卡·回款·有储值卡抵扣·定向（子项 capped，混合走线下）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M08`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M08_1`, productType: '疗程卡', sessionCount: 6,
      totalAmount: 600, status: '待支付', salesCategory: '他销自耗',
    })
    const i2 = `${o}_ITEM_2`
    await createTestSaleItem({
      saleOrderId: o, saleItemId: i2, productName: `${NS}_M08_2`,
      productType: '疗程卡', unitPrice: 400, quantity: 1, sessionCount: 4, salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_orders SET total_amount=1000, payable_amount=1000 WHERE sale_order_id=$1`, [o])
    const itemIds = (await fetchItems(o)).map((x) => x.sale_item_id)
    await pgQuery(`UPDATE sale_items SET pending_received=300 WHERE sale_item_id=$1`, [itemIds[0]])
    await pgQuery(`UPDATE sale_items SET pending_received=100 WHERE sale_item_id=$1`, [i2])
    await createTestPrepaidCard({ initialBalance: 600 })
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 400,
    })
    const rep1 = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: itemIds[0], repayAmount: 100, prepaidCardAmount: 200 }], note: 'M08_r1',
    })
    const rep2 = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: i2, repayAmount: 100, prepaidCardAmount: 200 }], note: 'M08_r2',
    })
    const itm = await fetchItems(o), ord = await fetchOrder(o), bal = await fetchCardBalance()
    check('M08 received[0]', r2(itm[0].received) === 600, `got ${itm[0].received}`)
    check('M08 received[1]', r2(itm[1].received) === 400, `got ${itm[1].received}`)
    check('M08 order.received', r2(ord.received) === 1000, `got ${ord.received}`)
    check('M08 status', ord.status === '已支付', `got ${ord.status}`)
    check('M08 储值卡余额', bal === 200, `got ${bal}（600-400）`)
    if (rep1.code !== 0) check('M08 rep1', false, rep1.message)
    if (rep2.code !== 0) check('M08 rep2', false, rep2.message)
    rec('  ✅ M08 多卡·回款·有储值卡抵扣·定向（子项 capped）')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 9：单卡·全额支付·退款（整卡退）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M09`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M09`, productType: '疗程卡', sessionCount: 10,
      totalAmount: 1000, status: '待支付', salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_items SET pending_received=1000 WHERE sale_order_id=$1`, [o])
    // 用真实 confirmOffline 付清（写流水 + 翻已支付）
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 1000,
    })
    const item1 = (await fetchItems(o))[0].sale_item_id
    const ref = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o,
      items: [{ saleItemId: item1, refundQuantity: 10 }], refundReason: 'M09_refund',
    })
    check('M09 createRefund', ref.code === 0, ref.message)
    if (ref.code === 0) {
      const apr = await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: ref.data.paymentId, auditRemark: 'M09',
      })
      check('M09 approveRefund', apr.code === 0, apr.message)
      const itm = await fetchItems(o), ord = await fetchOrder(o)
      check('M09 退款 received', r2(itm[0].received) === 0, `got ${itm[0].received}`)
      check('M09 退款 paid_sessions', Number(itm[0].paid_sessions) === 0, `got ${itm[0].paid_sessions}`)
      check('M09 refunded_amount', r2(ord.refunded_amount) === 1000, `got ${ord.refunded_amount}`)
    }
    rec('  ✅ M09 单卡·全额支付·退款（整卡退）')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 10：单卡·有储值卡抵扣·全额支付·整卡退款（全部走现金）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M10`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M10`, productType: '疗程卡', sessionCount: 10,
      totalAmount: 1000, status: '待支付', salesCategory: '他销自耗',
      prepaidCardAmount: 400,
    })
    await pgQuery(`UPDATE sale_items SET pending_received=1000 WHERE sale_order_id=$1`, [o])
    await createTestPrepaidCard({ initialBalance: 500 })
    // confirmOffline 付清：现金 600 + 储值卡抵扣 400
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 600,
    })
    const item1 = (await fetchItems(o))[0].sale_item_id
    const ref = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o,
      items: [{ saleItemId: item1, refundQuantity: 10 }], refundReason: 'M10_refund',
    })
    check('M10 createRefund', ref.code === 0, ref.message)
    if (ref.code === 0) {
      const apr = await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: ref.data.paymentId, auditRemark: 'M10',
      })
      check('M10 approveRefund', apr.code === 0, apr.message)
      const itm = await fetchItems(o), ord = await fetchOrder(o), bal = await fetchCardBalance()
      check('M10 退款 received', r2(itm[0].received) === 0, `got ${itm[0].received}`)
      check('M10 退款 paid_sessions', Number(itm[0].paid_sessions) === 0, `got ${itm[0].paid_sessions}`)
      check('M10 refunded_amount', r2(ord.refunded_amount) === 1000, `got ${ord.refunded_amount}`)
      check('M10 储值卡余额不变(全部走现金)', bal === 100, `got ${bal}（应=500-400首付扣=100，退款不回冲）`)
    }
    rec('  ✅ M10 单卡·有储值卡抵扣·全额退款（全部走现金）')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 11：多卡·已部分使用·退款（仅退 remainingSessions）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M11`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M11_1`, productType: '疗程卡', sessionCount: 6,
      totalAmount: 600, status: '待支付', salesCategory: '他销自耗',
    })
    const i2 = `${o}_ITEM_2`
    await createTestSaleItem({
      saleOrderId: o, saleItemId: i2, productName: `${NS}_M11_2`,
      productType: '疗程卡', unitPrice: 400, quantity: 1, sessionCount: 4, salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_orders SET total_amount=1000, payable_amount=1000 WHERE sale_order_id=$1`, [o])
    await pgQuery(`UPDATE sale_items SET pending_received=600 WHERE sale_order_id=$1 AND sale_item_id LIKE '%ITEM_1'`, [o])
    await pgQuery(`UPDATE sale_items SET pending_received=400 WHERE sale_item_id=$1`, [i2])
    // 真实付清
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 1000,
    })
    // 卡1 使用 3 次（remaining=3）
    await pgQuery(`UPDATE sale_items SET remaining_sessions=3 WHERE sale_order_id=$1 AND sale_item_id LIKE '%ITEM_1'`, [o])
    const a1 = (await fetchItems(o))[0].sale_item_id
    const ref = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o,
      items: [{ saleItemId: a1, refundQuantity: 3 }], refundReason: 'M11_refund',
    })
    check('M11 createRefund', ref.code === 0, ref.message)
    if (ref.code === 0) {
      const apr = await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: ref.data.paymentId, auditRemark: 'M11',
      })
      check('M11 approveRefund', apr.code === 0, apr.message)
      const itm = await fetchItems(o), ord = await fetchOrder(o)
      const a = itm.find((x) => x.sale_item_id === a1)
      check('M11 卡1退款 received', r2(a.received) === 300, `got ${a.received}（600-300）`)
      check('M11 卡1 paid_sessions', Number(a.paid_sessions) === 3, `got ${a.paid_sessions}`)
      check('M11 refunded_amount', r2(ord.refunded_amount) === 300, `got ${ord.refunded_amount}`)
    }
    rec('  ✅ M11 多卡·已部分使用·退款（仅退 remainingSessions）')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 12：单卡·部分使用·退款 + 不可再回款
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M12`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M12`, productType: '疗程卡', sessionCount: 10,
      totalAmount: 1000, status: '待支付', salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_items SET pending_received=1000 WHERE sale_order_id=$1`, [o])
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 1000,
    })
    // 使用 7 次（remaining=3）
    await pgQuery(`UPDATE sale_items SET remaining_sessions=3 WHERE sale_order_id=$1`, [o])
    const item1 = (await fetchItems(o))[0].sale_item_id
    const ref = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o,
      items: [{ saleItemId: item1, refundQuantity: 3 }], refundReason: 'M12_refund',
    })
    if (ref.code === 0) {
      await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: ref.data.paymentId, auditRemark: 'M12',
      })
    }
    const rep = await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: item1, repayAmount: 300 }], note: 'M12_repay_should_fail',
    })
    check('M12 退款后不可回款', rep.code !== 0, `got code=${rep.code}（应非0拒绝）`)
    rec('  ✅ M12 单卡·部分使用·退款 + 不可再回款')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 13：单卡·有储值卡抵扣·部分使用·退款（全部走现金）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M13`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M13`, productType: '疗程卡', sessionCount: 10,
      totalAmount: 1000, status: '待支付', salesCategory: '他销自耗',
      prepaidCardAmount: 400,
    })
    await pgQuery(`UPDATE sale_items SET pending_received=1000 WHERE sale_order_id=$1`, [o])
    await createTestPrepaidCard({ initialBalance: 500 })
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 600,
    })
    // 使用 4 次（remaining=6）
    await pgQuery(`UPDATE sale_items SET remaining_sessions=6 WHERE sale_order_id=$1`, [o])
    const item1 = (await fetchItems(o))[0].sale_item_id
    const ref = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o,
      items: [{ saleItemId: item1, refundQuantity: 6 }], refundReason: 'M13_refund',
    })
    check('M13 createRefund', ref.code === 0, ref.message)
    if (ref.code === 0) {
      const apr = await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: ref.data.paymentId, auditRemark: 'M13',
      })
      check('M13 approveRefund', apr.code === 0, apr.message)
      const itm = await fetchItems(o), ord = await fetchOrder(o), bal = await fetchCardBalance()
      check('M13 退款 received', r2(itm[0].received) === 400, `got ${itm[0].received}（1000-600）`)
      check('M13 paid_sessions', Number(itm[0].paid_sessions) === 4, `got ${itm[0].paid_sessions}`)
      check('M13 refunded_amount', r2(ord.refunded_amount) === 600, `got ${ord.refunded_amount}`)
      check('M13 储值卡余额不变', bal === 100, `got ${bal}（500-400首付扣=100，退款不回冲）`)
    }
    rec('  ✅ M13 单卡·有储值卡抵扣·部分使用·退款（全部走现金）')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 14：多卡·有储值卡抵扣·部分使用·部分卡退款
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M14`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M14_1`, productType: '疗程卡', sessionCount: 6,
      totalAmount: 600, status: '待支付', salesCategory: '他销自耗',
      prepaidCardAmount: 400,
    })
    const i2 = `${o}_ITEM_2`
    await createTestSaleItem({
      saleOrderId: o, saleItemId: i2, productName: `${NS}_M14_2`,
      productType: '疗程卡', unitPrice: 400, quantity: 1, sessionCount: 4, salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_orders SET total_amount=1000, payable_amount=600 WHERE sale_order_id=$1`, [o])
    await pgQuery(`UPDATE sale_items SET pending_received=600 WHERE sale_order_id=$1 AND sale_item_id LIKE '%ITEM_1'`, [o])
    await pgQuery(`UPDATE sale_items SET pending_received=400 WHERE sale_item_id=$1`, [i2])
    await createTestPrepaidCard({ initialBalance: 500 })
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 600,
    })
    // 卡1使用2次(remaining=4)，卡2使用1次(remaining=3)
    await pgQuery(`UPDATE sale_items SET remaining_sessions=4 WHERE sale_order_id=$1 AND sale_item_id LIKE '%ITEM_1'`, [o])
    await pgQuery(`UPDATE sale_items SET remaining_sessions=3 WHERE sale_item_id=$1`, [i2])
    const ref = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o,
      items: [{ saleItemId: i2, refundQuantity: 3 }], refundReason: 'M14_refund',
    })
    check('M14 createRefund', ref.code === 0, ref.message)
    if (ref.code === 0) {
      const apr = await invokeStaffApi('order.approveRefund', {
        _testOpenid: TEST_MANAGER_OPENID, paymentId: ref.data.paymentId, auditRemark: 'M14',
      })
      check('M14 approveRefund', apr.code === 0, apr.message)
      const itm = await fetchItems(o), ord = await fetchOrder(o), bal = await fetchCardBalance()
      const a = itm[0]
      const b = itm.find((x) => x.sale_item_id === i2)
      check('M14 卡1不变 received', r2(a.received) === 600, `got ${a.received}`)
      check('M14 卡2退款 received', r2(b.received) === 100, `got ${b.received}（400-300）`)
      check('M14 卡2 paid_sessions', Number(b.paid_sessions) === 1, `got ${b.paid_sessions}`)
      check('M14 refunded_amount', r2(ord.refunded_amount) === 300, `got ${ord.refunded_amount}`)
      check('M14 储值卡余额不变', bal === 100, `got ${bal}（500-400首付扣=100，退款不回冲）`)
    }
    rec('  ✅ M14 多卡·有储值卡抵扣·部分使用·部分卡退款')
  }

  // ════════════════════════════════════════════════════════════════
  // 场景 15：pending_received 覆盖写入（定向回款多轮）
  // ════════════════════════════════════════════════════════════════
  {
    const o = `${NS}_M15`
    await createTestSaleOrder({
      saleOrderId: o, clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_M15_1`, productType: '疗程卡', sessionCount: 6,
      totalAmount: 600, status: '待支付', salesCategory: '他销自耗',
    })
    const i2 = `${o}_ITEM_2`
    await createTestSaleItem({
      saleOrderId: o, saleItemId: i2, productName: `${NS}_M15_2`,
      productType: '疗程卡', unitPrice: 400, quantity: 1, sessionCount: 4, salesCategory: '他销自耗',
    })
    await pgQuery(`UPDATE sale_orders SET total_amount=1000, payable_amount=1000 WHERE sale_order_id=$1`, [o])
    const itemIds = (await fetchItems(o)).map((x) => x.sale_item_id)
    await pgQuery(`UPDATE sale_items SET pending_received=200 WHERE sale_item_id=$1`, [itemIds[0]])
    await pgQuery(`UPDATE sale_items SET pending_received=100 WHERE sale_item_id=$1`, [i2])
    await createTestPrepaidCard({ initialBalance: 500 })
    await invokeStaffApi('order.confirmOffline', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId: o, confirmAmount: 300,
    })
    await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: itemIds[0], repayAmount: 100, prepaidCardAmount: 100 }], note: 'M15_r1',
    })
    let itm = await fetchItems(o)
    check('M15 回款1后 pending[0]=200', r2(itm[0].pending_received) === 200, `got ${itm[0].pending_received}`)
    check('M15 回款1后 pending[1]=0(清零)', r2(itm[1].pending_received) === 0, `got ${itm[1].pending_received}`)
    await invokeStaffApi('order.createRepayment', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: o, paymentMethod: '线下',
      items: [{ saleItemId: i2, repayAmount: 200, prepaidCardAmount: 100 }], note: 'M15_r2',
    })
    itm = await fetchItems(o)
    check('M15 回款2后 pending[0]=0(清零)', r2(itm[0].pending_received) === 0, `got ${itm[0].pending_received}`)
    check('M15 回款2后 pending[1]=300', r2(itm[1].pending_received) === 300, `got ${itm[1].pending_received}`)
    check('M15 回款2后 received[0]=400', r2(itm[0].received) === 400, `got ${itm[0].received}`)
    check('M15 回款2后 received[1]=400', r2(itm[1].received) === 400, `got ${itm[1].received}`)
    rec('  ✅ M15 pending_received 覆盖写入（定向回款多轮）')
  }

  await cleanupTestData(NS)
  await closePool()

  if (errors.length > 0) {
    rec(`[smoke-order-payment-refund-matrix] FAIL`)
    for (const e of errors) rec(`  ❌ ${e}`)
    process.exit(1)
  }
  rec(`[smoke-order-payment-refund-matrix] end | all passed`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
