#!/usr/bin/env node

/**
 * 将生产转换单 FY-XSD-WX-2608050125 从「已确认线下收款 54.19」恢复为
 * 「线下待确认收款」。原付款流水保留并标记为已作废，便于审计追溯。
 *
 * 默认 DRY-RUN：完整执行、校验后 ROLLBACK。
 * APPLY 仅允许显式连接生产库，并要求二次确认订单号：
 *
 *   DATABASE_URL="postgresql://***@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/repair-unconfirm-conversion-2608050125.js
 *
 *   DATABASE_URL="postgresql://***@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/repair-unconfirm-conversion-2608050125.js \
 *       --apply --confirm-order=FY-XSD-WX-2608050125
 */

const { Client } = require('pg')

const TARGET_ORDER_ID = 'FY-XSD-WX-2608050125'
const PROTECTED_ORDER_ID = 'FY-XSD-WX-2608130108'
const TARGET_PAYMENT_ID = 7399
const EXPECTED_AMOUNT = 54.19
const EXPECTED_CONVERTED_VALUE = 525.81
const EXPECTED_IN_AMOUNT = 580
const AUDIT_ACTION = 'order.repairUnconfirmOfflinePayment'

const APPLY = process.argv.includes('--apply')
const CONFIRMED_ORDER = (process.argv.find((arg) => arg.startsWith('--confirm-order=')) || '').split('=')[1]

function log(message) {
  console.log(`[REPAIR-UNCONFIRM-CONVERSION-0125] ${new Date().toISOString()} ${message}`)
}

function fail(message) {
  throw new Error(`前置/后置断言失败：${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function maskedUrl(raw) {
  return raw.replace(/:[^:@/]+@/, ':***@')
}

async function loadSnapshot(client, orderId, { lock = false } = {}) {
  const lockClause = lock ? ' FOR UPDATE' : ''
  const orderResult = await client.query(
    `SELECT sale_order_id, sale_order_type, status, payment_method,
            total_amount, payable_amount, received, refunded_amount,
            prepaid_card_amount, pending_prepaid_card_amount, first_payment_amount,
            paid_at, offline_confirmed_by, offline_confirmed_at,
            lakala_out_order_no, allocation_status, client_user_id, updated_at
       FROM sale_orders
      WHERE sale_order_id = $1${lockClause}`,
    [orderId],
  )

  const paymentResult = await client.query(
    `SELECT id, sale_order_id, change_type, payment_method, amount, status,
            source_end, operator_employee_id, allocation_status, paid_at, note, created_at
       FROM sale_order_payments
      WHERE sale_order_id = $1
      ORDER BY id${lockClause}`,
    [orderId],
  )

  const itemResult = await client.query(
    `SELECT sale_item_id, item_direction, ref_sale_item_id, product_name,
            session_count, remaining_sessions, paid_sessions,
            sale_amount, received, prepaid_card_received, pending_received
       FROM sale_items
      WHERE sale_order_id = $1
      ORDER BY sale_item_id${lockClause}`,
    [orderId],
  )

  const receiptResult = await client.query(
    `SELECT id, sale_payment_id, sale_item_id, amount
       FROM sale_payment_item_receipts
      WHERE sale_order_id = $1
      ORDER BY id${lockClause}`,
    [orderId],
  )

  return {
    order: orderResult.rows[0] || null,
    payments: paymentResult.rows,
    items: itemResult.rows,
    receipts: receiptResult.rows,
  }
}

function protectedFingerprint(snapshot) {
  return JSON.stringify({
    order: snapshot.order && {
      saleOrderId: snapshot.order.sale_order_id,
      status: snapshot.order.status,
      paymentMethod: snapshot.order.payment_method,
      totalAmount: snapshot.order.total_amount,
      payableAmount: snapshot.order.payable_amount,
      received: snapshot.order.received,
      prepaidCardAmount: snapshot.order.prepaid_card_amount,
      allocationStatus: snapshot.order.allocation_status,
      paidAt: snapshot.order.paid_at,
    },
    payments: snapshot.payments,
    items: snapshot.items,
    receipts: snapshot.receipts,
  })
}

async function assertNoDependentSideEffects(client) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::int
          FROM sale_payment_item_allocations spia
          JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
         WHERE spir.sale_order_id = $1 AND spia.is_void = false) AS item_allocations,
       (SELECT COUNT(*)::int
          FROM sale_allocations sa
          JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
         WHERE si.sale_order_id = $1 AND sa.is_void = false) AS legacy_allocations,
       (SELECT COUNT(*)::int
          FROM service_items svi
         WHERE svi.sale_item_id IN (
           SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 AND item_direction = '转入'
         )) AS service_items,
       (SELECT COUNT(*)::int FROM point_transactions WHERE ref_order_id = $1) AS point_transactions,
       (SELECT COUNT(*)::int FROM card_transactions WHERE ref_order_id = $1) AS card_transactions,
       (SELECT COUNT(*)::int
          FROM sale_order_payments
         WHERE sale_order_id = $1 AND change_type = '退款') AS refund_payments`,
    [TARGET_ORDER_ID],
  )
  const row = result.rows[0]
  assert(row.item_allocations === 0, '目标订单已有逐项营业额分配')
  assert(row.legacy_allocations === 0, '目标订单已有旧模型营业额分配')
  assert(row.service_items === 0, '目标订单转入权益已经生成服务明细')
  assert(row.point_transactions === 0, '目标订单已经产生积分流水')
  assert(row.card_transactions === 0, '目标订单已经产生储值卡流水')
  assert(row.refund_payments === 0, '目标订单已经产生退款流水')
}

function assertInitialState(snapshot) {
  const order = snapshot.order
  assert(order, `订单 ${TARGET_ORDER_ID} 不存在`)
  assert(order.sale_order_type === '转换单' && order.status === '已支付', '目标订单不是已支付转换单')
  assert(order.payment_method === '线下', '目标订单不是线下支付')
  assert(money(order.total_amount) === EXPECTED_AMOUNT, '目标订单 total_amount 已偏离 54.19')
  assert(money(order.payable_amount) === EXPECTED_AMOUNT, '目标订单 payable_amount 已偏离 54.19')
  assert(money(order.received) === EXPECTED_AMOUNT, '目标订单 received 已偏离 54.19')
  assert(money(order.refunded_amount) === 0, '目标订单已有退款')
  assert(money(order.prepaid_card_amount) === 0 && money(order.pending_prepaid_card_amount) === 0,
    '目标订单存在储值卡已扣或待扣金额')
  assert(order.first_payment_amount == null && order.lakala_out_order_no == null,
    '目标订单存在首付冻结或在线支付意图')
  assert(order.offline_confirmed_by != null && order.offline_confirmed_at != null && order.paid_at != null,
    '目标订单缺少已确认线下收款事实')
  assert(order.allocation_status === '待分配', '目标订单分配状态已变化')

  assert(snapshot.payments.length === 1, '目标订单不再是单笔付款流水')
  const payment = snapshot.payments[0]
  assert(Number(payment.id) === TARGET_PAYMENT_ID, `目标付款流水 ID 不再是 ${TARGET_PAYMENT_ID}`)
  assert(payment.change_type === '首次支付' && payment.payment_method === '线下' && payment.status === '已支付',
    '目标付款流水类型、通道或状态已变化')
  assert(money(payment.amount) === EXPECTED_AMOUNT, '目标付款流水金额已偏离 54.19')
  assert(payment.allocation_status === '待分配', '目标付款流水分配状态已变化')

  const outItems = snapshot.items.filter((item) => item.item_direction === '转出')
  const inItems = snapshot.items.filter((item) => item.item_direction === '转入')
  assert(snapshot.items.length === 3 && outItems.length === 2 && inItems.length === 1,
    '目标转换单明细不再是 2 条转出 + 1 条转入')
  assert(money(outItems.reduce((sum, item) => sum + Number(item.sale_amount), 0)) === -EXPECTED_CONVERTED_VALUE,
    '转出旧卡价值已偏离 -525.81')
  assert(money(inItems[0].sale_amount) === EXPECTED_IN_AMOUNT, '转入权益金额已偏离 580')
  assert(Number(inItems[0].session_count) === 1 && Number(inItems[0].remaining_sessions) === 1,
    '转入权益次数已经发生消费或变化')
  assert(snapshot.receipts.length === 3
    && snapshot.receipts.every((receipt) => Number(receipt.sale_payment_id) === TARGET_PAYMENT_ID),
  '目标付款回执不再完整对应付款 7399')
}

function isAlreadyCorrect(snapshot) {
  if (!snapshot.order || snapshot.payments.length !== 1) return false
  const order = snapshot.order
  const payment = snapshot.payments[0]
  const inItem = snapshot.items.find((item) => item.item_direction === '转入')
  return order.status === '待支付'
    && order.payment_method === '线下'
    && money(order.received) === 0
    && order.paid_at == null
    && order.offline_confirmed_by == null
    && order.offline_confirmed_at == null
    && Number(payment.id) === TARGET_PAYMENT_ID
    && payment.status === '已作废'
    && payment.allocation_status == null
    && inItem != null
    && money(inItem.received) === EXPECTED_CONVERTED_VALUE
    && Number(inItem.paid_sessions) === 0
}

async function applyRepair(client) {
  const paymentUpdate = await client.query(
    `UPDATE sale_order_payments
        SET status = '已作废',
            allocation_status = NULL
      WHERE id = $1
        AND sale_order_id = $2
        AND change_type = '首次支付'
        AND payment_method = '线下'
        AND status = '已支付'
        AND amount = $3::numeric`,
    [TARGET_PAYMENT_ID, TARGET_ORDER_ID, EXPECTED_AMOUNT.toFixed(2)],
  )
  assert(paymentUpdate.rowCount === 1, '未精确作废付款流水 7399')

  const orderUpdate = await client.query(
    `UPDATE sale_orders
        SET status = '待支付',
            payment_method = '线下',
            payable_amount = total_amount,
            received = 0,
            prepaid_card_amount = 0,
            pending_prepaid_card_amount = 0,
            first_payment_amount = NULL,
            paid_at = NULL,
            offline_confirmed_by = NULL,
            offline_confirmed_at = NULL,
            allocation_status = '待分配',
            updated_at = NOW()
      WHERE sale_order_id = $1
        AND status = '已支付'
        AND payment_method = '线下'
        AND received = $2::numeric`,
    [TARGET_ORDER_ID, EXPECTED_AMOUNT.toFixed(2)],
  )
  assert(orderUpdate.rowCount === 1, '未精确恢复目标订单为待支付')

  const outUpdate = await client.query(
    `UPDATE sale_items
        SET received = sale_amount,
            prepaid_card_received = 0,
            paid_sessions = CASE WHEN session_count IS NULL THEN NULL ELSE session_count END,
            updated_at = NOW()
      WHERE sale_order_id = $1 AND item_direction = '转出'`,
    [TARGET_ORDER_ID],
  )
  assert(outUpdate.rowCount === 2, '未精确刷新 2 条转出明细')

  const inUpdate = await client.query(
    `WITH converted AS (
       SELECT COALESCE(SUM(GREATEST(0, -received::numeric)), 0) AS converted_value
         FROM sale_items
        WHERE sale_order_id = $1 AND item_direction = '转出'
     )
     UPDATE sale_items si
        SET received = LEAST(si.sale_amount::numeric, converted.converted_value),
            prepaid_card_received = 0,
            paid_sessions = CASE
              WHEN si.session_count IS NULL THEN NULL
              WHEN si.sale_amount::numeric <= 0 THEN si.session_count
              ELSE LEAST(
                si.session_count,
                FLOOR(LEAST(si.sale_amount::numeric, converted.converted_value)
                  * si.session_count / si.sale_amount::numeric)::integer
              )
            END,
            updated_at = NOW()
       FROM converted
      WHERE si.sale_order_id = $1 AND si.item_direction = '转入'`,
    [TARGET_ORDER_ID],
  )
  assert(inUpdate.rowCount === 1, '未精确刷新 1 条转入明细')

  const auditInsert = await client.query(
    `INSERT INTO operation_logs
       (operator_employee_id, operator_name, operator_role, org_node_id, org_node_name,
        action, target_type, target_id, detail, source, created_at)
     SELECT NULL, NULL, NULL, NULL, NULL,
            $2, 'sale_order', $1, $3::jsonb, 'maintenance', NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM operation_logs WHERE action = $2 AND target_id = $1
      )`,
    [TARGET_ORDER_ID, AUDIT_ACTION, JSON.stringify({
      _v: 1,
      reason: '线下款项实际未收，恢复为待确认线下收款',
      paymentId: TARGET_PAYMENT_ID,
      before: { status: '已支付', received: EXPECTED_AMOUNT },
      after: { status: '待支付', received: 0 },
    })],
  )
  assert(auditInsert.rowCount === 1, '未写入唯一的数据修复审计日志')
}

async function assertFinalState(client, snapshot) {
  assert(isAlreadyCorrect(snapshot), '修复后订单、付款或转入权益未恢复到目标状态')
  const order = snapshot.order
  assert(money(order.total_amount) === EXPECTED_AMOUNT && money(order.payable_amount) === EXPECTED_AMOUNT,
    '修复后订单应付金额不是 54.19')
  assert(money(order.prepaid_card_amount) === 0 && money(order.pending_prepaid_card_amount) === 0,
    '修复后订单仍存在储值卡金额')
  assert(order.first_payment_amount == null && order.lakala_out_order_no == null,
    '修复后订单仍存在支付冻结')
  assert(order.allocation_status === '待分配', '修复后订单分配状态不是待分配')
  assert(snapshot.receipts.length === 3, '原始付款回执未完整保留')

  const activePaymentResult = await client.query(
    `SELECT COALESCE(SUM(amount::numeric), 0) AS active_received
       FROM sale_order_payments
      WHERE sale_order_id = $1
        AND status = '已支付'
        AND change_type IN ('首次支付', '回款', '储值卡抵扣')`,
    [TARGET_ORDER_ID],
  )
  assert(money(activePaymentResult.rows[0].active_received) === 0, '有效付款流水合计不是 0')

  const netItemReceived = money(snapshot.items.reduce((sum, item) => sum + Number(item.received), 0))
  assert(netItemReceived === 0, '转换明细有符号实收合计不是 0')
  await assertNoDependentSideEffects(client)
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('FATAL: 必须显式设置 DATABASE_URL')
    process.exit(1)
  }

  const parsed = new URL(databaseUrl)
  if (APPLY) {
    if (CONFIRMED_ORDER !== TARGET_ORDER_ID) {
      console.error(`FATAL: APPLY 必须追加 --confirm-order=${TARGET_ORDER_ID}`)
      process.exit(1)
    }
    if (parsed.hostname !== '118.178.196.26' || parsed.port !== '5433' || parsed.pathname !== '/fengyu_wxapp') {
      console.error('FATAL: APPLY 仅允许生产库 118.178.196.26:5433/fengyu_wxapp')
      process.exit(1)
    }
  }

  log(`目标库: ${maskedUrl(databaseUrl)}`)
  log(`模式: ${APPLY ? 'APPLY（提交）' : 'DRY-RUN（完整执行后回滚）'}`)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('BEGIN')

    const protectedBefore = await loadSnapshot(client, PROTECTED_ORDER_ID)
    assert(protectedBefore.order, `保护订单 ${PROTECTED_ORDER_ID} 不存在`)
    const protectedBeforeFingerprint = protectedFingerprint(protectedBefore)

    await assertNoDependentSideEffects(client)
    const before = await loadSnapshot(client, TARGET_ORDER_ID, { lock: true })
    if (isAlreadyCorrect(before)) {
      log(`订单 ${TARGET_ORDER_ID} 已是线下待支付且实收为 0，无需重复修复`)
      await client.query('ROLLBACK')
      return
    }
    assertInitialState(before)
    log(`修复前：订单状态 ${before.order.status}，实收 ${money(before.order.received).toFixed(2)}，付款 ${before.payments[0].status}`)

    await applyRepair(client)

    const after = await loadSnapshot(client, TARGET_ORDER_ID)
    await assertFinalState(client, after)
    const protectedAfter = await loadSnapshot(client, PROTECTED_ORDER_ID)
    assert(protectedFingerprint(protectedAfter) === protectedBeforeFingerprint,
      `保护订单 ${PROTECTED_ORDER_ID} 发生意外变化`)
    log(`修复后：订单状态 ${after.order.status}，实收 ${money(after.order.received).toFixed(2)}，付款 ${after.payments[0].status}`)

    if (APPLY) {
      await client.query('COMMIT')
      log(`已提交生产订单 ${TARGET_ORDER_ID} 的线下收款撤销 ✓`)
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN 已回滚；所有前置、更新和后置断言均通过')
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[REPAIR-UNCONFIRM-CONVERSION-0125] 修复失败，已回滚：', error)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('FATAL:', error)
  process.exit(1)
})
