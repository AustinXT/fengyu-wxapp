#!/usr/bin/env bun
/**
 * 销售单退款核心链路冒烟 — createRefund → approveRefund，覆盖本轮修复的核心资损/冻结：
 *
 *   A 重复退款防护（Bug A，用户问题④）：
 *     1. 已支付疗程卡单(total=1000/10次/全付) createRefund 全额 → approveRefund
 *        → refunded_amount=1000、paid_sessions 归 0、sale_allocations 作废(cascade)
 *     2. 再次 createRefund 同单 → 被拒（数量门 paid_sessions-consumed=0 / 金额门 received-refunded=0）
 *
 *   I 待审批冻结（Bug I，用户追加需求）：
 *     3. 另一已支付单 createRefund(待审批，不审批) → allocation.save 被拒 REFUND_IN_PROGRESS
 *
 *   P 孤儿服务单前置校验（Bug P）：
 *     4. 已支付单 + 关联「待客户确认」服务单 → createRefund 被拒（请先完成或取消服务单）
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestSaleOrder, createTestServiceOrder, createTestPrepaidCard, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
const rec = (l) => console.log(l)

/** 建一张已支付销售单（疗程卡）+ 行级 received/paid_sessions + 首次支付/储值卡抵扣流水（已支付） */
async function makePaidOrder(saleOrderId, { total, sessionCount, prepaidCard = 0 }) {
  await createTestSaleOrder({
    saleOrderId, clientUserId: TEST_CLIENT_USER_ID,
    saleOrderType: '销售单', productName: `${NS}_疗程卡`, productType: '疗程卡',
    quantity: 1, sessionCount, totalAmount: total, status: '已支付',
    salesCategory: '他销自耗', prepaidCardAmount: prepaidCard,
  })
  await pgQuery(`UPDATE sale_orders SET received = $2 WHERE sale_order_id = $1`, [saleOrderId, total])
  await pgQuery(`UPDATE sale_items SET received = $2, paid_sessions = $3 WHERE sale_order_id = $1`, [saleOrderId, total, sessionCount])
  const cashPart = total - prepaidCard
  if (cashPart > 0) {
    await pgQuery(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at)
       VALUES ($1, '首次支付', $2, '线下', '已支付', 'staff', NOW())`,
      [saleOrderId, cashPart]
    )
  }
  if (prepaidCard > 0) {
    await pgQuery(
      `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at)
       VALUES ($1, '储值卡抵扣', $2, '储值卡', '已支付', 'staff', NOW())`,
      [saleOrderId, prepaidCard]
    )
  }
  return { saleItemId: `${saleOrderId}_ITEM_1` }
}

async function main() {
  rec(`[smoke-refund-core] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // manager
  await createTestClient()
  const errors = []

  // ─── A: 重复退款防护 ───
  const orderA = `${NS}_RFCORE_A`
  const { saleItemId: itemA } = await makePaidOrder(orderA, { total: 1000, sessionCount: 10 })
  // 手动建一条营业额分配，验证 approveRefund 的 cascade 通道 1 作废
  await pgQuery(
    `INSERT INTO sale_allocations (sale_item_id, employee_id, role_type, allocation_ratio, total_amount, commission_rate, commission_amount, is_void)
     VALUES ($1, $2, '美容师', 1.00, 1000, 0.06, 60, false)`,
    [itemA, TEST_MANAGER_EMP_ID]
  )

  const a1 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderA, items: [{ saleItemId: itemA }], refundReason: 'e2e_A',
  })
  if (a1.code !== 0) errors.push(`A1 createRefund 应成功，code=${a1.code} msg=${a1.message}`)
  const payA = a1.data?.paymentId
  rec(`  ✓ A1 createRefund: paymentId=${payA} totalRefund=${a1.data?.totalRefund}`)

  if (payA) {
    const a2 = await invokeStaffApi('order.approveRefund', { _testOpenid: TEST_MANAGER_OPENID, paymentId: payA })
    if (a2.code !== 0) errors.push(`A2 approveRefund 应成功，code=${a2.code} msg=${a2.message}`)
    else rec(`  ✓ A2 approveRefund OK`)

    const o = await pgQuery(`SELECT refunded_amount FROM sale_orders WHERE sale_order_id = $1`, [orderA])
    if (Number(o[0]?.refunded_amount) !== 1000) errors.push(`A refunded_amount 应=1000（重算），实际=${o[0]?.refunded_amount}`)

    const si = await pgQuery(`SELECT paid_sessions FROM sale_items WHERE sale_item_id = $1`, [itemA])
    if (Number(si[0]?.paid_sessions) !== 0) errors.push(`A paid_sessions 应=0（全退后），实际=${si[0]?.paid_sessions}`)

    const al = await pgQuery(`SELECT is_void FROM sale_allocations WHERE sale_item_id = $1`, [itemA])
    if (al[0]?.is_void !== true) errors.push(`A 营业额分配应被 cascade 作废 is_void=true，实际=${al[0]?.is_void}`)
    else rec(`  ✓ A cascade: refunded_amount=1000 / paid_sessions=0 / 分配作废`)
  }

  // A3：重复退款被拒（数量门 paid_sessions-consumed=0 → 可退 0）
  const a3 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderA, items: [{ saleItemId: itemA }], refundReason: 'e2e_A_dup',
  })
  if (a3.code === 0) errors.push(`A3 重复退款应被拒，实际成功 paymentId=${a3.data?.paymentId}（资损！）`)
  else rec(`  ✓ A3 重复退款被拒: code=${a3.code} msg=${a3.message}`)

  // ─── H: 混合支付储值卡回冲（Bug H，P0 对客资损）───
  const orderH = `${NS}_RFCORE_H`
  await createTestPrepaidCard({ initialBalance: 0, cardId: `${NS}_RFCORE_CARD_H`, refOrderId: orderH })
  const { saleItemId: itemH } = await makePaidOrder(orderH, { total: 1000, sessionCount: 10, prepaidCard: 300 })
  const h1 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderH, items: [{ saleItemId: itemH }], refundReason: 'e2e_H',
  })
  if (h1.code !== 0) errors.push(`H createRefund 应成功，code=${h1.code} msg=${h1.message}`)
  const payH = h1.data?.paymentId
  if (payH) {
    // 储值卡占比 300/1000 → refundByCard = floor(300/1000 × 1000) = 300
    if (Number(h1.data?.refundByCard) !== 300) errors.push(`H refundByCard 应=300（储值卡占比拆分），实际=${h1.data?.refundByCard}`)
    const h2 = await invokeStaffApi('order.approveRefund', { _testOpenid: TEST_MANAGER_OPENID, paymentId: payH })
    if (h2.code !== 0) errors.push(`H approveRefund 应成功，code=${h2.code} msg=${h2.message}`)
    // 修复前：staff 用 payment_method==='储值卡' 判断 → 混合支付退款行 method='线下' → 漏回冲（balance=0）
    const card = await pgQuery(`SELECT balance FROM prepaid_cards WHERE user_id = $1`, [TEST_CLIENT_USER_ID])
    if (Number(card[0]?.balance) !== 300) errors.push(`H 储值卡回冲 balance 应=300（混合支付不再漏退），实际=${card[0]?.balance}`)
    else rec(`  ✓ H 混合支付储值卡回冲: refundByCard=300 → balance=300`)
  }

  // ─── I: 待审批冻结营业额分配 ───
  const orderI = `${NS}_RFCORE_I`
  const { saleItemId: itemI } = await makePaidOrder(orderI, { total: 500, sessionCount: 5 })
  const i1 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderI, items: [{ saleItemId: itemI }], refundReason: 'e2e_I',
  })
  if (i1.code !== 0) errors.push(`I createRefund 应成功，code=${i1.code} msg=${i1.message}`)
  else rec(`  ✓ I createRefund(待审批) paymentId=${i1.data?.paymentId}`)

  const iSave = await invokeStaffApi('allocation.save', {
    _testOpenid: TEST_MANAGER_OPENID,
    saleOrderId: orderI,
    allocations: [{ saleItemId: itemI, employeeId: TEST_MANAGER_EMP_ID, roleType: '美容师', allocationRatio: '1.00', totalAmount: '500' }],
  })
  if (iSave.code === 0) errors.push(`I allocation.save 应被冻结拒绝，实际成功`)
  else if (!String(iSave.message || '').includes('退款审批中')) errors.push(`I 冻结提示应含"退款审批中"，实际=${iSave.message}`)
  else rec(`  ✓ I allocation.save 被冻结: ${iSave.message}`)

  // ─── P: 未完成服务单前置校验 ───
  const orderP = `${NS}_RFCORE_P`
  const { saleItemId: itemP } = await makePaidOrder(orderP, { total: 300, sessionCount: 3 })
  await createTestServiceOrder({
    serviceOrderId: `${NS}_RFCORE_SVC_P`,
    status: '待客户确认',
    items: [{ saleItemId: itemP, sessionUsed: 1 }],
  })
  const p1 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderP, items: [{ saleItemId: itemP }], refundReason: 'e2e_P',
  })
  if (p1.code === 0) errors.push(`P 有未完成服务单时退款应被拒，实际成功`)
  else if (!String(p1.message || '').includes('服务单')) errors.push(`P 拒绝提示应含"服务单"，实际=${p1.message}`)
  else rec(`  ✓ P 未完成服务单前置校验: ${p1.message}`)

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 重复退款防护(A) + cascade作废/paid_sessions归零 + 待审批冻结(I) + 孤儿前置校验(P)`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-refund-core] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-refund-core] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
