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
 *     7. 部分支付单（received=200、次数全在）退全额 800 > 可退余额 → 截断到 200 待审批
 *   D 路径 — 0 元退项：
 *     8. 券全额抵扣疗程卡 createRefund(amount=0) → approveRefund → paid_sessions=0
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

  // ─── C. 部分支付疗程卡整卡退超净：截断到 refundCap（仅退净已收）───
  // 2026-07-08 同步：退款联级规则 f0c77982 把 createRefund 改为
  // 「疗程卡强制整卡全退 + 数量不可调 → 截断退款额到 refundCap（仅退已付，整卡仍作废）；
  //   家居产品可调数量 → 仍拒绝」。case C 是疗程卡 + 退全部 1 次 = 800 元
  //   > refundCap=200（received - refunded_amount），所以走「截断」而非「拒绝」：
  //   - refC.code === 0、finalRefundAmount=200
  //   - sale_order_payments.amount=-200、status='待审批'（不强制走审批）
  // 反例：家居产品（hasCourseCard=false）走拒绝分支，仍报 INVALID_STATE: 退款金额超过订单可退余额
  // （这条规则由 smoke-order-payment-refund-matrix 守护，不在本文件重复）。
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
  // 部分支付：只收 200 现金（received=200），无 sale_order_payments 流水（部分支付仍待登记）
  await pgQuery(`UPDATE sale_orders SET received = 200 WHERE sale_order_id = $1`, [orderC])
  const cItems = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderC])
  const itemC = cItems[0].sale_item_id
  // 退全部 1 次 = 800 元 > refundCap（净已收 200）→ 截断到 200，整卡待审批作废
  const refC = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderC,
    items: [{ saleItemId: itemC, refundQuantity: 1 }],
    refundReason: 'e2e_refund_C_overrefund',
  })
  if (refC.code !== 0) {
    errors.push(`C.部分支付超净已收应被「截断」到 200，却失败了：code=${refC.code} msg=${refC.message}`)
  } else {
    const finalC = Number(refC.data.finalRefundAmount || 0)
    if (Math.abs(finalC - 200) > 0.01) {
      errors.push(`C.finalRefundAmount 应截断到 200，实际=${finalC}`)
    }
    const sopC = await pgQuery(
      `SELECT status, amount FROM sale_order_payments WHERE id = $1`,
      [refC.data.paymentId]
    )
    if (sopC.length !== 1) {
      errors.push(`C.payments 应=1 行`)
    } else {
      if (sopC[0].status !== '待审批') {
        errors.push(`C.status 应='待审批'，实际='${sopC[0].status}'`)
      }
      if (Math.abs(Number(sopC[0].amount) - (-200)) > 0.01) {
        errors.push(`C.amount 应=-200（截断写入），实际=${sopC[0].amount}`)
      }
    }
    rec(`  ✓ createRefund C: 超净已收(200) 整卡退 800 → 截断到 ${finalC} — paymentId=${refC.data.paymentId}`)
  }

  // ─── D. 0 元退项：券全额抵扣项目只扣次数，不产生现金退款 ───
  const orderD = `${NS}_RFD_D_ZERO`
  await createTestSaleOrder({
    saleOrderId: orderD,
    clientUserId: TEST_CLIENT_USER_ID,
    productName: `${NS}_券抵疗程卡`,
    productType: '疗程卡',
    quantity: 1,
    sessionCount: 5,
    totalAmount: 500,
    status: '已支付',
    salesCategory: '他销自耗',
  })
  await pgQuery(
    `UPDATE sale_orders
        SET total_amount = 500, payable_amount = 0, received = 0, coupon_discount = 500
      WHERE sale_order_id = $1`,
    [orderD],
  )
  await pgQuery(
    `UPDATE sale_items
        SET unit_price = 100, unit_real_price = 0, sale_amount = 0, received = 0, paid_sessions = 5
      WHERE sale_order_id = $1`,
    [orderD],
  )
  const dItems = await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`, [orderD])
  const itemD = dItems[0].sale_item_id
  const refD = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: orderD,
    items: [{ saleItemId: itemD, refundQuantity: 5 }],
    refundReason: 'e2e_refund_D_zero_cash',
  })
  if (refD.code !== 0) {
    errors.push(`D.0 元退项 createRefund 应成功，实际 code=${refD.code} msg=${refD.message}`)
  } else {
    if (Number(refD.data.finalRefundAmount) !== 0) {
      errors.push(`D.finalRefundAmount 应=0，实际=${refD.data.finalRefundAmount}`)
    }
    const sopD = await pgQuery(
      `SELECT status, amount, note FROM sale_order_payments WHERE id = $1`,
      [refD.data.paymentId],
    )
    if (sopD.length !== 1) {
      errors.push(`D.payments 应=1 行`)
    } else {
      if (sopD[0].status !== '待审批') errors.push(`D.status 应='待审批'，实际='${sopD[0].status}'`)
      if (Number(sopD[0].amount) !== 0) errors.push(`D.amount 应=0，实际=${sopD[0].amount}`)
      const noteD = JSON.parse(sopD[0].note || '{}')
      if (!noteD.items?.[0]?.isFullItemRefund) errors.push(`D.note.items[0].isFullItemRefund 应=true`)
    }
    const aprD = await invokeStaffApi('order.approveRefund', {
      _testOpenid: TEST_MANAGER_OPENID,
      paymentId: refD.data.paymentId,
      auditRemark: 'e2e_zero_cash_approve',
    })
    if (aprD.code !== 0) {
      errors.push(`D.0 元退项 approveRefund 应成功，实际 code=${aprD.code} msg=${aprD.message}`)
    } else {
      const dState = await pgQuery(
        `SELECT so.refunded_amount, so.status, si.paid_sessions
           FROM sale_orders so
           JOIN sale_items si ON si.sale_order_id = so.sale_order_id
          WHERE so.sale_order_id = $1`,
        [orderD],
      )
      if (Number(dState[0]?.refunded_amount) !== 0) errors.push(`D.refunded_amount 应=0，实际=${dState[0]?.refunded_amount}`)
      if (Number(dState[0]?.paid_sessions) !== 0) errors.push(`D.paid_sessions 应=0，实际=${dState[0]?.paid_sessions}`)
      if (dState[0]?.status !== '已退款') errors.push(`D.order.status 应='已退款'，实际='${dState[0]?.status}'`)
      rec(`  ✓ create+approveRefund D: 0 元退项 amount=0 / paid_sessions=0 / refunded_amount=0`)
    }
  }

  // ─── E. customer.refundHistory — 复用 A(已通过) + B(已作废) 的 fixture ───
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
