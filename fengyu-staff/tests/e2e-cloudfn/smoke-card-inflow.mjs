#!/usr/bin/env bun
/**
 * card.inflow 旧系统充值金转入全链冒烟（真 PG）
 *
 * 契约（cloudfunctions/staffApi/routes/card.js inflow）：
 *   - 1:1 等额、不打折、不限额、不走 matchTier 档位；
 *   - 直接建 sale_order_type='充值单' status='已支付' 单（total=payable=received=amount）
 *     + 一条 change_type='首次支付' 流水（线下/external_txn_id=NULL）
 *     + 即时入账 prepaid_cards.balance += amount + card_transactions(type='充值')；
 *   - remark / note 打专用标记「旧系统充值金转入」；幂等键 card-topup-{saleOrderId}。
 *
 * 验证：
 *   A 转入：amount=3680.50（非档位、带小数）→ 订单/流水/余额/标记全部精确等额（证明绕过 matchTier 不打折）
 *   B 退款回归：转入单天然走 card.createRefund → approveRefund（refundFace=min(3680.50,余额)=3680.50，1:1）；
 *              且 refunded_amount ≤ received（资金不变量 I2b）
 *   C 参数校验：amount<=0 / >2 位小数 被拒
 */
import './setup.mjs'
import {
  NS, TEST_MANAGER_OPENID, TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, cleanupTestData } from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

const AMOUNT = 3680.50 // 非档位 + 带小数：matchTier 会按比例打折，inflow 必须精确等额入账

async function main() {
  rec(`[smoke-card-inflow] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  const errors = []

  // ─── A. 转入 ───
  const r1 = await invokeStaffApi('card.inflow', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    amount: AMOUNT,
    remark: 'WorkFine迁移',
  })
  let saleOrderId = null
  if (r1.code !== 0) {
    errors.push(`inflow 应成功，实际 code=${r1.code} msg=${r1.message}`)
  } else {
    saleOrderId = r1.data?.saleOrderId
    rec(`  ✓ inflow OK saleOrderId=${saleOrderId} amount=¥${r1.data?.amount} status=${r1.data?.status}`)
    if (r1.data?.status !== '已支付') errors.push(`A.status 应='已支付'，实际='${r1.data?.status}'`)
    if (Number(r1.data?.amount) !== AMOUNT) errors.push(`A.amount 应=${AMOUNT}，实际=${r1.data?.amount}`)
  }

  if (saleOrderId) {
    // A.1 订单字段
    const ord = (await pgQuery(
      `SELECT status, sale_order_type, total_amount, payable_amount, received, prepaid_card_amount, payment_method, remark
       FROM sale_orders WHERE sale_order_id = $1`, [saleOrderId],
    ))[0]
    if (ord?.status !== '已支付') errors.push(`A.sale_orders.status 应='已支付'，实际='${ord?.status}'`)
    if (ord?.sale_order_type !== '充值单') errors.push(`A.sale_order_type 应='充值单'，实际='${ord?.sale_order_type}'`)
    if (Number(ord?.total_amount) !== AMOUNT) errors.push(`A.total_amount 应=${AMOUNT}，实际=${ord?.total_amount}`)
    if (Number(ord?.payable_amount) !== AMOUNT) errors.push(`A.payable_amount 应=${AMOUNT}（不打折），实际=${ord?.payable_amount}`)
    if (Number(ord?.received) !== AMOUNT) errors.push(`A.received 应=${AMOUNT}（资金不变量 I1），实际=${ord?.received}`)
    if (Number(ord?.prepaid_card_amount) !== 0) errors.push(`A.prepaid_card_amount 应=0，实际=${ord?.prepaid_card_amount}`)
    if (ord?.payment_method !== '线下') errors.push(`A.payment_method 应='线下'，实际='${ord?.payment_method}'`)
    if (!String(ord?.remark || '').includes('旧系统充值金转入')) errors.push(`A.remark 应含'旧系统充值金转入'，实际='${ord?.remark}'`)
    else rec(`  ✓ 订单字段 OK（充值单/已支付/total=payable=received=${AMOUNT}/线下/标记备注）`)

    // A.2 首次支付流水
    const sop = await pgQuery(
      `SELECT change_type, amount, payment_method, status, external_txn_id, note
       FROM sale_order_payments WHERE sale_order_id = $1`, [saleOrderId],
    )
    if (sop.length !== 1) {
      errors.push(`A.sale_order_payments 应=1 行，实际=${sop.length}`)
    } else {
      if (sop[0].change_type !== '首次支付') errors.push(`A.payments.change_type 应='首次支付'，实际='${sop[0].change_type}'`)
      if (Number(sop[0].amount) !== AMOUNT) errors.push(`A.payments.amount 应=${AMOUNT}，实际=${sop[0].amount}`)
      if (sop[0].status !== '已支付') errors.push(`A.payments.status 应='已支付'，实际='${sop[0].status}'`)
      if (sop[0].payment_method !== '线下') errors.push(`A.payments.payment_method 应='线下'，实际='${sop[0].payment_method}'`)
      if (sop[0].external_txn_id !== null) errors.push(`A.payments.external_txn_id 应=NULL，实际='${sop[0].external_txn_id}'`)
      else rec(`  ✓ 首次支付流水 OK（线下/已支付/external_txn_id=NULL）`)
    }

    // A.3 储值卡入账 + 幂等键
    const topup = await pgQuery(
      `SELECT type, amount, external_ref FROM card_transactions WHERE ref_order_id = $1 AND type = '充值'`, [saleOrderId],
    )
    if (topup.length !== 1) {
      errors.push(`A.card_transactions 充值入账应 1 行，实际=${topup.length}`)
    } else {
      if (Math.abs(Number(topup[0].amount) - AMOUNT) > 0.001) errors.push(`A.充值入账 amount 应=${AMOUNT}，实际=${topup[0].amount}`)
      if (topup[0].external_ref !== `card-topup-${saleOrderId}`) errors.push(`A.external_ref 应=card-topup-${saleOrderId}，实际='${topup[0].external_ref}'`)
    }

    // A.4 prepaid_cards 余额精确等额（证明不打折、不限额）
    const card = (await pgQuery(`SELECT balance FROM prepaid_cards WHERE user_id = $1`, [TEST_CLIENT_USER_ID]))[0]
    if (Math.abs(Number(card?.balance) - AMOUNT) > 0.001) errors.push(`A.prepaid_cards.balance 应=${AMOUNT}（等额不打折），实际=${card?.balance}`)
    else rec(`  ✓ 储值卡余额 OK：精确 +¥${card?.balance}（绕过 matchTier 不打折/不限额）`)

    // A.5 审计日志
    const logs = await pgQuery(`SELECT action FROM operation_logs WHERE action='card.inflow' AND target_id=$1`, [saleOrderId])
    if (logs.length !== 1) errors.push(`A.operation_logs(card.inflow) 应=1 行，实际=${logs.length}`)
  }

  // ─── B. 退款回归：转入单天然走充值卡退款链路 ───
  if (saleOrderId && !errors.length) {
    const refB = await invokeStaffApi('card.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID, saleOrderId, reason: '旧系统充值金退款',
    })
    if (refB.code !== 0) {
      errors.push(`B.createRefund 转入单应可退，实际 code=${refB.code} msg=${refB.message}`)
    } else {
      const { paymentId, refundFace, refundPay } = refB.data
      rec(`  ✓ B.createRefund OK refundFace=${refundFace} refundPay=${refundPay}`)
      if (Math.abs(Number(refundFace) - AMOUNT) > 0.001) errors.push(`B.refundFace 应=${AMOUNT}，实际=${refundFace}`)
      if (Math.abs(Number(refundPay) - AMOUNT) > 0.001) errors.push(`B.refundPay 应=${AMOUNT}（1:1），实际=${refundPay}`)

      const apr = await invokeStaffApi('card.approveRefund', { _testOpenid: TEST_MANAGER_OPENID, paymentId })
      if (apr.code !== 0) {
        errors.push(`B.approveRefund 应成功，实际 code=${apr.code} msg=${apr.message}`)
      } else {
        const bal = (await pgQuery(`SELECT balance FROM prepaid_cards WHERE user_id=$1`, [TEST_CLIENT_USER_ID]))[0]
        if (Number(bal?.balance) !== 0) errors.push(`B.退款后余额应=0，实际=${bal?.balance}`)
        const ord2 = (await pgQuery(`SELECT received, refunded_amount FROM sale_orders WHERE sale_order_id=$1`, [saleOrderId]))[0]
        if (Number(ord2?.refunded_amount) > Number(ord2?.received) + 0.01) {
          errors.push(`B.资金不变量违反：refunded_amount(${ord2?.refunded_amount}) > received(${ord2?.received})`)
        } else {
          rec(`  ✓ B.退款回归 OK：余额清零 + refunded_amount(${ord2?.refunded_amount}) ≤ received(${ord2?.received})`)
        }
      }
    }
  }

  // ─── C. 参数校验 ───
  const cNeg = await invokeStaffApi('card.inflow', { _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID, amount: -100 })
  if (cNeg.code === 0) errors.push(`C.负金额应被拒绝，实际成功`)
  const cDec = await invokeStaffApi('card.inflow', { _testOpenid: TEST_MANAGER_OPENID, clientUserId: TEST_CLIENT_USER_ID, amount: 100.123 })
  if (cDec.code === 0) errors.push(`C.>2 位小数应被拒绝，实际成功`)
  if (!errors.some(e => e.startsWith('C.'))) rec(`  ✓ C.参数校验 OK（负数/超 2 位小数被拒）`)

  if (errors.length) { rec(`  ✗ FAIL: ${errors.length} 项断言失败`); for (const e of errors) rec(`    - ${e}`); return }
  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 转入(等额不打折/标记/入账) + 退款回归(天然可退/不变量) + 参数校验`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-card-inflow] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-card-inflow] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
