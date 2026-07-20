#!/usr/bin/env bun
/**
 * order.createDeposit 寄存单冒烟
 *
 * 验证（核心：寄存卡可消费 —— paid_sessions 全付兜底回归守护）：
 *   1. 寄存单 sale_orders：total_amount=0 / status='已支付' / payment_method='无'
 *   2. sale_items：session_count/remaining_sessions 正常写、received=0
 *   3. **paid_sessions = session_count**（total<=0 订单级兜底；曾因 5df8192 公式漂移归零，
 *      导致寄存卡 service.create 时被 D6 限额挡住完全不可消费 —— 本测试守护回归）
 *   4. unit_real_price：本单未录入实付（received=0）→ 置 0（如实反映未收款，不再回落标价）。
 *      实付>0 时按 received/session_count 重算的口径由 smoke-order-deposit-received 守护。
 */
import './setup.mjs'
import {
  NS,
  TEST_MANAGER_OPENID,
  TEST_CLIENT_USER_ID,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestProduct, createTestSaleOrder, cleanupTestData, invalidateStaffAuthCache,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1
function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-order-deposit] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()
  // 同进程内刚改了 permission_roles，必须清 staffApi AUTH_CACHE，否则 requireManager 看不到 manager 角色
  await invalidateStaffAuthCache(TEST_MANAGER_OPENID)

  // 疗程卡 SKU：10 次 × ¥100 单价（整卡 ¥1000）
  const sku = await createTestProduct({
    suffix: 'DEP',
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销他耗',
    price: 1000,
    sessionCount: 10,
  })
  rec(`  ✓ fixture: 疗程卡 ${sku.skuId} (10次×¥1000)`)

  // ─── 调用 createDeposit ───
  const result = await invokeStaffApi('order.createDeposit', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ skuId: sku.skuId, quantity: 1 }],
    remark: 'e2e-deposit',
  })
  if (result.code !== 0) {
    rec(`  ✗ FAIL: createDeposit code=${result.code} msg=${result.message}`)
    return
  }
  const saleOrderId = result.data?.saleOrderId
  rec(`  result: order=${saleOrderId}`)

  const errors = []

  // 1. 订单主表：total=0 / 已支付
  const orders = await pgQuery(
    `SELECT sale_order_type, status, total_amount, payment_method FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (orders.length !== 1) errors.push(`sale_orders 行数=${orders.length}`)
  else {
    const o = orders[0]
    if (Number(o.total_amount) !== 0) errors.push(`total_amount 应=0，实际=${o.total_amount}`)
    if (o.status !== '已支付') errors.push(`status 应='已支付'，实际='${o.status}'`)
    if (o.payment_method !== '无') errors.push(`payment_method 应='无'，实际='${o.payment_method}'`)
  }

  // 2 + 3 + 4. sale_items：次数 + received=0 + paid_sessions=session_count + per-session 单价
  const items = await pgQuery(
    `SELECT session_count, remaining_sessions, paid_sessions, received, sale_amount, unit_real_price
     FROM sale_items WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (items.length !== 1) errors.push(`sale_items 应=1 行，实际=${items.length}`)
  else {
    const it = items[0]
    if (Number(it.session_count) !== 10) errors.push(`session_count 应=10，实际=${it.session_count}`)
    if (Number(it.remaining_sessions) !== 10) errors.push(`remaining_sessions 应=10，实际=${it.remaining_sessions}`)
    if (Number(it.received) !== 0) errors.push(`received 应=0，实际=${it.received}`)
    // 核心断言：寄存卡 paid_sessions 必须 = session_count（全付兜底），否则完全不可消费
    if (Number(it.paid_sessions) !== 10) {
      errors.push(`paid_sessions 应=10（total<=0 全付兜底；=0 则寄存卡不可消费），实际=${it.paid_sessions}`)
    }
    // 本单 received=0 → unit_real_price = 0（如实反映未收款，不再回落标价）
    if (Number(it.unit_real_price) !== 0) {
      errors.push(`unit_real_price 应=0（实付0 不再回落标价），实际=${it.unit_real_price}`)
    }
  }

  // ─── 5. received>0 路径：建单录历史实付 → unit_real_price = 实付/次数（主功能正向覆盖）───
  const result2 = await invokeStaffApi('order.createDeposit', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    items: [{ skuId: sku.skuId, quantity: 1, received: 800 }],
    remark: 'e2e-deposit-received',
  })
  if (result2.code !== 0) {
    errors.push(`[received>0] createDeposit 失败 code=${result2.code} msg=${result2.message}`)
  } else {
    const r2 = await pgQuery(
      `SELECT received, unit_real_price, unit_price FROM sale_items WHERE sale_order_id = $1`,
      [result2.data?.saleOrderId]
    )
    const it2 = r2[0]
    // recalc STEP1 把定向回款落回 received=800；unit_real_price = 实付800/次数10 = 80；unit_price 仍标价 1000/10=100
    if (Number(it2?.received) !== 800) errors.push(`[received>0] sale_items.received 应=800，实际=${it2?.received}`)
    if (Number(it2?.unit_real_price) !== 80) errors.push(`[received>0] unit_real_price 应=80（实付800/10），实际=${it2?.unit_real_price}`)
    if (Number(it2?.unit_price) !== 100) errors.push(`[received>0] unit_price 应=100（标价1000/10，不变），实际=${it2?.unit_price}`)
    rec(`  ✓ received>0 asserted (received=${it2?.received}, unit_real_price=${it2?.unit_real_price})`)
  }

  // ─── 6. 资金操作锁定：寄存单 + 历史订单 禁止退款/回款（updateDepositReceived 已停用）───
  const depItem = (await pgQuery(
    `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 LIMIT 1`, [saleOrderId]
  ))[0]
  // 6a 寄存单退款 → 退款 Bug-L 正向白名单（order.js 78b268b8）：仅销售单支持退款，
  // 寄存单落入「仅销售单支持退款」兜底（errorType 仍 INVALID_STATE，退款仍被拒）。
  const depRefund = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: saleOrderId,
    items: [{ saleItemId: depItem?.sale_item_id, refundQuantity: 1 }],
    refundReason: 'e2e-lock',
  })
  if (depRefund.errorType !== 'INVALID_STATE' || !/仅销售单支持退款/.test(depRefund.message || '')) {
    errors.push(`[lock] 寄存单退款应=INVALID_STATE/仅销售单支持退款，实际 code=${depRefund.code} type=${depRefund.errorType} msg=${depRefund.message}`)
  }
  // 6b 寄存单回款 → INVALID_STATE（guard 先于状态校验）
  const depRepay = await invokeStaffApi('order.createRepayment', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: saleOrderId,
    paymentMethod: '线下',
    repayAmount: 100,
  })
  if (depRepay.errorType !== 'INVALID_STATE' || !/寄存单/.test(depRepay.message || '')) {
    errors.push(`[lock] 寄存单回款应=INVALID_STATE/寄存单，实际 code=${depRepay.code} type=${depRepay.errorType} msg=${depRepay.message}`)
  }
  // 6c 历史订单退款 → INVALID_STATE（seed 一张 legacy 销售单）
  const legacyId = `${NS}_LEGACY_REJECT`
  await createTestSaleOrder({ saleOrderId: legacyId, clientUserId: TEST_CLIENT_USER_ID, status: '已支付', saleOrderType: '销售单', totalAmount: 1000 })
  await pgQuery(`UPDATE sale_orders SET legacy_source = 'workfine' WHERE sale_order_id = $1`, [legacyId])
  const legItem = (await pgQuery(`SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1 LIMIT 1`, [legacyId]))[0]
  const legRefund = await invokeStaffApi('order.createRefund', {
    _testOpenid: TEST_MANAGER_OPENID,
    refSaleOrderId: legacyId,
    items: [{ saleItemId: legItem?.sale_item_id, refundQuantity: 1 }],
    refundReason: 'e2e-lock',
  })
  if (legRefund.errorType !== 'INVALID_STATE' || !/历史订单/.test(legRefund.message || '')) {
    errors.push(`[lock] 历史订单退款应=INVALID_STATE/历史订单，实际 code=${legRefund.code} type=${legRefund.errorType} msg=${legRefund.message}`)
  }
  rec(`  ✓ 资金锁定 asserted (寄存单退款/回款 + 历史订单退款 均被拒)`)

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 寄存单 total=0 + paid_sessions=session_count（可消费）+ 实付0回落标价100 + 实付800→单价80`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-deposit] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-deposit] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
