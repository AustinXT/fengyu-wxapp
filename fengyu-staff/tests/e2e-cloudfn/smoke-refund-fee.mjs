#!/usr/bin/env bun
// #529 专用 PostgreSQL 回归；拒绝业务库，所有夹具只在本地私有库运行。
import './setup.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { REPO_ROOT, NS, TEST_MANAGER_OPENID, TEST_MANAGER_EMP_ID, TEST_CLIENT_USER_ID, pgQuery, closePool, getPool } from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import { ensureTestStore, createTestStaff, createTestClient, createTestSaleOrder, createTestSaleItem, createPaidPayment, cleanupTestData } from './helpers/fixtures.mjs'
const require = createRequire(import.meta.url)
const { recalcPaidSessionsForOrder } = require(`${REPO_ROOT}/fengyu-staff/cloudfunctions/staffApi/utils/paid-sessions.js`)
const { settlePointsForOrder } = require(`${REPO_ROOT}/fengyu-staff/cloudfunctions/staffApi/utils/points.js`)
const { retainedRefundFeeSql } = require(`${REPO_ROOT}/fengyu-staff/cloudfunctions/staffApi/utils/refund-fee-sql.js`)
const url = new URL(process.env.PG_CONNECTION_STRING)
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '5433') throw Error('本回归仅允许专用本地 PostgreSQL')
async function invoke(action, payload) {
  const res = await invokeStaffApi(action, { ...payload, _testOpenid: TEST_MANAGER_OPENID })
  assert.equal(res.code, 0, `${action}: ${res.message}`)
  return res.data
}
async function seed(id, { total = 1000, sessions = 10, consumed = 0, legacy = false, unit = 100 } = {}) {
  await createTestSaleOrder({ saleOrderId: id, clientUserId: TEST_CLIENT_USER_ID, totalAmount: total,
    sessionCount: sessions, productType: '疗程卡', status: '已支付', salesCategory: '他销自耗' })
  const item = `${id}_ITEM_1`
  await pgQuery('UPDATE sale_orders SET received=$2 WHERE sale_order_id=$1', [id, total])
  await pgQuery('UPDATE sale_items SET received=$2, sale_amount=$2, pending_received=$2, paid_sessions=$3, remaining_sessions=$4, unit_real_price=$5 WHERE sale_item_id=$1',
    [item, total, sessions, sessions - consumed, unit])
  const payment = await createPaidPayment(id, { amount: total, items: legacy ? [] : [{ saleItemId: item, amount: total }] })
  return { item, payment }
}
async function approve(id, items, fee) {
  const res = await invoke('order.createRefund', { refSaleOrderId: id, items, handlingFee: fee, refundReason: '#529隔离回归' })
  const pending = (await pgQuery("SELECT id FROM sale_order_payments WHERE sale_order_id=$1 AND change_type='退款' AND status='待审批'", [id]))[0]
  assert.ok(pending)
  await invoke('order.approveRefund', { paymentId: Number(pending.id) })
  return Number(pending.id)
}
async function money(id) {
  return (await pgQuery('SELECT so.refunded_amount, so.status, si.received, si.paid_sessions FROM sale_orders so JOIN sale_items si ON si.sale_order_id=so.sale_order_id WHERE so.sale_order_id=$1 ORDER BY si.sale_item_id', [id]))
}
try {
  await cleanupTestData(NS); await ensureTestStore(); await createTestStaff(); await createTestClient()
  // 同真实截图：无受领的单商品历史收款，7 次已耗尽，余数214、手续费100。
  const legacy = `${NS}_F529_LEG`
  const { item: legacyItem } = await seed(legacy, { total: 3000, sessions: 7, consumed: 7, legacy: true, unit: 398 })
  assert.equal((await pgQuery('SELECT count(*) AS n FROM sale_payment_item_receipts WHERE sale_order_id=$1', [legacy]))[0].n, '0')
  const paymentId = await approve(legacy, [{ saleItemId: legacyItem, refundQuantity: 0, includeOverpay: true }], 100)
  let rows = await money(legacy)
  assert.equal(Number(rows[0].received), 2886); assert.equal(Number(rows[0].refunded_amount), 114)
  assert.equal(rows[0].paid_sessions, 7); assert.equal(rows[0].status, '已支付')
  const note = JSON.parse((await pgQuery('SELECT note FROM sale_order_payments WHERE id=$1', [paymentId]))[0].note)
  assert.equal(note.items[0].handlingFee, 100); assert.equal(note.items[0].netRefundAmount, 114)
  assert.equal(Number((await pgQuery('SELECT SUM(amount) AS n FROM sale_payment_item_receipts WHERE sale_payment_id=$1', [paymentId]))[0].n), -114)
  const retry = await invokeStaffApi('order.approveRefund', { paymentId, _testOpenid: TEST_MANAGER_OPENID })
  assert.notEqual(retry.code, 0)
  const again = await invokeStaffApi('order.createRefund', { refSaleOrderId: legacy, items: [{ saleItemId: legacyItem, refundQuantity: 0, includeOverpay: true }], handlingFee: 0, refundReason: '重复', _testOpenid: TEST_MANAGER_OPENID })
  assert.notEqual(again.code, 0) // 手续费不能作为多收余数再退走
  const client = await getPool().connect()
  try { await client.query('BEGIN'); await recalcPaidSessionsForOrder(client, legacy); await settlePointsForOrder(client, legacy); await client.query('COMMIT') }
  finally { client.release() }
  rows = await money(legacy); assert.equal(rows[0].paid_sessions, 7); assert.equal(Number(rows[0].received), 2886)
  const zero = `${NS}_F529_ZERO`
  const { item: zeroItem } = await seed(zero, { total: 3000, sessions: 7, consumed: 7, legacy: true, unit: 398 })
  await approve(zero, [{ saleItemId: zeroItem, refundQuantity: 0, includeOverpay: true }], 0)
  const z = (await money(zero))[0]; assert.equal(Number(z.received), 2786); assert.equal(z.paid_sessions, 7)
  // 全退手续费保留收入，员工角色池/销售提成净额归零，权益不随回款重算恢复。
  const full = `${NS}_F529_FULL`; const { item } = await seed(full)
  const receipt = (await pgQuery('SELECT id FROM sale_payment_item_receipts WHERE sale_item_id=$1', [item]))[0]
  await pgQuery(`INSERT INTO sale_payment_item_allocations (sale_payment_item_receipt_id,employee_id,role_type,allocation_ratio,allocated_amount,commission_rate,commission_amount) VALUES ($1,$2,'美容师',1,1000,0.06,60)`, [receipt.id, TEST_MANAGER_EMP_ID])
  await approve(full, [{ saleItemId: item }], 50)
  const f = (await money(full))[0]; assert.equal(Number(f.received), 50); assert.equal(f.paid_sessions, 0); assert.equal(f.status, '已退款')
  const allocation = (await pgQuery('SELECT SUM(a.allocated_amount) AS amt, SUM(a.commission_amount) AS comm FROM sale_payment_item_allocations a JOIN sale_payment_item_receipts r ON r.id=a.sale_payment_item_receipt_id WHERE r.sale_item_id=$1 AND NOT a.is_void', [item]))[0]
  assert.equal(Number(allocation.amt), 0); assert.equal(Number(allocation.comm), 0)
  const pointsClient = await getPool().connect()
  try { await pointsClient.query('BEGIN'); const points = await settlePointsForOrder(pointsClient, full); assert.equal(points.expected, 0); await recalcPaidSessionsForOrder(pointsClient, full); await pointsClient.query('COMMIT') }
  finally { pointsClient.release() }
  assert.equal((await money(full))[0].paid_sessions, 0)
  assert.equal(Number((await pgQuery(`SELECT SUM(GREATEST(so.received-so.refunded_amount-${retainedRefundFeeSql('so.sale_order_id')},0)) AS n FROM sale_orders so WHERE so.sale_order_id=$1`, [full]))[0].n), 0)
  // 两项实付不同而退款毛额相等：按实付3:1分摊，不按退款额1:1。
  const multi = `${NS}_F529_MIX`; const { item: a } = await seed(multi, { total: 300, sessions: 3, consumed: 2, unit: 100 })
  const b = `${multi}_ITEM_2`
  await createTestSaleItem({ saleOrderId: multi, saleItemId: b, productType: '疗程卡', unitPrice: 100, quantity: 1, sessionCount: 1, salesCategory: '他销自耗' })
  await pgQuery('UPDATE sale_orders SET total_amount=400, received=400 WHERE sale_order_id=$1', [multi])
  await pgQuery('UPDATE sale_items SET received=100, paid_sessions=1, remaining_sessions=1, pending_received=100 WHERE sale_item_id=$1', [b])
  await createPaidPayment(multi, { changeType: '回款', amount: 100, items: [{ saleItemId: b, amount: 100 }] })
  await pgQuery("UPDATE sale_items SET product_kind_at_sale='拓客引流卡' WHERE sale_item_id=$1", [b])
  const mId = await approve(multi, [{ saleItemId: a }, { saleItemId: b }], 20)
  const m = JSON.parse((await pgQuery('SELECT note FROM sale_order_payments WHERE id=$1', [mId]))[0].note)
  assert.deepEqual(m.items.map(it => it.handlingFee), [15, 5])
  assert.equal(Number((await pgQuery('SELECT SUM(amount) AS n FROM sale_payment_item_receipts WHERE sale_payment_id=$1', [mId]))[0].n), -180)
  assert.equal(Number((await pgQuery('SELECT SUM(performance_amount) AS n FROM sale_reportable_item_events WHERE sale_order_id=$1', [multi]))[0].n), 215) // 普通项200已消费+手续费15；拓客项手续费5不计业绩
  // 家居分两次退完：历史手续费不能污染角色池覆盖率，也不能留下员工收益。
  const home = `${NS}_F529_HOME`
  await createTestSaleOrder({ saleOrderId: home, clientUserId: TEST_CLIENT_USER_ID, productType: '家居产品', quantity: 4, totalAmount: 400, status: '已支付', salesCategory: '他销自耗' })
  const hi = `${home}_ITEM_1`
  await pgQuery('UPDATE sale_orders SET received=400 WHERE sale_order_id=$1', [home])
  await pgQuery('UPDATE sale_items SET received=400,pending_received=400,unit_real_price=100,sale_amount=400 WHERE sale_item_id=$1', [hi])
  await createPaidPayment(home, { amount: 400, items: [{ saleItemId: hi, amount: 400 }] })
  const hr = (await pgQuery('SELECT id FROM sale_payment_item_receipts WHERE sale_item_id=$1', [hi]))[0]
  await pgQuery("INSERT INTO sale_payment_item_allocations (sale_payment_item_receipt_id,employee_id,role_type,allocation_ratio,allocated_amount,commission_rate,commission_amount) VALUES ($1,$2,'美容师',1,400,0.06,24)", [hr.id, TEST_MANAGER_EMP_ID])
  await approve(home, [{ saleItemId: hi, refundQuantity: 1 }], 10)
  await approve(home, [{ saleItemId: hi, refundQuantity: 3 }], 20)
  const hs = (await money(home))[0]; assert.equal(Number(hs.received), 30); assert.equal(hs.status, '已退款')
  assert.equal((await pgQuery('SELECT refunded_quantity FROM sale_items WHERE sale_item_id=$1', [hi]))[0].refunded_quantity, 4)
  const ha = (await pgQuery('SELECT SUM(a.allocated_amount) AS amt, SUM(a.commission_amount) AS comm FROM sale_payment_item_allocations a JOIN sale_payment_item_receipts r ON r.id=a.sale_payment_item_receipt_id WHERE r.sale_item_id=$1 AND NOT a.is_void', [hi]))[0]
  assert.equal(Number(ha.amt), 0); assert.equal(Number(ha.comm), 0)
  // 积分临界值：190实收、毛退91（手续费41/净退50），可计消费99，不能残留1积分。
  const threshold = `${NS}_F529_POINT`
  const { item: thresholdItem } = await seed(threshold, { total: 190, sessions: 1, consumed: 1, unit: 99 })
  const pointTx = await getPool().connect()
  try { await pointTx.query('BEGIN'); const before = await settlePointsForOrder(pointTx, threshold); assert.equal(before.expected, 1); await pointTx.query('COMMIT') }
  finally { pointTx.release() }
  await approve(threshold, [{ saleItemId: thresholdItem, refundQuantity: 0, includeOverpay: true }], 41)
  assert.equal(Number((await pgQuery("SELECT SUM(amount) AS n FROM point_transactions WHERE ref_order_id=$1 AND type IN ('消费赠送','消费冲销')", [threshold]))[0].n), 0)
  // 真实缺口：已有不完整受领不可偷偷补齐，也不能留下审批/冲销残留。
  const broken = `${NS}_F529_BAD`; const { item: bad } = await seed(broken)
  await pgQuery('UPDATE sale_payment_item_receipts SET amount=10 WHERE sale_item_id=$1', [bad])
  await invoke('order.createRefund', { refSaleOrderId: broken, items: [{ saleItemId: bad }], handlingFee: 50, refundReason: '缺口' })
  const bp = (await pgQuery("SELECT id FROM sale_order_payments WHERE sale_order_id=$1 AND change_type='退款'", [broken]))[0]
  const denied = await invokeStaffApi('order.approveRefund', { paymentId: Number(bp.id), _testOpenid: TEST_MANAGER_OPENID })
  assert.notEqual(denied.code, 0)
  assert.equal((await pgQuery('SELECT status FROM sale_order_payments WHERE id=$1', [bp.id]))[0].status, '待审批')
  assert.equal(Number((await money(broken))[0].refunded_amount), 0)
  console.log('PASS #529: 历史余数、手续费净额、禁止再退、次数幂等、员工归零、积分/档位排除、实付分摊、真实缺口回滚')
} finally { await cleanupTestData(NS); await closePool() }
