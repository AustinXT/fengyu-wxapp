#!/usr/bin/env node
'use strict'

/**
 * 撤回误录转换单：作废线下收款，恢复原卡；混合服务单只拆出本单项目。
 * DATABASE_URL 必须显式指向 prod。默认完整执行并 ROLLBACK。
 * --apply --confirm-order=FY-XSD-WX-2609110039 --expected-sha=<演练前快照 SHA256>
 * --verify：独立只读校验已提交结果。证据自动保存到 ~/backups/fengyu/ 下。
 * 不删除原始业务记录，不创建退款，不改变到店积分。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Client, types } = require('pg')
const { assertDbTargetOrExit, isProdDbTarget } = require('./_lib/assert-db-target')

// date 保留数据库日历日期，避免运行机器时区影响证据和归档单。
types.setTypeParser(1082, value => value)
const ORDER = 'FY-XSD-WX-2609110039'
const SOURCE_ORDER = 'FY-XSD-WX-2609100020'
const SOURCE_ITEM = 'XSLSH-WX-202609100101'
const USER = 'FYGK-20260909-00076'
const PAYMENT = '224757'
const BATCH = 'repair-cancel-conversion-order-2609110039'
const ACTION = 'datafix.cancelMistakenConversion'
const REASON = '误录转换单及线下收款；仅撤销本订单消费和提成，保留其他订单服务及实际到店积分'
const SERVICES = ['HLD-WX-2609130247', 'HLD-WX-2609230212', 'HLD-WX-2609270063']
const MOVES = [
  { item: 'si_mudu871s_afkjjmnv9', from: SERVICES[1], to: 'HLD-RV-2609230212-2609110039' },
  { item: 'si_muj947cp_9z2g1q6p1', from: SERVICES[2], to: 'HLD-RV-2609270063-2609110039' },
]
const SERVICE_ITEMS = [
  'si_mtzo9j0w_eun9n2cc4', 'si_mtzo9j1o_kjt1zqxhb', ...MOVES.map(m => m.item),
]
const COMMISSIONS = ['30233', '30234', '36243', '37822']
const ALL_SERVICES = [...SERVICES, ...MOVES.map(m => m.to)]
const cents = value => Math.round(Number(value) * 100)
const clone = value => JSON.parse(JSON.stringify(value))
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sorted = values => [...values].sort()
const by = (rows, key, value) => {
  const row = rows.find(r => String(r[key]) === value)
  assert(row, `缺少 ${key}=${value}`)
  return row
}
const targetItems = state => state.items.filter(r => r.sale_order_id === ORDER)
const targetServiceItems = state => state.serviceItems.filter(r =>
  targetItems(state).some(i => i.sale_item_id === r.sale_item_id))
const activeCommissions = state => state.commissions.filter(r =>
  SERVICE_ITEMS.includes(r.service_item_id) && !r.is_void)

async function rows(client, sql, params = []) {
  return (await client.query(sql, params)).rows
}

async function loadState(client) {
  const state = {}
  const definitions = {
    orders: ['SELECT * FROM sale_orders WHERE sale_order_id = ANY($1) ORDER BY sale_order_id', [[SOURCE_ORDER, ORDER]]],
    items: ['SELECT * FROM sale_items WHERE sale_order_id = ANY($1) ORDER BY sale_item_id', [[SOURCE_ORDER, ORDER]]],
    payments: ['SELECT * FROM sale_order_payments WHERE sale_order_id = ANY($1) ORDER BY id', [[SOURCE_ORDER, ORDER]]],
    receipts: ['SELECT * FROM sale_payment_item_receipts WHERE sale_order_id = ANY($1) ORDER BY id', [[SOURCE_ORDER, ORDER]]],
    allocatables: ['SELECT * FROM sale_payment_allocatable_items WHERE sale_order_id = ANY($1) ORDER BY id', [[SOURCE_ORDER, ORDER]]],
    saleAllocations: [`SELECT a.* FROM sale_allocations a JOIN sale_items i USING(sale_item_id)
      WHERE i.sale_order_id = ANY($1) ORDER BY a.id`, [[SOURCE_ORDER, ORDER]]],
    receiptAllocations: [`SELECT a.* FROM sale_payment_item_allocations a
      JOIN sale_payment_item_receipts r ON r.id = a.sale_payment_item_receipt_id
      WHERE r.sale_order_id = ANY($1) ORDER BY a.id`, [[SOURCE_ORDER, ORDER]]],
    services: ['SELECT * FROM service_orders WHERE service_order_id = ANY($1) ORDER BY service_order_id', [ALL_SERVICES]],
    serviceItems: [`SELECT * FROM service_items WHERE service_order_id = ANY($1)
      OR sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id = $2)
      OR sale_item_id = $3 ORDER BY service_item_id`, [ALL_SERVICES, ORDER, SOURCE_ITEM]],
    commissions: [`SELECT c.* FROM service_commissions c JOIN service_items s USING(service_item_id)
      WHERE s.service_order_id = ANY($1)
        OR s.sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id = $2)
        OR s.sale_item_id = $3 ORDER BY c.id`, [ALL_SERVICES, ORDER, SOURCE_ITEM]],
    downstream: [`SELECT * FROM sale_items WHERE ref_sale_item_id = $1
      OR ref_sale_item_id IN (SELECT sale_item_id FROM sale_items WHERE sale_order_id = $2)
      ORDER BY sale_item_id`, [SOURCE_ITEM, ORDER]],
    customer: ['SELECT * FROM client_wechat_users WHERE user_id = $1', [USER]],
    points: ['SELECT * FROM point_transactions WHERE user_id = $1 ORDER BY id', [USER]],
    pointBatches: ['SELECT * FROM point_batches WHERE user_id = $1 ORDER BY id', [USER]],
    cards: ['SELECT * FROM prepaid_cards WHERE user_id = $1 ORDER BY card_id', [USER]],
    cardTransactions: [`SELECT * FROM card_transactions WHERE ref_order_id = $1
      OR card_id IN (SELECT card_id FROM prepaid_cards WHERE user_id = $2) ORDER BY id`, [ORDER, USER]],
    reviews: ['SELECT * FROM service_reviews WHERE service_order_id = ANY($1) ORDER BY service_order_id', [ALL_SERVICES]],
    messages: ['SELECT * FROM messages WHERE ref_entity_id = ANY($1) ORDER BY id', [[ORDER, ...ALL_SERVICES]]],
    inventory: [`SELECT * FROM inventory_doc_items WHERE sale_item_id IN
      (SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1) ORDER BY id`, [ORDER]],
  }
  for (const [key, [sql, params]] of Object.entries(definitions)) state[key] = await rows(client, sql, params)
  return clone(state)
}

function assertInitial(state) {
  const order = by(state.orders, 'sale_order_id', ORDER)
  assert.equal(order.status, '已支付')
  assert.equal(order.sale_order_type, '转换单')
  assert.equal(order.client_user_id, USER)
  assert.equal(order.payment_method, '线下')
  for (const key of ['total_amount', 'payable_amount', 'received']) assert.equal(cents(order[key]), 425975, key)
  for (const key of ['refunded_amount', 'prepaid_card_amount', 'pending_prepaid_card_amount', 'points_used', 'points_discount']) {
    assert.equal(cents(order[key]), 0, key)
  }
  assert.equal(order.coupon_id, null)
  assert.equal(order.lakala_out_order_no, null)
  assert.equal(order.lakala_payment_intent, null)
  assert.equal(order.allocation_status, '待分配')
  const payments = state.payments.filter(r => r.sale_order_id === ORDER)
  assert.equal(payments.length, 1)
  assert.equal(String(payments[0].id), PAYMENT)
  assert.equal(payments[0].status, '已支付')
  assert.equal(payments[0].change_type, '首次支付')
  assert.equal(payments[0].payment_method, '线下')
  assert.equal(cents(payments[0].amount), 425975)

  const items = targetItems(state)
  assert.deepEqual(items.map(i => i.sale_item_id),
    ['0224', '0225', '0226', '0227', '0228', '0229'].map(n => `XSLSH-WX-20260911${n}`))
  const expected = [[1, null, -13825], [2, 0, 100000], [2, 1, 100000], [2, 2, 100000], [2, 2, 100000], [1, 0, 39800]]
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    assert.equal(item.item_direction, i === 0 ? '转出' : '转入')
    assert.equal(item.ref_sale_item_id, i === 0 ? SOURCE_ITEM : null)
    assert.equal(item.product_type, '疗程卡')
    assert.equal(item.session_count, expected[i][0])
    assert.equal(item.remaining_sessions, expected[i][1])
    assert.equal(item.paid_sessions, item.session_count)
    assert.equal(cents(item.received), expected[i][2])
    assert.equal(cents(item.sale_amount), expected[i][2])
    for (const key of ['prepaid_card_received', 'pending_received', 'waived_amount']) assert.equal(cents(item[key]), 0)
  }
  const source = by(state.items, 'sale_item_id', SOURCE_ITEM)
  assert.equal(source.session_count, 1)
  assert.equal(source.remaining_sessions, 0)
  assert.equal(source.paid_sessions, 1)
  assert.equal(cents(source.received), 13825)
  assert.equal(cents(source.waived_amount), 0)
  assert.deepEqual(state.downstream.map(i => i.sale_item_id), [items[0].sale_item_id])
  assert.equal(state.services.length, 3, '归档单已存在或原服务单缺失')
  for (const service of state.services) {
    assert.equal(service.status, '已完成')
    assert.equal(service.commission_status, '已分配')
    assert.equal(service.client_user_id, USER)
    assert.equal(service.appointment_id, null)
  }
  assert.deepEqual(sorted(targetServiceItems(state).map(i => i.service_item_id)), sorted(SERVICE_ITEMS))
  assert.equal(state.serviceItems.length, 6)
  for (const item of state.serviceItems) {
    assert.equal(item.session_used, 1)
    assert.equal(item.reserved_at, null)
  }
  for (const move of MOVES) assert.equal(by(state.serviceItems, 'service_item_id', move.item).service_order_id, move.from)
  assert.deepEqual(sorted(state.serviceItems.filter(i => !SERVICE_ITEMS.includes(i.service_item_id)).map(i => i.service_item_id)),
    sorted(['si_mudu872f_0560k8z7g', 'si_muj947by_6ldclpg2t']))
  assert.deepEqual(sorted(activeCommissions(state).map(c => String(c.id))), sorted(COMMISSIONS))
  assert.equal(activeCommissions(state).reduce((sum, c) => sum + cents(c.commission_amount), 0), 28470)
  assert.equal(state.reviews.length, 0)
  assert.equal(state.inventory.length, 0)
  assert.equal(state.points.filter(p => p.ref_order_id === ORDER).length, 0)
  assert.equal(state.pointBatches.filter(p => p.ref_order_id === ORDER).length, 0)
  assert.equal(state.cardTransactions.filter(t => t.ref_order_id === ORDER).length, 0)
  const targetIds = items.map(i => i.sale_item_id)
  assert.equal(state.saleAllocations.filter(a => targetIds.includes(a.sale_item_id) && !a.is_void).length, 0)
  const receiptIds = state.receipts.filter(r => r.sale_order_id === ORDER).map(r => String(r.id))
  assert.equal(receiptIds.length, 6)
  assert.equal(state.receiptAllocations.filter(a => receiptIds.includes(String(a.sale_payment_item_receipt_id)) && !a.is_void).length, 0)
  assert.equal(state.receipts.filter(r => r.sale_order_id === ORDER).reduce((n, r) => n + cents(r.amount), 0), 425975)
  for (const date of ['2026-09-13', '2026-09-23', '2026-09-27']) {
    const point = by(state.points, 'external_ref', `visit-points:${USER}:${date}`)
    assert.equal(Number(point.amount), 20)
  }
}

async function lockRecords(client) {
  // 原单与转换单一起按 ID 排序，订单先于款项；服务头先于其明细和提成。
  await client.query('SELECT sale_order_id FROM sale_orders WHERE sale_order_id = ANY($1) ORDER BY sale_order_id FOR NO KEY UPDATE', [[SOURCE_ORDER, ORDER]])
  await client.query('SELECT service_order_id FROM service_orders WHERE service_order_id = ANY($1) ORDER BY service_order_id FOR UPDATE', [SERVICES])
  await client.query('SELECT sale_item_id FROM sale_items WHERE sale_order_id = ANY($1) ORDER BY sale_item_id FOR UPDATE', [[SOURCE_ORDER, ORDER]])
  await client.query('SELECT service_item_id FROM service_items WHERE service_order_id = ANY($1) ORDER BY service_item_id FOR UPDATE', [ALL_SERVICES])
  await client.query(`SELECT id FROM service_commissions WHERE service_item_id IN
    (SELECT service_item_id FROM service_items WHERE service_order_id = ANY($1)) ORDER BY id FOR UPDATE`, [ALL_SERVICES])
  await client.query('SELECT id FROM sale_order_payments WHERE sale_order_id = ANY($1) ORDER BY id FOR UPDATE', [[SOURCE_ORDER, ORDER]])
  await client.query('SELECT user_id FROM client_wechat_users WHERE user_id = $1 FOR UPDATE', [USER])
}

async function mutate(client) {
  async function update(sql, params, count) {
    const result = await client.query(sql, params)
    assert.equal(result.rowCount, count, '写入行数不符合预期，事务回滚')
  }
  for (const move of MOVES) {
    await update(`INSERT INTO service_orders (
      service_order_id, status, service_order_type, market_name, store_id, service_date,
      assigned_employee_id, remark, appointment_id, client_user_id, started_at,
      staff_completed_at, completed_at, commission_status, created_at, updated_at)
      SELECT $2, '已取消', service_order_type, market_name, store_id, service_date,
        assigned_employee_id, $3, NULL, client_user_id, started_at, staff_completed_at,
        completed_at, NULL, created_at, NOW()
      FROM service_orders WHERE service_order_id = $1 AND status = '已完成'`,
    [move.from, move.to, `${BATCH}：原服务单 ${move.from} 中 ${ORDER} 的误录项目撤回归档；${REASON}`], 1)
    await update(`UPDATE service_items SET service_order_id = $2, updated_at = NOW()
      WHERE service_item_id = $1 AND service_order_id = $3`, [move.item, move.to, move.from], 1)
  }
  await update(`UPDATE service_orders SET status = '已取消', commission_status = NULL,
    remark = concat_ws(E'\n', NULLIF(remark, ''), $2::text), updated_at = NOW()
    WHERE service_order_id = $1 AND status = '已完成'`, [SERVICES[0], `${BATCH}：${REASON}`], 1)
  await update(`UPDATE service_commissions SET is_void = true, voided_at = NOW(),
    voided_reason = $2, updated_at = NOW() WHERE id = ANY($1::bigint[]) AND is_void = false`,
  [COMMISSIONS, `${BATCH}：误录服务提成作废`], 4)
  await update(`UPDATE sale_order_payments SET status = '已作废', allocation_status = NULL
    WHERE id = $1 AND sale_order_id = $2 AND status = '已支付' AND amount = 4259.75`, [PAYMENT, ORDER], 1)
  await update(`UPDATE sale_items SET remaining_sessions = remaining_sessions + 1, updated_at = NOW()
    WHERE sale_item_id = $1 AND session_count = 1 AND remaining_sessions = 0`, [SOURCE_ITEM], 1)
  // 与关闭转换单的既有口径一致：剩余数恢复总次数，已付次数归零；关闭状态阻止再次消费。
  await update(`UPDATE sale_items SET received = 0, prepaid_card_received = 0,
    pending_received = 0, paid_sessions = 0,
    remaining_sessions = CASE WHEN remaining_sessions IS NULL THEN NULL ELSE session_count END,
    updated_at = NOW() WHERE sale_order_id = $1`, [ORDER], 6)
  await update(`UPDATE sale_orders SET status = '已关闭', received = 0, refunded_amount = 0,
    prepaid_card_amount = 0, pending_prepaid_card_amount = 0, payable_amount = total_amount,
    first_payment_amount = NULL, paid_at = NULL, offline_confirmed_by = NULL,
    offline_confirmed_at = NULL, allocation_status = NULL,
    remark = concat_ws(E'\n', NULLIF(remark, ''), $2::text), updated_at = NOW()
    WHERE sale_order_id = $1 AND status = '已支付'`, [ORDER, `${BATCH}：${REASON}`], 1)
}

function assertFinal(before, after) {
  // 逐字段核对整个关联快照，除明确白名单外所有行（含其他订单/积分）必须不变。
  const expected = clone(before)
  function replace(collection, key, id, changes, timestamp = true) {
    const record = by(expected[collection], key, id)
    Object.assign(record, changes)
    if (timestamp) record.updated_at = by(after[collection], key, id).updated_at
  }
  const order = by(after.orders, 'sale_order_id', ORDER)
  assert(order.remark.includes(BATCH))
  replace('orders', 'sale_order_id', ORDER, {
    status: '已关闭', received: '0.00', refunded_amount: '0.00', prepaid_card_amount: '0.00',
    pending_prepaid_card_amount: '0.00', payable_amount: '4259.75', first_payment_amount: null,
    paid_at: null, offline_confirmed_by: null, offline_confirmed_at: null, allocation_status: null, remark: order.remark,
  })
  replace('payments', 'id', PAYMENT, { status: '已作废', allocation_status: null }, false)
  replace('items', 'sale_item_id', SOURCE_ITEM, { remaining_sessions: 1 })
  for (const item of targetItems(before)) {
    replace('items', 'sale_item_id', item.sale_item_id, {
      received: '0.00', cash_received: '0.00', prepaid_card_received: '0.00', pending_received: '0.00',
      paid_sessions: 0, remaining_sessions: item.remaining_sessions == null ? null : item.session_count,
    })
  }
  expected.downstream = expected.downstream.map(i => clone(by(expected.items, 'sale_item_id', i.sale_item_id)))
  const cancelled = by(after.services, 'service_order_id', SERVICES[0])
  assert(cancelled.remark.includes(BATCH))
  replace('services', 'service_order_id', SERVICES[0], { status: '已取消', commission_status: null, remark: cancelled.remark })
  for (const move of MOVES) {
    replace('serviceItems', 'service_item_id', move.item, { service_order_id: move.to })
    const archive = by(after.services, 'service_order_id', move.to)
    assert(archive.remark.includes(BATCH) && archive.remark.includes(move.from))
    expected.services.push({ ...clone(by(before.services, 'service_order_id', move.from)),
      service_order_id: move.to, status: '已取消', commission_status: null,
      remark: archive.remark, updated_at: archive.updated_at })
  }
  expected.services.sort((a, b) => a.service_order_id.localeCompare(b.service_order_id))
  for (const id of COMMISSIONS) {
    const actual = by(after.commissions, 'id', id)
    assert(actual.voided_at)
    replace('commissions', 'id', id, { is_void: true, voided_at: actual.voided_at, voided_reason: `${BATCH}：误录服务提成作废` })
  }
  assert.deepEqual(after, expected, '前后快照存在未授权变化或遗漏')
  assert.equal(activeCommissions(after).length, 0)
  assert.equal(targetServiceItems(after).filter(i => by(after.services, 'service_order_id', i.service_order_id).status !== '已取消').length, 0)
}

function summary(state) {
  const order = by(state.orders, 'sale_order_id', ORDER)
  return {
    order: ORDER, status: order.status, received: order.received,
    paymentStatus: by(state.payments, 'id', PAYMENT).status,
    sourceRemaining: by(state.items, 'sale_item_id', SOURCE_ITEM).remaining_sessions,
    activeServiceItems: targetServiceItems(state).filter(i => by(state.services, 'service_order_id', i.service_order_id).status === '已完成').length,
    activeCommissionCents: activeCommissions(state).reduce((n, c) => n + cents(c.commission_amount), 0),
    pointsBalance: state.customer[0].points_balance,
    retainedMixedServices: state.services.filter(s => SERVICES.slice(1).includes(s.service_order_id)).map(s => ({ id: s.service_order_id, status: s.status })),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const verify = args.includes('--verify')
  assert(!(apply && verify), '--apply 与 --verify 不可同时使用')
  for (const arg of args) assert(/^(--apply|--verify|--confirm-order=.+|--expected-sha=[a-f0-9]{64})$/.test(arg), `未知参数 ${arg}`)
  const url = assertDbTargetOrExit(process.env.DATABASE_URL)
  assert(isProdDbTarget(url), '本次修复仅允许 prod')
  const expectedSha = args.find(a => a.startsWith('--expected-sha='))?.slice('--expected-sha='.length)
  if (apply) {
    assert(args.includes(`--confirm-order=${ORDER}`), '缺少限定订单确认参数')
    assert(expectedSha, '必须提供通过演练的前置快照 SHA256')
  }
  const dir = path.join(os.homedir(), 'backups', 'fengyu', BATCH,
    `${verify ? 'verify' : apply ? 'apply' : 'dry-run'}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 8000, application_name: BATCH })
  let committed = false
  await client.connect()
  try {
    await client.query(verify ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL SERIALIZABLE')
    await client.query("SET LOCAL lock_timeout = '3s'")
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    const [db] = await rows(client, 'SELECT current_database() AS name, inet_server_port() AS port')
    assert.equal(db.name, 'fengyu_wxapp')
    assert.equal(db.port, 5433)
    if (!verify) {
      const [lock] = await rows(client, 'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [BATCH])
      assert(lock.ok, '同一修复批次正在执行')
      await lockRecords(client)
    }
    const audits = await rows(client, `SELECT * FROM operation_logs WHERE source = 'maintenance'
      AND action = $1 AND target_id = $2 AND detail->>'batchId' = $3 ORDER BY id`, [ACTION, ORDER, BATCH])
    const before = await loadState(client)
    if (audits.length || verify) {
      assert.equal(audits.length, 1, '已提交修复审计必须恰好一条')
      const audit = audits[0]
      // 幂等重跑只核对，不再次恢复权益。完整快照验证用于此次提交后的即时复核。
      assert.equal(hash(before), audit.detail.afterSha, '现状与已提交快照不一致，需检查后续业务变化')
      write('verified.json', { summary: summary(before), auditId: audit.id, snapshotSha: hash(before) })
      await client.query('ROLLBACK')
      console.log(JSON.stringify({ mode: verify ? 'VERIFIED' : 'ALREADY_APPLIED', ...summary(before), evidence: dir }))
      return
    }
    assertInitial(before)
    const beforeSha = hash(before)
    if (apply) assert.equal(beforeSha, expectedSha, '生产数据较演练发生变化，停止提交')
    write('before.json', before)
    write('manifest.json', { batchId: BATCH, order: ORDER, mode: apply ? 'apply' : 'dry-run', beforeSha, reason: REASON, moves: MOVES })
    await mutate(client)
    const after = await loadState(client)
    assertFinal(before, after)
    const afterSha = hash(after)
    const detail = { batchId: BATCH, reason: REASON, beforeSha, afterSha, before: summary(before), after: summary(after),
      paymentId: PAYMENT, restoredSourceItem: SOURCE_ITEM, restoredSessions: 1, serviceMoves: MOVES,
      voidedCommissionIds: COMMISSIONS, voidedCommissionAmount: '284.70', retainedVisitPoints: true, evidence: dir }
    const auditResult = await client.query(`INSERT INTO operation_logs
      (operator_employee_id, operator_name, operator_role, action, target_type, target_id, detail, source, created_at)
      VALUES (NULL, NULL, NULL, $1, 'sale_order', $2, $3::jsonb, 'maintenance', NOW()) RETURNING id`, [ACTION, ORDER, JSON.stringify(detail)])
    assert.equal(auditResult.rowCount, 1)
    write('after.json', after)
    await client.query(apply ? 'COMMIT' : 'ROLLBACK')
    committed = apply
    write('result.json', { ...detail, result: apply ? 'COMMITTED' : 'ROLLED_BACK', auditId: auditResult.rows[0].id })
    console.log(JSON.stringify({ mode: apply ? 'COMMITTED' : 'DRY_RUN_ROLLED_BACK', beforeSha, afterSha, ...summary(after), evidence: dir }))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(committed ? '事务已提交，但后续证据写入失败；请只读复核' : '事务未提交或连接结果待核验；请检查审计后重试')
    throw error
  } finally {
    await client.end()
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { assertInitial, assertFinal, hash }
