#!/usr/bin/env bun
/**
 * 退款级联（cascadeRefund）真路径守护 — 经真实 createRefund → approveRefund 验证 5 通道粒度：
 *
 *   Q 多明细退真子集（Bug Q，原无 snapshot/e2e 守护，回归会静默）：
 *     2 明细单(A 卡 1000/10 + B 卡 800/8，均 0 消费已付)，**只退 A** →
 *     A 的 sale_allocations 负数冲销(净额=0)，**B 的 sale_allocations 不被冲**（不误清未退明细）。
 *
 *   M 退剩余次数保护已挣提成（Bug M 强化 2026-06-08，本轮修复核心）：
 *     1 卡 1000/10、已消费 3 次（remaining=7，3 条 service_commissions）、1 条 alloc，
 *     退光剩余 7 次 → isFullItemRefund=false（consumed>0）→
 *     **service_commissions 全部不作废 + sale_allocations 不作废**（员工已做的 3 次服务提成被保护）。
 *
 *   C3 通道3 券回滚（整单全退）：已用券随整单退款恢复为 '未使用'。
 *   C4 通道4 积分消费冲销：退款写 '消费冲销' 负流水 + points_balance 重算。
 *   C5 通道5 家居提货：家居退未提货数量不应误改 picked_up_quantity（session_count 为空，通道5 跳过）。
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
  createTestSaleOrder, createTestSaleItem, createTestServiceOrder,
  createTestCoupon, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
const rec = (l) => console.log(l)

/** 建一张已支付销售单（疗程卡）+ 行级 received/paid_sessions + 首次支付流水（已支付） */
async function makePaidCardOrder(saleOrderId, { total, sessionCount }) {
  await createTestSaleOrder({
    saleOrderId, clientUserId: TEST_CLIENT_USER_ID,
    saleOrderType: '销售单', productName: `${NS}_疗程卡`, productType: '疗程卡',
    quantity: 1, sessionCount, totalAmount: total, status: '已支付', salesCategory: '他销自耗',
  })
  await pgQuery(`UPDATE sale_orders SET received = $2 WHERE sale_order_id = $1`, [saleOrderId, total])
  await pgQuery(`UPDATE sale_items SET received = $2, paid_sessions = $3 WHERE sale_order_id = $1`, [saleOrderId, total, sessionCount])
  await pgQuery(
    `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at)
     VALUES ($1, '首次支付', $2, '线下', '已支付', 'staff', NOW())`,
    [saleOrderId, total]
  )
  return { saleItemId: `${saleOrderId}_ITEM_1` }
}

async function addAllocation(saleItemId, amount) {
  await pgQuery(
    `INSERT INTO sale_allocations (sale_item_id, employee_id, role_type, allocation_ratio, total_amount, commission_rate, commission_amount, is_void)
     VALUES ($1, $2, '美容师', 1.00, $3, 0.06, $4, false)`,
    [saleItemId, TEST_MANAGER_EMP_ID, amount, Math.round(amount * 0.06)]
  )
}

async function main() {
  rec(`[smoke-refund-cascade-channels] start | ${new Date().toISOString()}`)
  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff() // manager
  await createTestClient()
  const errors = []

  // ───────────────────────────────────────────────────────────────────────
  // Q：多明细退真子集 — 只退 A，B 的分配不被误清（Bug Q 守护）
  // ───────────────────────────────────────────────────────────────────────
  const orderQ = `${NS}_RFCH_Q`
  const { saleItemId: qA } = await makePaidCardOrder(orderQ, { total: 1000, sessionCount: 10 })
  const qB = `${orderQ}_ITEM_2`
  await createTestSaleItem({ saleOrderId: orderQ, saleItemId: qB, productType: '疗程卡', quantity: 1, unitPrice: 100, sessionCount: 8, salesCategory: '他销自耗' })
  // 订单升级为 2 明细：total/received=1800，B 行 received=800 / paid_sessions=8
  await pgQuery(`UPDATE sale_orders SET total_amount = 1800, received = 1800 WHERE sale_order_id = $1`, [orderQ])
  await pgQuery(`UPDATE sale_items SET received = 800, paid_sessions = 8 WHERE sale_item_id = $1`, [qB])
  // 首次支付流水改 1800（覆盖 makePaidCardOrder 的 1000）
  await pgQuery(`UPDATE sale_order_payments SET amount = 1800 WHERE sale_order_id = $1 AND change_type = '首次支付'`, [orderQ])
  await addAllocation(qA, 1000)
  await addAllocation(qB, 800)

  const q1 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: orderQ, items: [{ saleItemId: qA }], refundReason: 'e2e_Q',
  })
  if (q1.code !== 0) errors.push(`Q createRefund 应成功，code=${q1.code} msg=${q1.message}`)
  const payQ = q1.data?.paymentId
  if (payQ) {
    const q2 = await invokeStaffApi('order.approveRefund', { _testOpenid: TEST_MANAGER_OPENID, paymentId: payQ })
    if (q2.code !== 0) errors.push(`Q approveRefund 应成功，code=${q2.code} msg=${q2.message}`)
    // 通道1（2026-06-24 起记负数冲销，非 is_void 软删）：退的 A 行新增挂退款流水 payQ 的 -1000 镜像行，净额=0；
    // 未退的 B 行保留 +800 不被误冲（Bug Q 守护——子集退款不清未退明细）
    const aA = await pgQuery(
      `SELECT COALESCE(SUM(total_amount::numeric),0)::numeric AS net,
              COUNT(*) FILTER (WHERE total_amount < 0 AND sale_payment_id = $2) AS neg
         FROM sale_allocations WHERE sale_item_id = $1`,
      [qA, payQ]
    )
    const aB = await pgQuery(
      `SELECT COALESCE(SUM(total_amount::numeric),0)::numeric AS net,
              COUNT(*) FILTER (WHERE total_amount < 0) AS neg
         FROM sale_allocations WHERE sale_item_id = $1`,
      [qB]
    )
    if (Number(aA[0]?.net) !== 0 || Number(aA[0]?.neg) !== 1) errors.push(`Q 退的 A 行分配应被负数冲销净额=0(1 条镜像行)，实际 net=${aA[0]?.net} neg=${aA[0]?.neg}`)
    if (Number(aB[0]?.net) !== 800 || Number(aB[0]?.neg) !== 0) errors.push(`Q 未退的 B 行分配不应被冲 net=800，实际 net=${aB[0]?.net} neg=${aB[0]?.neg}（Bug Q 回归！）`)
    if (Number(aA[0]?.net) === 0 && Number(aB[0]?.net) === 800) rec(`  ✓ Q 子集退款: A 分配负数冲销净额=0 / B 分配保留净额=800`)
  }

  // ───────────────────────────────────────────────────────────────────────
  // M：退剩余次数保护已挣提成（Bug M 强化 — 本轮修复核心守护）
  // ───────────────────────────────────────────────────────────────────────
  const orderM = `${NS}_RFCH_M`
  const { saleItemId: mItem } = await makePaidCardOrder(orderM, { total: 1000, sessionCount: 10 })
  // 模拟已消费 3 次：remaining=7（paid_sessions 维持 10）
  await pgQuery(`UPDATE sale_items SET remaining_sessions = 7 WHERE sale_item_id = $1`, [mItem])
  await addAllocation(mItem, 1000)
  // 已完成服务单 + 3 条 service_items + 3 条 service_commissions（员工已做的服务，提成已挣）
  const svcM = await createTestServiceOrder({
    serviceOrderId: `${NS}_RFCH_M_SVC`, status: '已完成',
    items: [{ saleItemId: mItem, sessionUsed: 1 }, { saleItemId: mItem, sessionUsed: 1 }, { saleItemId: mItem, sessionUsed: 1 }],
  })
  for (const it of svcM.items) {
    await pgQuery(
      `INSERT INTO service_commissions (service_item_id, employee_id, role_type, commission_rate, commission_amount, is_void)
       VALUES ($1, $2, '美容师', 0.1000, 10, false)`,
      [it.serviceItemId, TEST_MANAGER_EMP_ID]
    )
  }

  const m1 = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: orderM, items: [{ saleItemId: mItem }], refundReason: 'e2e_M',
  })
  if (m1.code !== 0) errors.push(`M createRefund 退剩余次数应成功，code=${m1.code} msg=${m1.message}`)
  const payM = m1.data?.paymentId
  if (payM) {
    const m2 = await invokeStaffApi('order.approveRefund', { _testOpenid: TEST_MANAGER_OPENID, paymentId: payM })
    if (m2.code !== 0) errors.push(`M approveRefund 应成功，code=${m2.code} msg=${m2.message}`)
    const voidedComm = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM service_commissions sc JOIN service_items si ON sc.service_item_id = si.service_item_id
        WHERE si.sale_item_id = $1 AND sc.is_void = true`,
      [mItem]
    )
    const alM = await pgQuery(`SELECT is_void FROM sale_allocations WHERE sale_item_id = $1`, [mItem])
    if (Number(voidedComm[0]?.n) !== 0) errors.push(`M 已完成服务的提成不应被作废，实际作废 ${voidedComm[0]?.n} 条（Bug M 回归·薪酬损失！）`)
    if (alM[0]?.is_void !== false) errors.push(`M 有已消费时分配不应作废 is_void=false，实际=${alM[0]?.is_void}`)
    if (Number(voidedComm[0]?.n) === 0 && alM[0]?.is_void === false) rec(`  ✓ M 退剩余次数: 3 条已挣提成 + 分配均保留（未误作废）`)
  }

  // ───────────────────────────────────────────────────────────────────────
  // C3：通道3 券回滚（整单全退）
  // ───────────────────────────────────────────────────────────────────────
  const orderC3 = `${NS}_RFCH_C3`
  const { saleItemId: c3Item } = await makePaidCardOrder(orderC3, { total: 500, sessionCount: 5 })
  const { couponId: c3Coupon } = await createTestCoupon({ couponId: `${NS}_RFCH_C3_UC`, status: '已使用' })
  await pgQuery(`UPDATE user_coupons SET used_sale_order_id = $2, used_at = NOW() WHERE coupon_id = $1`, [c3Coupon, orderC3])

  const c3a = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: orderC3, items: [{ saleItemId: c3Item }], refundReason: 'e2e_C3',
  })
  if (c3a.code !== 0) errors.push(`C3 createRefund 应成功，code=${c3a.code} msg=${c3a.message}`)
  const payC3 = c3a.data?.paymentId
  if (payC3) {
    const c3b = await invokeStaffApi('order.approveRefund', { _testOpenid: TEST_MANAGER_OPENID, paymentId: payC3 })
    if (c3b.code !== 0) errors.push(`C3 approveRefund 应成功，code=${c3b.code} msg=${c3b.message}`)
    const cp = await pgQuery(`SELECT status FROM user_coupons WHERE coupon_id = $1`, [c3Coupon])
    if (cp[0]?.status !== '未使用') errors.push(`C3 整单全退后券应恢复 '未使用'，实际=${cp[0]?.status}`)
    else rec(`  ✓ C3 通道3: 整单全退 → 券恢复未使用`)
  }

  // ───────────────────────────────────────────────────────────────────────
  // C4：通道4 积分消费冲销 + balance 重算
  // ───────────────────────────────────────────────────────────────────────
  const orderC4 = `${NS}_RFCH_C4`
  const { saleItemId: c4Item } = await makePaidCardOrder(orderC4, { total: 600, sessionCount: 6 })
  // 该单产生过 消费赠送 +60，顾客余额 60
  await pgQuery(
    `INSERT INTO point_transactions (user_id, ref_order_id, type, amount, created_at)
     VALUES ($1, $2, '消费赠送', 60, NOW())`,
    [TEST_CLIENT_USER_ID, orderC4]
  )
  await pgQuery(`UPDATE client_wechat_users SET points_balance = 60 WHERE user_id = $1`, [TEST_CLIENT_USER_ID])

  const c4a = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: orderC4, items: [{ saleItemId: c4Item }], refundReason: 'e2e_C4',
  })
  if (c4a.code !== 0) errors.push(`C4 createRefund 应成功，code=${c4a.code} msg=${c4a.message}`)
  const payC4 = c4a.data?.paymentId
  if (payC4) {
    const c4b = await invokeStaffApi('order.approveRefund', { _testOpenid: TEST_MANAGER_OPENID, paymentId: payC4 })
    if (c4b.code !== 0) errors.push(`C4 approveRefund 应成功，code=${c4b.code} msg=${c4b.message}`)
    const rev = await pgQuery(
      `SELECT amount FROM point_transactions WHERE ref_order_id = $1 AND type = '消费冲销'`,
      [orderC4]
    )
    const bal = await pgQuery(`SELECT points_balance FROM client_wechat_users WHERE user_id = $1`, [TEST_CLIENT_USER_ID])
    if (Number(rev[0]?.amount) !== -60) errors.push(`C4 应写 '消费冲销' -60，实际=${rev[0]?.amount}`)
    if (Number(bal[0]?.points_balance) !== 0) errors.push(`C4 退款后积分余额应重算为 0（60-60），实际=${bal[0]?.points_balance}`)
    if (Number(rev[0]?.amount) === -60 && Number(bal[0]?.points_balance) === 0) rec(`  ✓ C4 通道4: 消费冲销 -60 + 余额重算 0`)
  }

  // ───────────────────────────────────────────────────────────────────────
  // C5：通道5 家居退款计入已结算（schema-free 止血）—— 防超退/重复退
  //   家居 5 件、已提货 2、退 3 未提货 → picked_up 计入已退变 5（已结算）→ refundable=0 → 不可再退。
  // ───────────────────────────────────────────────────────────────────────
  const orderC5 = `${NS}_RFCH_C5`
  await createTestSaleOrder({
    saleOrderId: orderC5, clientUserId: TEST_CLIENT_USER_ID,
    saleOrderType: '销售单', productName: `${NS}_家居`, productType: '家居产品',
    quantity: 5, sessionCount: null, totalAmount: 500, status: '已支付', salesCategory: '他销自耗',
  })
  const c5Item = `${orderC5}_ITEM_1`
  await pgQuery(`UPDATE sale_orders SET received = 500 WHERE sale_order_id = $1`, [orderC5])
  await pgQuery(`UPDATE sale_items SET received = 500, picked_up_quantity = 2 WHERE sale_item_id = $1`, [c5Item])
  await pgQuery(
    `INSERT INTO sale_order_payments (sale_order_id, change_type, amount, payment_method, status, source_end, created_at)
     VALUES ($1, '首次支付', 500, '线下', '已支付', 'staff', NOW())`,
    [orderC5]
  )

  const c5a = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: orderC5, items: [{ saleItemId: c5Item, refundQuantity: 3 }], refundReason: 'e2e_C5',
  })
  if (c5a.code !== 0) errors.push(`C5 家居退未提货 3 件应成功，code=${c5a.code} msg=${c5a.message}`)
  const payC5 = c5a.data?.paymentId
  if (payC5) {
    const c5b = await invokeStaffApi('order.approveRefund', { _testOpenid: TEST_MANAGER_OPENID, paymentId: payC5 })
    if (c5b.code !== 0) errors.push(`C5 approveRefund 应成功，code=${c5b.code} msg=${c5b.message}`)
    const o5 = await pgQuery(`SELECT refunded_amount FROM sale_orders WHERE sale_order_id = $1`, [orderC5])
    if (Number(o5[0]?.refunded_amount) !== 300) errors.push(`C5 家居退 3 件 refunded_amount 应=300，实际=${o5[0]?.refunded_amount}`)
    // 通道5：已退 3 件计入 picked_up（已结算）→ LEAST(5, 2+3)=5
    const pk = await pgQuery(`SELECT picked_up_quantity FROM sale_items WHERE sale_item_id = $1`, [c5Item])
    if (Number(pk[0]?.picked_up_quantity) !== 5) errors.push(`C5 退后 picked_up 应=5（已结算 2提货+3退），实际=${pk[0]?.picked_up_quantity}`)
    // 防超退：refundable = quantity(5) - picked_up(5) = 0 → 二次退被拒
    const c5dup = await invokeStaffApi('order.createRefund', {
      _testOpenid: TEST_MANAGER_OPENID, refSaleOrderId: orderC5, items: [{ saleItemId: c5Item, refundQuantity: 1 }], refundReason: 'e2e_C5_dup',
    })
    if (c5dup.code === 0) errors.push(`C5 家居已结算后二次退应被拒（防退已提货的货·资损），实际成功`)
    else if (Number(pk[0]?.picked_up_quantity) === 5) rec(`  ✓ C5 通道5: 家居退 3 件计入已结算(picked_up=5) + refunded=300 + 二次退被拒`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }
  pass = true
  exitCode = 0
  rec(`  ✅ PASS — Bug Q 子集级联 + Bug M 提成保护 + 通道3券/4积分/5提货 真路径守护`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-refund-cascade-channels] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-refund-cascade-channels] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
