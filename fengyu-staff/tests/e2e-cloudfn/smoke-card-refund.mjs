#!/usr/bin/env bun
/**
 * card.createRefund + approveRefund + rejectRefund 储值卡退款审批三联冒烟
 *
 * 契约（cloudfunctions/staffApi/routes/card.js）：
 *   - 仅「退剩余余额」语义：refundFace = prepaid_cards.balance_now（整笔退、不可拆、只退 1 次）；
 *     线下退款金额 refundPay = round(refundFace * payable_amount / total_amount, 2)。
 *   - createRefund 要求订单 sale_order_type='充值单' 且 status='已支付'，否则 INVALID_STATE。
 *   - approveRefund：manager-only + scope 校验 + 仅充值单退款；扣 balance(-refundFace)
 *     + card_transactions(type='扣款',amount=-refundFace) + sale_order_payments.status '待审批'→'已支付'
 *     + payment_method 固定 '线下' + sale_orders.refunded_amount += |amount|。
 *   - rejectRefund：manager-only + scope 校验 + 仅充值单退款；status '待审批'→'已作废'，balance 不变。
 *
 * 验证：
 *   A 路径 — 同意退款：
 *     1. 充值单(已支付,total=1000/payable=900,余额 800) createRefund → 待审批；
 *        返回 refundFace=800、refundPay=round(800*900/1000)=720
 *     2. sale_order_payments 落一行：change_type='退款' status='待审批' amount=-720，
 *        payment_method='线下'，external_txn_id=NULL，note 含 refundFace
 *     3. operation_logs 写一条 action='card.createRefund'，并通知店长待审批
 *     4. approveRefund → status 待审批→已支付；
 *        prepaid_cards.balance 800→0（扣 refundFace），card_transactions 落 type='扣款' amount=-800，
 *        sale_orders.refunded_amount += |amount|=720
 *   B 路径 — 驳回退款：
 *     5. 另一充值单 createRefund → rejectRefund → status 待审批→已作废
 *     6. prepaid_cards.balance 不变（rejectRefund 不动 balance/card_transactions）
 */
import './setup.mjs'
import {
  NS, TEST_STORE_ID, TEST_STORE_ORG_ID,
  TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestPermissionRole, createTestSaleOrder, createTestPrepaidCard, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1

function rec(line) { console.log(line) }

const TEST_REFUND_STAFF_EMP_ID = `${NS}_CARDREF_STAFF`
const TEST_REFUND_STAFF_OPENID = `${NS}_CARDREF_STAFF_OPENID`
const TEST_REFUND_STAFF_PHONE = '19999098015'

/**
 * 建一张充值单（已支付，total/payable 可分离）。
 * fixture 的 createTestSaleOrder 默认 payable = total - prepaidCardAmount；
 * 这里直接 UPDATE 拆出折扣（payable < total）以覆盖 refundPay 的按比例换算。
 */
async function makeRechargeOrder(saleOrderId, { total, payable }) {
  await createTestSaleOrder({
    saleOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    saleOrderType: '充值单',
    productName: `${NS}_充值卡${total}`,
    productType: '疗程卡',
    quantity: 1,
    sessionCount: 1,
    totalAmount: total,
    status: '已支付',
    salesCategory: '他销自耗',
  })
  // 充值单：total=面额 ≠ payable=实付；received 置为已收（已支付态）
  await pgQuery(
    `UPDATE sale_orders SET payable_amount = $2, received = $2 WHERE sale_order_id = $1`,
    [saleOrderId, payable]
  )
}

async function main() {
  rec(`[smoke-card-refund] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestStaff({
    employeeId: TEST_REFUND_STAFF_EMP_ID,
    openid: TEST_REFUND_STAFF_OPENID,
    phone: TEST_REFUND_STAFF_PHONE,
    name: `${NS}_退款发起员工`,
    isManager: false,
    positionName: '美容顾问',
    storeId: TEST_STORE_ID,
    orgNodeId: TEST_STORE_ORG_ID,
  })
  await createTestPermissionRole({
    employeeId: TEST_REFUND_STAFF_EMP_ID,
    role: 'staff',
    scopeId: TEST_STORE_ORG_ID,
  })
  await createTestClient()

  const errors = []

  // ─── A 路径：同意退款 ───
  // 充值单 A：面额 1000 / 实付 900；储值卡余额 800（退剩余余额口径 → refundFace=800）
  const orderA = `${NS}_CARDREF_A`
  await makeRechargeOrder(orderA, { total: 1000, payable: 900 })
  await createTestPrepaidCard({ initialBalance: 800, refOrderId: orderA })
  rec(`  ✓ fixture A: ${orderA}(充值单/已支付 total=1000 payable=900) + 储值卡余额 800`)

  // A1. createRefund
  const refA = await invokeStaffApi('card.createRefund', {
    _testOpenid: TEST_REFUND_STAFF_OPENID,
    saleOrderId: orderA,
    reason: 'e2e_card_refund_A',
  })
  let paymentIdA = null
  if (refA.code !== 0) {
    errors.push(`createRefund A 应成功，实际 code=${refA.code} msg=${refA.message}`)
  } else {
    paymentIdA = refA.data?.paymentId
    const { refundFace, refundPay, status } = refA.data
    rec(`  ✓ createRefund A: paymentId=${paymentIdA} refundFace=${refundFace} refundPay=${refundPay} status=${status}`)
    if (Number(refundFace) !== 800) errors.push(`A.refundFace 应=800（余额口径），实际=${refundFace}`)
    // refundPay = round(800 * 900 / 1000, 2) = 720
    if (Number(refundPay) !== 720) errors.push(`A.refundPay 应=720（800*900/1000），实际=${refundPay}`)
    if (status !== '待审批') errors.push(`A.status 应='待审批'，实际='${status}'`)

    // A2. PG: sale_order_payments 待审批行
    const sops = await pgQuery(
      `SELECT change_type, status, amount, payment_method, external_txn_id, operator_employee_id, note
         FROM sale_order_payments WHERE id = $1`,
      [paymentIdA]
    )
    if (sops.length !== 1) {
      errors.push(`A.sale_order_payments 应=1 行，实际=${sops.length}`)
    } else {
      if (sops[0].change_type !== '退款') errors.push(`A.change_type 应='退款'，实际='${sops[0].change_type}'`)
      if (sops[0].status !== '待审批') errors.push(`A.payments.status 应='待审批'，实际='${sops[0].status}'`)
      if (Number(sops[0].amount) !== -720) errors.push(`A.amount 应=-720，实际=${sops[0].amount}`)
      if (sops[0].payment_method !== '线下') errors.push(`A.payment_method 应='线下'，实际='${sops[0].payment_method}'`)
      if (sops[0].external_txn_id !== null) errors.push(`A.external_txn_id 应=NULL，实际='${sops[0].external_txn_id}'`)
      if (sops[0].operator_employee_id !== TEST_REFUND_STAFF_EMP_ID) errors.push(`A.operator_employee_id 应=${TEST_REFUND_STAFF_EMP_ID}，实际=${sops[0].operator_employee_id}`)
      let note = {}
      try { note = JSON.parse(sops[0].note || '{}') } catch { /* ignore */ }
      if (Number(note.refundFace) !== 800) errors.push(`A.note.refundFace 应=800，实际=${note.refundFace}`)
    }

    // A3. operation_logs 写一条 card.createRefund
    const logs = await pgQuery(
      `SELECT action FROM operation_logs WHERE action = 'card.createRefund' AND target_id = $1`,
      [String(paymentIdA)]
    )
    if (logs.length !== 1) errors.push(`A.operation_logs(card.createRefund) 应=1 行，实际=${logs.length}`)

    const createdMsg = await pgQuery(
      `SELECT recipient_id, title FROM messages WHERE idempotency_key = $1`,
      [`refund-created-${paymentIdA}-${TEST_MANAGER_EMP_ID}`]
    )
    if (createdMsg.length !== 1) errors.push(`A.messages(refund-created) 应=1 行，实际=${createdMsg.length}`)
    else if (createdMsg[0].recipient_id !== TEST_MANAGER_EMP_ID) {
      errors.push(`A.refund-created recipient 应=${TEST_MANAGER_EMP_ID}，实际=${createdMsg[0].recipient_id}`)
    }
  }

  // A4. approveRefund
  if (paymentIdA) {
    const apr = await invokeStaffApi('card.approveRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      paymentId: paymentIdA,
    })
    if (apr.code !== 0) {
      errors.push(`approveRefund 应成功，实际 code=${apr.code} msg=${apr.message}`)
    } else {
      rec(`  ✓ approveRefund OK status=${apr.data?.status}`)
      if (apr.data?.status !== '已支付') errors.push(`A.approve.status 应='已支付'，实际='${apr.data?.status}'`)

      // payments 翻 '已支付' + 审批人
      const sopAfter = await pgQuery(
        `SELECT status, payment_method, external_txn_id, audit_employee_id, audit_at
           FROM sale_order_payments WHERE id = $1`,
        [paymentIdA]
      )
      if (sopAfter[0]?.status !== '已支付') errors.push(`A.payments.status 应='已支付'（审批通过），实际='${sopAfter[0]?.status}'`)
      if (sopAfter[0]?.payment_method !== '线下') errors.push(`A.approve.payment_method 应='线下'，实际='${sopAfter[0]?.payment_method}'`)
      if (sopAfter[0]?.external_txn_id !== null) errors.push(`A.approve.external_txn_id 应=NULL，实际='${sopAfter[0]?.external_txn_id}'`)
      if (sopAfter[0]?.audit_employee_id !== TEST_MANAGER_EMP_ID) errors.push(`A.audit_employee_id 应=${TEST_MANAGER_EMP_ID}，实际=${sopAfter[0]?.audit_employee_id}`)
      if (!sopAfter[0]?.audit_at) errors.push(`A.audit_at 应非 NULL`)

      // prepaid_cards.balance 扣 refundFace(800) → 0
      const card = await pgQuery(
        `SELECT balance FROM prepaid_cards WHERE user_id = $1`,
        [TEST_CLIENT_USER_ID]
      )
      if (Number(card[0]?.balance) !== 0) errors.push(`A.prepaid_cards.balance 应=0（扣 refundFace 800），实际=${card[0]?.balance}`)

      // card_transactions 落账：type='扣款' amount=-800（refundFace 口径）
      const txn = await pgQuery(
        `SELECT type, amount FROM card_transactions
         WHERE external_ref = $1`,
        [`card-refund-${paymentIdA}`]
      )
      if (txn.length !== 1) {
        errors.push(`A.card_transactions 退款落账应=1 行（external_ref=card-refund-${paymentIdA}），实际=${txn.length}`)
      } else {
        if (txn[0].type !== '扣款') errors.push(`A.card_transactions.type 应='扣款'，实际='${txn[0].type}'`)
        if (Number(txn[0].amount) !== -800) errors.push(`A.card_transactions.amount 应=-800，实际=${txn[0].amount}`)
      }

      // sale_orders.refunded_amount += |amount|=720
      const ord = await pgQuery(
        `SELECT refunded_amount FROM sale_orders WHERE sale_order_id = $1`,
        [orderA]
      )
      if (Number(ord[0]?.refunded_amount) !== 720) errors.push(`A.sale_orders.refunded_amount 应=720，实际=${ord[0]?.refunded_amount}`)

      const approvedMsg = await pgQuery(
        `SELECT recipient_id, title FROM messages WHERE idempotency_key = $1`,
        [`refund-approved-${paymentIdA}`]
      )
      if (approvedMsg.length !== 1) errors.push(`A.messages(refund-approved) 应=1 行，实际=${approvedMsg.length}`)
      else if (approvedMsg[0].recipient_id !== TEST_REFUND_STAFF_EMP_ID) {
        errors.push(`A.refund-approved recipient 应=${TEST_REFUND_STAFF_EMP_ID}，实际=${approvedMsg[0].recipient_id}`)
      }
    }
  }

  // ─── B 路径：驳回退款 ───
  // 充值单 B：面额 500 / 实付 500；储值卡余额 300（独立顾客避开 A 已清零的卡）
  const orderB = `${NS}_CARDREF_B`
  const clientB = `${NS}_CARDREF_CLI_B`
  await createTestClient({
    userId: clientB,
    openid: `${NS}_CARDREF_CLI_B_OPENID`,
    phone: '19999098014',
    name: `${NS}_顾客B`,
  })
  await createTestSaleOrder({
    saleOrderId: orderB,
    clientUserId: clientB,
    saleOrderType: '充值单',
    productName: `${NS}_充值卡500`,
    productType: '疗程卡',
    quantity: 1,
    sessionCount: 1,
    totalAmount: 500,
    status: '已支付',
    salesCategory: '他销自耗',
  })
  await pgQuery(`UPDATE sale_orders SET received = total_amount WHERE sale_order_id = $1`, [orderB])
  const cardB = await createTestPrepaidCard({
    userId: clientB,
    cardId: `${NS}_CARDREF_CARD_B`,
    initialBalance: 300,
    refOrderId: orderB,
  })
  rec(`  ✓ fixture B: ${orderB}(充值单/已支付 total=500) + 顾客B 储值卡余额 300`)

  const refB = await invokeStaffApi('card.createRefund', {
    _testOpenid: TEST_REFUND_STAFF_OPENID,
    saleOrderId: orderB,
    reason: 'e2e_card_refund_B',
  })
  if (refB.code !== 0) {
    errors.push(`createRefund B 应成功，实际 code=${refB.code} msg=${refB.message}`)
  } else {
    const paymentIdB = refB.data?.paymentId
    rec(`  ✓ createRefund B: paymentId=${paymentIdB} refundFace=${refB.data?.refundFace}`)

    const rej = await invokeStaffApi('card.rejectRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      paymentId: paymentIdB,
      reason: 'e2e_card_reject_B',
    })
    if (rej.code !== 0) {
      errors.push(`rejectRefund 应成功，实际 code=${rej.code} msg=${rej.message}`)
    } else {
      rec(`  ✓ rejectRefund OK status=${rej.data?.status}`)
      if (rej.data?.status !== '已作废') errors.push(`B.reject.status 应='已作废'，实际='${rej.data?.status}'`)

      const sopB = await pgQuery(
        `SELECT status FROM sale_order_payments WHERE id = $1`, [paymentIdB]
      )
      if (sopB[0]?.status !== '已作废') errors.push(`B.payments.status 应='已作废'（驳回），实际='${sopB[0]?.status}'`)

      // 驳回不动 balance：仍为 300
      const cardBalB = await pgQuery(
        `SELECT balance FROM prepaid_cards WHERE user_id = $1`, [clientB]
      )
      if (Number(cardBalB[0]?.balance) !== 300) {
        errors.push(`B.prepaid_cards.balance 应=300（驳回不动余额），实际=${cardBalB[0]?.balance}`)
      }

      // 驳回不落 card_transactions 扣款
      const txnB = await pgQuery(
        `SELECT id FROM card_transactions WHERE card_id = $1 AND type = '扣款'`, [cardB.cardId]
      )
      if (txnB.length !== 0) errors.push(`B.card_transactions 扣款应=0 行（驳回不落账），实际=${txnB.length}`)

      const rejectedMsg = await pgQuery(
        `SELECT recipient_id, title FROM messages WHERE idempotency_key = $1`,
        [`refund-rejected-${paymentIdB}`]
      )
      if (rejectedMsg.length !== 1) errors.push(`B.messages(refund-rejected) 应=1 行，实际=${rejectedMsg.length}`)
      else if (rejectedMsg[0].recipient_id !== TEST_REFUND_STAFF_EMP_ID) {
        errors.push(`B.refund-rejected recipient 应=${TEST_REFUND_STAFF_EMP_ID}，实际=${rejectedMsg[0].recipient_id}`)
      }
    }
  }

  // ─── C 路径：销售单退款不能误走充值卡审批/驳回入口 ───
  const orderC = `${NS}_CARDREF_C`
  await createTestSaleOrder({
    saleOrderId: orderC,
    clientUserId: TEST_CLIENT_USER_ID,
    saleOrderType: '销售单',
    productName: `${NS}_销售单`,
    productType: '疗程卡',
    quantity: 1,
    sessionCount: 1,
    totalAmount: 100,
    status: '已支付',
    salesCategory: '他销自耗',
  })
  const badRows = await pgQuery(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, amount, payment_method, status, source_end, operator_employee_id, refund_reason
     ) VALUES ($1, '退款', -10, '线下', '待审批', 'staff', $2, 'e2e_wrong_card_entry')
     RETURNING id`,
    [orderC, TEST_REFUND_STAFF_EMP_ID]
  )
  const badPaymentId = badRows[0]?.id
  const badApprove = await invokeStaffApi('card.approveRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    paymentId: badPaymentId,
  })
  if (badApprove.code === 0 || !String(badApprove.message || '').includes('非充值单')) {
    errors.push(`C.card.approveRefund 销售单退款应拒绝非充值单，实际 code=${badApprove.code} msg=${badApprove.message}`)
  }
  const badReject = await invokeStaffApi('card.rejectRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    paymentId: badPaymentId,
    reason: 'wrong-entry',
  })
  if (badReject.code === 0 || !String(badReject.message || '').includes('非充值单')) {
    errors.push(`C.card.rejectRefund 销售单退款应拒绝非充值单，实际 code=${badReject.code} msg=${badReject.message}`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 储值卡退款 createRefund + approve（扣卡/落账/refunded_amount）+ reject（余额不变）`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-card-refund] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-card-refund] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
