#!/usr/bin/env bun
/**
 * order.createRefund + approveRefund + rejectRefund 退款审批冒烟
 *
 * 验证：
 *   A 路径 — 同意退款：
 *     1. 已支付 销售单可发起退款（createRefund → 待审批 payment row）
 *     2. note JSON 含 refundByCard / refundByOrigin 拆分元数据
 *     3. operation_logs 写一条 action='order.createRefund'
 *     4. approveRefund → status: 待审批 → 已支付，amount<0；sale_orders.refunded_amount += 800
 *   B 路径 — 拒绝退款：
 *     5. 另一张销售单 createRefund → rejectRefund → status: 待审批 → 已作废
 *     6. sale_orders.refunded_amount 不变
 *   C 路径 — 超净已收防护（P2）：
 *     7. 部分支付单（received=200、次数全在）退全额 800 > 可退余额 → INVALID_STATE 被拒
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
  createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1

function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-order-refund] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  // ─── 准备两个 已支付 单品订单（A、B）───
  const orderA = `${NS}_RFD_A`
  const orderB = `${NS}_RFD_B`
  for (const oid of [orderA, orderB]) {
    await createTestSaleOrder({
      saleOrderId: oid,
      clientUserId: TEST_CLIENT_USER_ID,
      productName: `${NS}_单品800`,
      productType: '疗程卡',
      quantity: 1,
      sessionCount: 1,
      totalAmount: 800,
      status: '已支付',
      salesCategory: '他销自耗',
    })
    // 补 received=800（fixture 默认置 0）
    await pgQuery(`UPDATE sale_orders SET received = total_amount WHERE sale_order_id = $1`, [oid])
  }
  const aItems = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderA])
  const bItems = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderB])
  const itemA = aItems[0].sale_item_id
  const itemB = bItems[0].sale_item_id
  rec(`  ✓ fixture: ${orderA}(received=800) + ${orderB}(received=800)`)

  const errors = []

  // ─── A1. createRefund A ───
  const refA = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderA,
    items: [{ saleItemId: itemA, refundQuantity: 1 }],
    refundReason: 'e2e_refund_A',
  })
  if (refA.code !== 0) {
    errors.push(`createRefund A 应成功，实际 code=${refA.code} msg=${refA.message}`)
  } else {
    const { paymentId, finalRefundAmount } = refA.data
    rec(`  ✓ createRefund A: paymentId=${paymentId} amount=${finalRefundAmount}`)
    if (Number(finalRefundAmount) !== 800) errors.push(`A.finalRefundAmount 应=800，实际=${finalRefundAmount}`)

    // PG: 待审批 行
    const sops = await pgQuery(
      `SELECT status, amount, note FROM sale_order_payments WHERE id = $1`,
      [paymentId]
    )
    if (sops.length !== 1) errors.push(`A.payments 应=1 行`)
    else {
      if (sops[0].status !== '待审批') errors.push(`A.status 应='待审批'，实际='${sops[0].status}'`)
      if (Number(sops[0].amount) !== -800) errors.push(`A.amount 应=-800，实际=${sops[0].amount}`)
      const note = JSON.parse(sops[0].note || '{}')
      if (!('refundByCard' in note) || !('refundByOrigin' in note)) {
        errors.push(`A.note 应含 refundByCard / refundByOrigin 拆分字段`)
      }
    }

    // operation_logs
    const logs = await pgQuery(
      `SELECT action FROM operation_logs WHERE action = 'order.createRefund' AND target_id = $1`,
      [String(paymentId)]
    )
    if (logs.length !== 1) errors.push(`A.operation_logs 应=1 行，实际=${logs.length}`)

    // ─── A2. approveRefund ───
    const apr = await invokeStaffApi('order.approveRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      paymentId,
      auditRemark: 'e2e_approve',
    })
    if (apr.code !== 0) {
      errors.push(`approveRefund 应成功，实际 code=${apr.code} msg=${apr.message}`)
    } else {
      rec(`  ✓ approveRefund OK`)
      // PG: status → '已支付'
      const sopAfter = await pgQuery(
        `SELECT status, audit_employee_id, audit_at FROM sale_order_payments WHERE id = $1`,
        [paymentId]
      )
      if (sopAfter[0].status !== '已支付') errors.push(`A.status 应='已支付'（审批通过），实际='${sopAfter[0].status}'`)
      if (sopAfter[0].audit_employee_id !== TEST_MANAGER_EMP_ID) errors.push(`A.audit_employee_id 应=${TEST_MANAGER_EMP_ID}`)
      if (!sopAfter[0].audit_at) errors.push(`A.audit_at 应非 NULL`)

      // sale_orders.refunded_amount += 800
      const oA = await pgQuery(`SELECT refunded_amount FROM sale_orders WHERE sale_order_id = $1`, [orderA])
      if (Number(oA[0].refunded_amount) !== 800) errors.push(`A.refunded_amount 应=800，实际=${oA[0].refunded_amount}`)
    }
  }

  // ─── B1. createRefund B ───
  const refB = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderB,
    items: [{ saleItemId: itemB, refundQuantity: 1 }],
    refundReason: 'e2e_refund_B',
  })
  if (refB.code !== 0) {
    errors.push(`createRefund B 应成功，实际 code=${refB.code} msg=${refB.message}`)
  } else {
    const paymentIdB = refB.data.paymentId
    rec(`  ✓ createRefund B: paymentId=${paymentIdB}`)

    // ─── B2. rejectRefund ───
    const rej = await invokeStaffApi('order.rejectRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      paymentId: paymentIdB,
      auditRemark: 'e2e_reject_test',
    })
    if (rej.code !== 0) {
      errors.push(`rejectRefund 应成功，实际 code=${rej.code} msg=${rej.message}`)
    } else {
      rec(`  ✓ rejectRefund OK`)
      const sopB = await pgQuery(
        `SELECT status FROM sale_order_payments WHERE id = $1`, [paymentIdB]
      )
      if (sopB[0].status !== '已作废') errors.push(`B.status 应='已作废'（拒绝），实际='${sopB[0].status}'`)

      // sale_orders.refunded_amount 不变（默认 0）
      const oB = await pgQuery(`SELECT refunded_amount FROM sale_orders WHERE sale_order_id = $1`, [orderB])
      if (Number(oB[0].refunded_amount) !== 0) {
        errors.push(`B.refunded_amount 应=0（拒绝不影响），实际=${oB[0].refunded_amount}`)
      }
    }
  }

  // ─── C. 部分支付订单超净已收退款被拒（P2 守护）───
  const orderC = `${NS}_RFD_C_PARTIAL`
  await createTestSaleOrder({
    saleOrderId: orderC,
    clientUserId: TEST_CLIENT_USER_ID,
    productName: `${NS}_疗程卡800`,
    productType: '疗程卡',
    quantity: 1,
    sessionCount: 1,
    totalAmount: 800,
    status: '部分支付',
    salesCategory: '他销自耗',
  })
  // 部分支付：只收 200 现金（received=200），次数全在（remaining=1，unit_real_price=800）；无 payments 流水
  await pgQuery(`UPDATE sale_orders SET received = 200 WHERE sale_order_id = $1`, [orderC])
  const cItems = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderC])
  const itemC = cItems[0].sale_item_id
  // 退全部 1 次 = 800 元 > 可退余额（净已收 200）→ 必须被拒（防超退商家净亏）
  const refC = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderC,
    items: [{ saleItemId: itemC, refundQuantity: 1 }],
    refundReason: 'e2e_refund_C_overrefund',
  })
  if (refC.code === 0) {
    errors.push('C.部分支付超净已收退款应被拒，却成功了')
  } else if (!(refC.message || '').includes('可退余额')) {
    errors.push(`C.拒绝消息不符，实际='${refC.message}'`)
  } else {
    rec(`  ✓ createRefund C: 超净已收(200) 退款 800 被拒 — ${refC.message}`)
  }

  // ─── D. customer.refundHistory — 复用 A(已通过) + B(已作废) 的 fixture ───
  // refundHistory 返回扁平数组（routes/customer.js:963 [...refunds, ...conversions]），每行 type='退款' 或 '转换单'
  const histR = await invokeStaffApi('customer.refundHistory', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
  })
  if (histR.code !== 0) {
    errors.push(`customer.refundHistory 应成功，实际 code=${histR.code} msg=${histR.message}`)
  } else {
    const rows = Array.isArray(histR.data) ? histR.data : []
    const refundRows = rows.filter(x => x.type === '退款')
    const orderAHit = refundRows.find(x => x.refOrderId === orderA && x.status === '已支付')
    const orderBHit = refundRows.find(x => x.refOrderId === orderB && x.status === '已作废')
    if (!orderAHit) {
      errors.push(`refundHistory 应含 A 已通过退款（refOrderId=${orderA}, status='已支付'）`)
    } else {
      if (Number(orderAHit.totalAmount) !== -800) errors.push(`A 行 totalAmount 应=-800，实际=${orderAHit.totalAmount}`)
      if (!orderAHit.approvedAt) errors.push(`A 行 approvedAt 应非空`)
    }
    if (!orderBHit) errors.push(`refundHistory 应含 B 已作废退款（refOrderId=${orderB}, status='已作废'）`)
    rec(`  ✓ customer.refundHistory: 含 A(已通过) + B(已作废) 退款`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 退款 approve + reject + 超净已收防护`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-refund] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-refund] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
