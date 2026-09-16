#!/usr/bin/env node

/**
 * 生产数据修复：撤销误录转换单 FY-XSD-WX-2608130108 及其误录服务单，
 * 恢复原卡 1 次并退回 200 元储值金。
 *
 * 默认 DRY-RUN：事务内执行完整修复及后置断言，最后 ROLLBACK。
 * APPLY 仅允许显式连接生产库，并要求确认令牌：
 *
 *   DATABASE_URL="postgresql://***@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/repair-cancel-conversion-order-2608130108.js
 *
 *   DATABASE_URL="postgresql://***@118.178.196.26:5433/fengyu_wxapp" \
 *     node db/scripts/repair-cancel-conversion-order-2608130108.js \
 *       --apply --confirm-prod=repair-cancel-conversion-order-2608130108
 */

const { Client } = require('pg')
const { OVERRIDE_KEYS: DB_OVERRIDE_KEYS } = require('./_lib/assert-db-target')

const BATCH_ID = 'repair-cancel-conversion-order-2608130108'
const CONFIRM_TOKEN = `--confirm-prod=${BATCH_ID}`
const APPLY = process.argv.includes('--apply')
const CONFIRMED = process.argv.includes(CONFIRM_TOKEN)

const ORDER_ID = 'FY-XSD-WX-2608130108'
const SERVICE_ORDER_ID = 'HLD-WX-2608230322'
const CLIENT_USER_ID = 'FYGK-20260802-00153'
const SOURCE_ITEM_ID = 'XSLSH-WX-202608121826'
const CONVERSION_OUT_ITEM_ID = 'XSLSH-WX-202608131088'
const CONVERSION_IN_ITEM_ID = 'XSLSH-WX-202608131089'
const ORIGINAL_PAYMENT_ID = 190637
const ORIGINAL_CARD_TRANSACTION_ID = 89
const SERVICE_COMMISSION_ID = 19399
const REFUND_AMOUNT = 200
const COMMISSION_AMOUNT = 60

const CARD_REFUND_EXTERNAL_REF = `${BATCH_ID}:card-refund:${ORDER_ID}`
const COMMISSION_VOID_REASON = `${BATCH_ID}: 误录服务提成作废`
const REASON = '误录转换单及服务单：无真实线下收款，撤销转换并退回200元储值金'

function log(message, value) {
  if (value === undefined) console.log(`[CONVERSION-CANCEL-REPAIR] ${message}`)
  else console.log(`[CONVERSION-CANCEL-REPAIR] ${message}`, value)
}

function fail(message) {
  throw new Error(`前置/后置断言失败：${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function number(value) {
  return Number(value || 0)
}

function cents(value) {
  return Math.round(number(value) * 100)
}

function maskedUrl(raw) {
  return raw.replace(/:[^:@/]+@/, ':***@')
}

function summarize(state) {
  return {
    order: state.order && {
      status: state.order.status,
      received: number(state.order.received),
      refundedAmount: number(state.order.refunded_amount),
      prepaidCardAmount: number(state.order.prepaid_card_amount),
      payableAmount: number(state.order.payable_amount),
      allocationStatus: state.order.allocation_status,
    },
    sourceRemainingSessions: state.sourceItem && number(state.sourceItem.remaining_sessions),
    conversionItems: state.conversionItems.map((row) => ({
      saleItemId: row.sale_item_id,
      direction: row.item_direction,
      remainingSessions: row.remaining_sessions == null ? null : number(row.remaining_sessions),
      paidSessions: row.paid_sessions == null ? null : number(row.paid_sessions),
      received: number(row.received),
      prepaidCardReceived: number(row.prepaid_card_received),
    })),
    service: state.service && {
      status: state.service.status,
      commissionStatus: state.service.commission_status,
    },
    activeCommissionRows: number(state.activeCommission.rows),
    activeCommissionAmount: number(state.activeCommission.amount),
    cardBalance: state.card && number(state.card.balance),
    cardLedgerTotal: number(state.cardLedger.total),
    paymentNet: number(state.paymentTotals.net),
    receiptNet: number(state.receiptTotals.net),
    monthlyActivity: state.customer && state.customer.monthly_activity,
    spendingTier: state.customer && state.customer.spending_tier,
  }
}

async function loadState(client, lock = false) {
  const lockSql = lock ? ' FOR UPDATE' : ''
  const orderRes = await client.query(
    `SELECT sale_order_id, status, sale_order_type, total_amount, payable_amount,
            received, refunded_amount, prepaid_card_amount, pending_prepaid_card_amount,
            payment_method, allocation_status, client_user_id, coupon_id, points_used
       FROM sale_orders WHERE sale_order_id = $1${lockSql}`,
    [ORDER_ID],
  )
  const sourceRes = await client.query(
    `SELECT sale_item_id, sale_order_id, session_count, remaining_sessions, paid_sessions,
            received, prepaid_card_received
       FROM sale_items WHERE sale_item_id = $1${lockSql}`,
    [SOURCE_ITEM_ID],
  )
  const conversionRes = await client.query(
    `SELECT sale_item_id, sale_order_id, item_direction, ref_sale_item_id, sales_category,
            session_count, remaining_sessions, paid_sessions, received, prepaid_card_received
       FROM sale_items
      WHERE sale_order_id = $1
      ORDER BY sale_item_id${lockSql}`,
    [ORDER_ID],
  )
  const serviceRes = await client.query(
    `SELECT service_order_id, status, commission_status, appointment_id, client_user_id,
            started_at, staff_completed_at, completed_at
       FROM service_orders WHERE service_order_id = $1${lockSql}`,
    [SERVICE_ORDER_ID],
  )
  const cardRes = await client.query(
    `SELECT pc.card_id, pc.user_id, pc.balance
       FROM prepaid_cards pc
       JOIN card_transactions ct ON ct.card_id = pc.card_id
      WHERE ct.id = $1${lockSql}`,
    [ORIGINAL_CARD_TRANSACTION_ID],
  )
  const activeCommission = await client.query(
    `SELECT COUNT(*)::int AS rows,
            COALESCE(SUM(sc.commission_amount::numeric), 0)::numeric(12,2) AS amount
       FROM service_commissions sc
       JOIN service_items sit ON sit.service_item_id = sc.service_item_id
      WHERE sit.service_order_id = $1 AND sc.is_void = false`,
    [SERVICE_ORDER_ID],
  )
  const cardLedger = cardRes.rows[0]
    ? await client.query(
      'SELECT COALESCE(SUM(amount::numeric), 0)::numeric(12,2) AS total FROM card_transactions WHERE card_id = $1',
      [cardRes.rows[0].card_id],
    )
    : { rows: [{ total: 0 }] }
  const paymentTotals = await client.query(
    `SELECT COALESCE(SUM(amount::numeric), 0)::numeric(12,2) AS net,
            COALESCE(SUM(amount::numeric) FILTER (
              WHERE change_type IN ('首次支付','回款','储值卡抵扣') AND status = '已支付'
            ), 0)::numeric(12,2) AS gross_received,
            COALESCE(-SUM(amount::numeric) FILTER (
              WHERE change_type = '退款' AND status = '已支付'
            ), 0)::numeric(12,2) AS refunded,
            COALESCE(SUM(amount::numeric) FILTER (
              WHERE status = '已支付'
                AND (change_type = '储值卡抵扣' OR (change_type = '退款' AND payment_method = '储值卡'))
            ), 0)::numeric(12,2) AS prepaid_net
       FROM sale_order_payments WHERE sale_order_id = $1`,
    [ORDER_ID],
  )
  const receiptTotals = await client.query(
    `SELECT COALESCE(SUM(spir.amount::numeric), 0)::numeric(12,2) AS net
       FROM sale_payment_item_receipts spir
       JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
      WHERE spir.sale_order_id = $1 AND sop.status = '已支付'`,
    [ORDER_ID],
  )
  const customerRes = await client.query(
    `SELECT user_id, customer_type, customer_status, spending_tier, monthly_activity, points_balance
       FROM client_wechat_users WHERE user_id = $1${lockSql}`,
    [CLIENT_USER_ID],
  )

  return {
    order: orderRes.rows[0] || null,
    sourceItem: sourceRes.rows[0] || null,
    conversionItems: conversionRes.rows,
    service: serviceRes.rows[0] || null,
    card: cardRes.rows[0] || null,
    activeCommission: activeCommission.rows[0],
    cardLedger: cardLedger.rows[0],
    paymentTotals: paymentTotals.rows[0],
    receiptTotals: receiptTotals.rows[0],
    customer: customerRes.rows[0] || null,
  }
}

async function assertProductionTarget(client, databaseUrl) {
  const url = new URL(databaseUrl)
  // query 参数（含百分号编码形式）优先级高于 URL authority，只比 hostname/port/pathname
  // 会被 `?host=<旧库>` 整个绕过 —— 而本脚本 --apply 直接写生产数据。
  {
    const overriding = DB_OVERRIDE_KEYS.filter((k) => url.searchParams.has(k))
    if (overriding.length) {
      console.error(`FATAL: 连接串 query 试图覆盖连接目标（${overriding.join(', ')}），拒绝执行`)
      process.exit(1)
    }
  }

  assert(url.hostname === '118.178.196.26', `仅允许生产 host 118.178.196.26，实际 ${url.hostname}`)
  assert(url.port === '5433', `仅允许生产端口 5433，实际 ${url.port || '(默认)'}`)
  assert(url.pathname === '/fengyu_wxapp', `仅允许数据库 fengyu_wxapp，实际 ${url.pathname}`)

  const dbRes = await client.query(
    `SELECT current_database() AS db,
            inet_server_port()::int AS port,
            to_regclass('public.sale_orders')::text AS sale_orders,
            to_regclass('public.card_transactions')::text AS card_transactions,
            to_regclass('public.service_commissions')::text AS service_commissions`,
  )
  const row = dbRes.rows[0]
  assert(row.db === 'fengyu_wxapp', `当前数据库不是 fengyu_wxapp：${row.db}`)
  assert(number(row.port) === 5433, `当前数据库端口不是 5433：${row.port}`)
  assert(row.sale_orders && row.card_transactions && row.service_commissions, '生产库缺少修复所需表')
}

async function hasAppliedAudit(client) {
  const res = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM operation_logs
      WHERE source = 'maintenance'
        AND action = 'datafix.cancelMistakenConversion'
        AND target_id = $1
        AND detail->>'batchId' = $2`,
    [ORDER_ID, BATCH_ID],
  )
  return number(res.rows[0]?.count) > 0
}

async function assertInitialState(client, state) {
  assert(state.order, `订单 ${ORDER_ID} 不存在`)
  assert(state.order.status === '已支付', `订单状态应为已支付，实际 ${state.order.status}`)
  assert(state.order.sale_order_type === '转换单', `订单类型应为转换单，实际 ${state.order.sale_order_type}`)
  assert(state.order.client_user_id === CLIENT_USER_ID, '订单顾客发生变化')
  assert(cents(state.order.total_amount) === 20000, '订单总金额不是 200 元')
  assert(cents(state.order.received) === 20000, '订单毛实收不是 200 元')
  assert(cents(state.order.refunded_amount) === 0, '订单已有退款，停止修复')
  assert(cents(state.order.prepaid_card_amount) === 20000, '订单储值卡实付不是 200 元')
  assert(cents(state.order.pending_prepaid_card_amount) === 0, '订单仍有待扣储值金额')
  assert(cents(state.order.payable_amount) === 0, '订单现金应付不是 0 元')
  assert(state.order.payment_method === '无', `订单支付方式应为无，实际 ${state.order.payment_method}`)
  assert(state.order.coupon_id == null && number(state.order.points_used) === 0, '订单存在券或积分副作用')

  assert(state.sourceItem, `原卡 ${SOURCE_ITEM_ID} 不存在`)
  assert(number(state.sourceItem.session_count) === 1, '原卡总次数不是 1')
  assert(number(state.sourceItem.remaining_sessions) === 0, '原卡剩余次数不是 0')

  assert(state.conversionItems.length === 2, `转换单明细应为 2 行，实际 ${state.conversionItems.length}`)
  const outItem = state.conversionItems.find((row) => row.sale_item_id === CONVERSION_OUT_ITEM_ID)
  const inItem = state.conversionItems.find((row) => row.sale_item_id === CONVERSION_IN_ITEM_ID)
  assert(outItem && outItem.item_direction === '转出' && outItem.ref_sale_item_id === SOURCE_ITEM_ID, '转换转出行不符合预期')
  assert(inItem && inItem.item_direction === '转入', '转换转入行不符合预期')
  assert(number(inItem.session_count) === 2 && number(inItem.remaining_sessions) === 0, '转换转入卡不是已核销 2 次')

  assert(state.service, `服务单 ${SERVICE_ORDER_ID} 不存在`)
  assert(state.service.status === '已完成', `服务单状态应为已完成，实际 ${state.service.status}`)
  assert(state.service.client_user_id === CLIENT_USER_ID, '服务单顾客发生变化')
  assert(state.service.appointment_id == null, '服务单存在关联预约，需重新评估')
  assert(number(state.activeCommission.rows) === 1, '活动服务提成应为 1 条')
  assert(cents(state.activeCommission.amount) === 6000, '活动服务提成不是 60 元')

  assert(state.card && state.card.user_id === CLIENT_USER_ID, '原扣款流水未关联目标顾客储值卡')
  assert(cents(state.card.balance) === cents(state.cardLedger.total), '储值卡余额与流水合计不一致')
  assert(cents(state.paymentTotals.gross_received) === 20000, '正向款项流水合计不是 200 元')
  assert(cents(state.paymentTotals.refunded) === 0, '订单已存在成功退款流水')
  assert(cents(state.paymentTotals.net) === 20000, '订单款项净额不是 200 元')
  assert(cents(state.receiptTotals.net) === 20000, '订单商品实收明细净额不是 200 元')

  const originalPayment = await client.query(
    `SELECT id, change_type, payment_method, amount, status, source_end
       FROM sale_order_payments WHERE id = $1 FOR UPDATE`,
    [ORIGINAL_PAYMENT_ID],
  )
  assert(originalPayment.rowCount === 1, `原储值卡款项 ${ORIGINAL_PAYMENT_ID} 不存在`)
  const pay = originalPayment.rows[0]
  assert(pay.change_type === '储值卡抵扣' && pay.payment_method === '储值卡', '原款项不是储值卡抵扣')
  assert(pay.status === '已支付' && cents(pay.amount) === 20000, '原储值卡款项状态或金额变化')

  const originalCardTxn = await client.query(
    `SELECT id, card_id, type, amount, ref_order_id, external_ref
       FROM card_transactions WHERE id = $1 FOR UPDATE`,
    [ORIGINAL_CARD_TRANSACTION_ID],
  )
  assert(originalCardTxn.rowCount === 1, `原储值卡扣款 ${ORIGINAL_CARD_TRANSACTION_ID} 不存在`)
  const cardTxn = originalCardTxn.rows[0]
  assert(cardTxn.type === '扣款' && cents(cardTxn.amount) === -20000, '原储值卡扣款类型或金额变化')
  assert(cardTxn.ref_order_id === ORDER_ID, '原储值卡扣款关联订单变化')

  const serviceItems = await client.query(
    `SELECT service_item_id, sale_item_id, session_used, reserved_at
       FROM service_items WHERE service_order_id = $1 FOR UPDATE`,
    [SERVICE_ORDER_ID],
  )
  assert(serviceItems.rowCount === 1, `误录服务单明细应为 1 行，实际 ${serviceItems.rowCount}`)
  assert(serviceItems.rows[0].sale_item_id === CONVERSION_IN_ITEM_ID, '误录服务未核销预期转换转入行')
  assert(number(serviceItems.rows[0].session_used) === 2, '误录服务核销次数不是 2')
  assert(serviceItems.rows[0].reserved_at == null, '误录服务仍有预扣标记')

  const dependencies = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM service_reviews WHERE service_order_id = $1)::int AS reviews,
       (SELECT COUNT(*) FROM messages WHERE ref_entity_id IN ($1, $2))::int AS messages,
       (SELECT COUNT(*) FROM point_transactions WHERE ref_order_id = $2)::int AS order_points,
       (SELECT COUNT(*) FROM point_transactions
         WHERE external_ref = 'visit-points:' || $3 || ':2026-08-23')::int AS visit_points,
       (SELECT COUNT(*) FROM sale_payment_item_allocations spia
         JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
        WHERE spir.sale_order_id = $2 AND spia.is_void = false)::int AS active_allocations,
       (SELECT COUNT(*) FROM sale_items
        WHERE ref_sale_item_id IN ($4, $5)
          AND sale_order_id <> $2)::int AS downstream_refs`,
    [SERVICE_ORDER_ID, ORDER_ID, CLIENT_USER_ID, SOURCE_ITEM_ID, CONVERSION_IN_ITEM_ID],
  )
  const dep = dependencies.rows[0]
  assert(number(dep.reviews) === 0, '误录服务单已有评价')
  assert(number(dep.messages) === 0, '订单或服务单存在关联消息')
  assert(number(dep.order_points) === 0 && number(dep.visit_points) === 0, '订单或服务产生了积分流水')
  assert(number(dep.active_allocations) === 0, '订单存在活动营业额分配')
  assert(number(dep.downstream_refs) === 0, '原卡或转入卡已有其他下游转换引用')
}

async function applyRepair(client, before) {
  const serviceUpdate = await client.query(
    `UPDATE service_orders
        SET status = '已取消', commission_status = NULL, updated_at = NOW()
      WHERE service_order_id = $1 AND status = '已完成'`,
    [SERVICE_ORDER_ID],
  )
  assert(serviceUpdate.rowCount === 1, '误录服务单未成功软取消')

  const commissionUpdate = await client.query(
    `UPDATE service_commissions
        SET is_void = true, voided_at = NOW(), voided_reason = $1, updated_at = NOW()
      WHERE id = $2 AND is_void = false AND commission_amount::numeric = $3::numeric`,
    [COMMISSION_VOID_REASON, SERVICE_COMMISSION_ID, COMMISSION_AMOUNT],
  )
  assert(commissionUpdate.rowCount === 1, '误录服务提成未成功作废')

  const refundNote = JSON.stringify({
    _v: 1,
    batchId: BATCH_ID,
    kind: 'conversion_cancel_reversal',
    reason: REASON,
    receiptReversals: [
      { saleItemId: CONVERSION_OUT_ITEM_ID, amount: REFUND_AMOUNT },
      { saleItemId: CONVERSION_IN_ITEM_ID, amount: -400 },
    ],
  })
  const refundInsert = await client.query(
    `INSERT INTO sale_order_payments (
       sale_order_id, change_type, payment_method, amount, status,
       paid_at, source_end, operator_employee_id, note, refund_reason,
       audit_employee_id, audit_at, audit_remark, created_at, allocation_status
     ) VALUES (
       $1, '退款', '储值卡', $2, '已支付',
       NOW(), 'admin', NULL, $3, $4,
       NULL, NOW(), $5, NOW(), NULL
     )
     RETURNING id`,
    [ORDER_ID, -REFUND_AMOUNT, refundNote, REASON, BATCH_ID],
  )
  assert(refundInsert.rowCount === 1, '储值卡退款款项流水未写入')
  const refundPaymentId = refundInsert.rows[0].id

  const receiptInsert = await client.query(
    `INSERT INTO sale_payment_item_receipts
       (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
     SELECT $1::bigint, $2::varchar, si.sale_item_id,
            CASE si.sale_item_id WHEN $3::varchar THEN $5::numeric ELSE $6::numeric END,
            si.sales_category, NOW()
       FROM sale_items si
      WHERE si.sale_order_id = $2::varchar AND si.sale_item_id IN ($3::varchar, $4::varchar)
     RETURNING sale_item_id, amount`,
    [refundPaymentId, ORDER_ID, CONVERSION_OUT_ITEM_ID, CONVERSION_IN_ITEM_ID, REFUND_AMOUNT, -400],
  )
  assert(receiptInsert.rowCount === 2, '转换单反向商品实收明细未完整写入')
  assert(cents(receiptInsert.rows.reduce((sum, row) => sum + number(row.amount), 0)) === -20000,
    '反向商品实收明细合计不是 -200 元')

  const cardUpdate = await client.query(
    `UPDATE prepaid_cards
        SET balance = balance + $1::numeric, updated_at = NOW()
      WHERE card_id = $2
      RETURNING balance`,
    [REFUND_AMOUNT, before.card.card_id],
  )
  assert(cardUpdate.rowCount === 1, '储值卡余额未成功退回')
  const cardTxnInsert = await client.query(
    `INSERT INTO card_transactions
       (card_id, type, amount, ref_order_id, external_ref, created_at)
     VALUES ($1, '充值', $2, $3, $4, NOW())
     ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [before.card.card_id, REFUND_AMOUNT, ORDER_ID, CARD_REFUND_EXTERNAL_REF],
  )
  assert(cardTxnInsert.rowCount === 1, '储值卡退款流水未成功写入或幂等键已存在')

  const sourceRestore = await client.query(
    `UPDATE sale_items
        SET remaining_sessions = 1, updated_at = NOW()
      WHERE sale_item_id = $1 AND session_count = 1 AND remaining_sessions = 0`,
    [SOURCE_ITEM_ID],
  )
  assert(sourceRestore.rowCount === 1, '原卡 1 次权益未成功恢复')

  const conversionVoid = await client.query(
    `UPDATE sale_items
        SET received = 0,
            prepaid_card_received = 0,
            remaining_sessions = CASE WHEN session_count IS NULL THEN remaining_sessions ELSE session_count END,
            paid_sessions = CASE WHEN session_count IS NULL THEN NULL ELSE 0 END,
            updated_at = NOW()
      WHERE sale_order_id = $1 AND item_direction IN ('转出', '转入')
      RETURNING sale_item_id`,
    [ORDER_ID],
  )
  assert(conversionVoid.rowCount === 2, '转换单权益行未完整归零')

  const orderUpdate = await client.query(
    `UPDATE sale_orders
        SET status = '已关闭',
            refunded_amount = $2::numeric,
            prepaid_card_amount = 0,
            pending_prepaid_card_amount = 0,
            payable_amount = total_amount,
            allocation_status = NULL,
            first_payment_amount = NULL,
            updated_at = NOW()
      WHERE sale_order_id = $1 AND status = '已支付'
      RETURNING sale_order_id`,
    [ORDER_ID, REFUND_AMOUNT],
  )
  assert(orderUpdate.rowCount === 1, '转换单未成功关闭')

  await client.query(
    `UPDATE sale_order_payments
        SET allocation_status = NULL
      WHERE sale_order_id = $1 AND allocation_status IS NOT NULL`,
    [ORDER_ID],
  )

  await client.query(
    `WITH visit_days AS (
       SELECT COUNT(DISTINCT service_date)::int AS days
         FROM service_orders
        WHERE client_user_id = $1
          AND status = '已完成'
          AND service_date >= date_trunc('month', CURRENT_DATE)::date
          AND service_date < (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date
     )
     UPDATE client_wechat_users u
        SET monthly_activity = CASE
              WHEN visit_days.days >= 2 THEN '二次客活'::monthly_activity
              WHEN visit_days.days = 1 THEN '一次客活'::monthly_activity
              WHEN u.customer_type = '会员客' THEN '0次客活'::monthly_activity
              ELSE NULL
            END,
            updated_at = NOW()
       FROM visit_days
      WHERE u.user_id = $1`,
    [CLIENT_USER_ID],
  )

  await client.query(
    `WITH spend AS (
       SELECT COALESCE(SUM(GREATEST(received::numeric - refunded_amount::numeric, 0)), 0) AS total
         FROM sale_orders
        WHERE client_user_id = $1
          AND status IN ('已支付', '已完成')
          AND sale_order_type IN ('销售单', '转换单')
     )
     UPDATE client_wechat_users
        SET spending_tier = CASE
              WHEN spend.total >= 100000 THEN '10W+'
              WHEN spend.total >= 60000 THEN '6-10W'
              WHEN spend.total >= 30000 THEN '3-6W'
              WHEN spend.total >= 10000 THEN '1-3W'
              WHEN spend.total >= 1990 THEN '1990-1W'
              ELSE '<1990'
            END::spending_tier,
            updated_at = NOW()
       FROM spend
      WHERE user_id = $1`,
    [CLIENT_USER_ID],
  )

  const beforeSummary = summarize(before)
  const auditRows = [
    {
      action: 'service.datafixCancelMistaken',
      targetType: 'service_order',
      targetId: SERVICE_ORDER_ID,
      detail: {
        batchId: BATCH_ID,
        reason: REASON,
        from: '已完成',
        to: '已取消',
        voidedCommissionId: SERVICE_COMMISSION_ID,
        voidedCommissionAmount: COMMISSION_AMOUNT,
      },
    },
    {
      action: 'order.datafixCancelMistakenConversion',
      targetType: 'sale_order',
      targetId: ORDER_ID,
      detail: {
        batchId: BATCH_ID,
        reason: REASON,
        from: '已支付',
        to: '已关闭',
        refundPaymentId,
        refundedPrepaidAmount: REFUND_AMOUNT,
        restoredSourceItemId: SOURCE_ITEM_ID,
        restoredSessions: 1,
      },
    },
    {
      action: 'datafix.cancelMistakenConversion',
      targetType: 'sale_order',
      targetId: ORDER_ID,
      detail: {
        batchId: BATCH_ID,
        reason: REASON,
        serviceOrderId: SERVICE_ORDER_ID,
        before: beforeSummary,
      },
    },
  ]
  for (const audit of auditRows) {
    await client.query(
      `INSERT INTO operation_logs
         (operator_employee_id, operator_name, operator_role, action,
          target_type, target_id, detail, source, created_at)
       VALUES (NULL, NULL, NULL, $1, $2, $3, $4::jsonb, 'maintenance', NOW())`,
      [audit.action, audit.targetType, audit.targetId, JSON.stringify(audit.detail)],
    )
  }

  return { refundPaymentId }
}

async function assertFinalState(client, beforeCardBalance) {
  const state = await loadState(client, false)
  assert(state.order?.status === '已关闭', '订单最终状态不是已关闭')
  assert(cents(state.order.received) === 20000, '订单毛实收最终不是 200 元')
  assert(cents(state.order.refunded_amount) === 20000, '订单已退款最终不是 200 元')
  assert(cents(state.order.prepaid_card_amount) === 0, '订单储值卡净额最终不是 0')
  assert(cents(state.order.payable_amount) === 20000, '关闭订单应付快照最终不是 200 元')
  assert(state.order.allocation_status == null, '订单分配状态未清空')
  assert(cents(state.paymentTotals.gross_received) === 20000, '最终正向款项合计不是 200 元')
  assert(cents(state.paymentTotals.refunded) === 20000, '最终退款款项合计不是 200 元')
  assert(cents(state.paymentTotals.net) === 0, '最终款项净额不是 0')
  assert(cents(state.paymentTotals.prepaid_net) === 0, '最终储值卡款项净额不是 0')
  assert(cents(state.receiptTotals.net) === 0, '最终商品实收明细净额不是 0')

  assert(number(state.sourceItem?.remaining_sessions) === 1, '原卡最终未恢复 1 次')
  assert(state.conversionItems.length === 2, '转换单明细最终行数异常')
  for (const row of state.conversionItems) {
    assert(cents(row.received) === 0 && cents(row.prepaid_card_received) === 0,
      `转换行 ${row.sale_item_id} 实收未归零`)
    assert(number(row.paid_sessions) === 0, `转换行 ${row.sale_item_id} 已支付次数未归零`)
    assert(number(row.remaining_sessions) === number(row.session_count),
      `转换行 ${row.sale_item_id} 剩余次数未回到总次数`)
  }

  assert(state.service?.status === '已取消', '误录服务单最终不是已取消')
  assert(state.service?.commission_status == null, '误录服务单提成状态未清空')
  assert(number(state.activeCommission.rows) === 0, '误录服务仍有活动提成')
  assert(cents(state.activeCommission.amount) === 0, '误录服务活动提成金额未归零')
  assert(cents(state.card.balance) === cents(beforeCardBalance) + 20000, '储值卡余额未增加 200 元')
  assert(cents(state.card.balance) === cents(state.cardLedger.total), '修复后储值卡余额与流水合计不一致')
  assert(state.customer?.monthly_activity === '一次客活', `月度客活应为一次客活，实际 ${state.customer?.monthly_activity}`)
  assert(state.customer?.spending_tier === '<1990', `消费档位应为 <1990，实际 ${state.customer?.spending_tier}`)
  assert(state.customer?.customer_type === '流量客', `客户类型应为流量客，实际 ${state.customer?.customer_type}`)

  const receiptPerItem = await client.query(
    `SELECT spir.sale_item_id, SUM(spir.amount::numeric)::numeric(12,2) AS net
       FROM sale_payment_item_receipts spir
       JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
      WHERE spir.sale_order_id = $1 AND sop.status = '已支付'
      GROUP BY spir.sale_item_id
      ORDER BY spir.sale_item_id`,
    [ORDER_ID],
  )
  assert(receiptPerItem.rowCount === 2, '最终商品实收分项数量异常')
  for (const row of receiptPerItem.rows) {
    assert(cents(row.net) === 0, `商品行 ${row.sale_item_id} 实收明细净额不是 0`)
  }

  const commission = await client.query(
    'SELECT is_void, voided_at, voided_reason FROM service_commissions WHERE id = $1',
    [SERVICE_COMMISSION_ID],
  )
  assert(commission.rowCount === 1 && commission.rows[0].is_void === true, '服务提成未软作废')
  assert(commission.rows[0].voided_at && commission.rows[0].voided_reason === COMMISSION_VOID_REASON,
    '服务提成作废审计字段不完整')

  const cardRefund = await client.query(
    'SELECT id, type, amount FROM card_transactions WHERE external_ref = $1',
    [CARD_REFUND_EXTERNAL_REF],
  )
  assert(cardRefund.rowCount === 1, '储值卡退款幂等流水缺失或重复')
  assert(cardRefund.rows[0].type === '充值' && cents(cardRefund.rows[0].amount) === 20000,
    '储值卡退款流水类型或金额异常')

  const audit = await client.query(
    `SELECT COUNT(*)::int AS count FROM operation_logs
      WHERE source = 'maintenance' AND detail->>'batchId' = $1`,
    [BATCH_ID],
  )
  assert(number(audit.rows[0]?.count) === 3, '修复审计日志不是 3 条')
  return state
}

async function verifyAlreadyApplied(client) {
  const state = await loadState(client, false)
  assert(state.order?.status === '已关闭', '已有修复审计但订单不是已关闭')
  assert(cents(state.order.refunded_amount) === 20000, '已有修复审计但订单退款不是 200 元')
  assert(state.service?.status === '已取消', '已有修复审计但服务单不是已取消')
  assert(number(state.sourceItem?.remaining_sessions) === 1, '已有修复审计但原卡未恢复 1 次')
  assert(cents(state.paymentTotals.net) === 0 && cents(state.receiptTotals.net) === 0,
    '已有修复审计但资金或商品实收净额不是 0')
  assert(cents(state.card.balance) === cents(state.cardLedger.total), '已有修复审计但储值卡账实不一致')
  log('检测到已完成修复，幂等退出', summarize(state))
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim()
  assert(databaseUrl, '必须显式设置 DATABASE_URL')
  if (APPLY) assert(CONFIRMED, `APPLY 缺少确认令牌 ${CONFIRM_TOKEN}`)
  if (!APPLY && CONFIRMED) fail('未传 --apply 时不得单独传生产确认令牌')

  log(`模式：${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  log(`目标：${maskedUrl(databaseUrl)}`)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  let finished = false
  try {
    await assertProductionTarget(client, databaseUrl)
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [BATCH_ID])

    if (await hasAppliedAudit(client)) {
      await verifyAlreadyApplied(client)
      await client.query('ROLLBACK')
      finished = true
      return
    }

    const before = await loadState(client, true)
    log('修复前快照', summarize(before))
    await assertInitialState(client, before)
    const result = await applyRepair(client, before)
    const after = await assertFinalState(client, before.card.balance)
    log('修复后快照', summarize(after))
    log(`新增退款款项流水：${result.refundPaymentId}`)

    if (APPLY) {
      await client.query('COMMIT')
      log('APPLY 已提交')
    } else {
      await client.query('ROLLBACK')
      log('DRY-RUN 断言全部通过，事务已回滚')
    }
    finished = true
  } finally {
    if (!finished) {
      try { await client.query('ROLLBACK') } catch { /* connection may already be closed */ }
    }
    await client.end()
  }
}

main().catch((error) => {
  console.error(`[CONVERSION-CANCEL-REPAIR] ${error.stack || error.message || error}`)
  process.exitCode = 1
})
