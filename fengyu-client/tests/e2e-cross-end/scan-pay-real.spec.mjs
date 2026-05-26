#!/usr/bin/env bun
/**
 * 跨端真链路：staff.order.create → client.order.scanDetail → scanAdjust → confirmPrepaidFull
 *
 * 与 fengyu-client/tests/e2e-cloudfn/order/scan-flow.spec.mjs 的区别：
 *   - L2 spec 用 PG INSERT 伪造 "员工开单待支付订单"
 *   - 本 spec 真调 staffApi.order.create 走完店长开单的完整 SQL + 状态机
 *
 * staff.order.create 实际签名（fengyu-staff/cloudfunctions/staffApi/routes/order.js:165+）：
 *   payload = {
 *     clientPhone,           // 必填，按 phone 反查 client_wechat_users
 *     clientName,            // 必填
 *     items: [{skuId, quantity?, customPrice?, discount?}],
 *     paymentMethod,         // 必填，仅 '微信' | '线下' 白名单（不接受 '储值卡'）
 *     saleOrderType?,        // 默认 '销售单'，不接受 '回款单'/'退款单'
 *     useCard?, prepaidCardAmount?, receivedAmount?,
 *     preferredStaffWfId?,
 *     couponId?, remark?,
 *   }
 *   - 顾客必须已 bound_store_id（CLIENT_NOT_REGISTERED 否则）
 *   - 单顾客只允许一笔 '待支付' 订单
 *   - opened_by = ctx.auth.employeeId（即店长本人）
 *   - 创建出的订单 status='待支付'，paymentMethod 直传，scanAdjust 可后续覆写
 *
 * 关键契约差异 vs spec 描述：
 *   - staff.order.create 不接受 clientUserId 入参，按 clientPhone 反查
 *   - paymentMethod 不允许 '储值卡'，需先用 '微信' 开单再让 client scanAdjust 覆写为 '储值卡'
 */
import './setup.mjs'
import {
  NS, closePool, pgQuery,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE,
  TEST_MANAGER_OPENID, TEST_SKU_NORMAL_ID,
} from './setup.mjs'
import {
  ensureCrossEndStore, createCrossManager, createCrossClient,
  ensureCrossSku, cleanupCrossEnd,
} from './helpers/fixtures-cross.mjs'
import { invokeAs } from './helpers/invoke-client.mjs'
import { invokeStaffAs } from './helpers/invoke-staff.mjs'

async function caseRealStaffOpenThenClientPay() {
  await ensureCrossEndStore()
  await createCrossManager()
  await createCrossClient({ balance: 200 })
  await ensureCrossSku({ price: '100.00' })

  // 1) staff.order.create — 店长开单 100 元
  const createRes = await invokeStaffAs(TEST_MANAGER_OPENID, 'order.create', {
    clientPhone: TEST_CLIENT_PHONE,
    clientName: `${NS}_顾客`,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信', // staffApi 白名单只允许 微信/线下；后续 scanAdjust 改 储值卡
  })
  if (createRes.code !== 0) {
    throw new Error(`staff.order.create failed: code=${createRes.code} errorType=${createRes.errorType} msg=${createRes.message}`)
  }
  const saleOrderId = createRes.data?.saleOrderId || createRes.data?.sale_order_id
  if (!saleOrderId) throw new Error(`expect saleOrderId in result, got: ${JSON.stringify(createRes.data)}`)

  // 验证 PG 落地：status='待支付' opened_by 非空 client_user_id 匹配
  const ordRows = await pgQuery(
    `SELECT status, opened_by, client_user_id, total_amount, prepaid_card_amount, payable_amount
       FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (ordRows.length !== 1) throw new Error(`expect 1 sale_orders row, got ${ordRows.length}`)
  if (ordRows[0].status !== '待支付') throw new Error(`expect status='待支付', got ${ordRows[0].status}`)
  if (!ordRows[0].opened_by) throw new Error(`expect opened_by NOT NULL`)
  if (ordRows[0].client_user_id !== TEST_CLIENT_USER_ID) {
    throw new Error(`expect client_user_id=${TEST_CLIENT_USER_ID}, got ${ordRows[0].client_user_id}`)
  }
  if (Number(ordRows[0].total_amount) !== 100) {
    throw new Error(`expect total_amount=100, got ${ordRows[0].total_amount}`)
  }

  // 2) client.order.scanDetail — 顾客扫码
  const detRes = await invokeAs(TEST_CLIENT_OPENID, 'order.scanDetail', { saleOrderId })
  if (detRes.code !== 0) {
    throw new Error(`client.scanDetail failed: code=${detRes.code} msg=${detRes.message}`)
  }
  if (detRes.data?.order?.orderNo !== saleOrderId) {
    throw new Error(`expect order.orderNo=${saleOrderId}, got ${detRes.data?.order?.orderNo}`)
  }

  // 3) client.order.scanAdjust — 顾客选择全额储值卡抵扣
  const adjRes = await invokeAs(TEST_CLIENT_OPENID, 'order.scanAdjust', {
    saleOrderId,
    useCard: true,
    prepaidCardAmount: 100,
    paymentMethod: '储值卡',
  })
  if (adjRes.code !== 0) {
    throw new Error(`client.scanAdjust failed: code=${adjRes.code} msg=${adjRes.message}`)
  }
  if (Number(adjRes.data?.prepaidCardAmount) !== 100) {
    throw new Error(`expect prepaidCardAmount=100, got ${adjRes.data?.prepaidCardAmount}`)
  }
  if (Number(adjRes.data?.paidAmount) !== 0) {
    throw new Error(`expect paidAmount=0 (full prepaid), got ${adjRes.data?.paidAmount}`)
  }

  // 4) client.order.confirmPrepaidFull — 顾客确认全额抵扣
  const cfmRes = await invokeAs(TEST_CLIENT_OPENID, 'order.confirmPrepaidFull', { saleOrderId })
  if (cfmRes.code !== 0) {
    throw new Error(`client.confirmPrepaidFull failed: code=${cfmRes.code} msg=${cfmRes.message}`)
  }
  if (cfmRes.data?.status !== '已支付') {
    throw new Error(`expect data.status='已支付', got ${cfmRes.data?.status}`)
  }

  // 5) PG 断言：订单已支付 / 余额 200→100 / card_transactions 一行 -100
  const final = await pgQuery(
    `SELECT status FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (final[0]?.status !== '已支付') throw new Error(`PG status=${final[0]?.status}, expect '已支付'`)

  const card = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  if (Number(card[0]?.balance) !== 100) {
    throw new Error(`expect balance=100 (200-100), got ${card[0]?.balance}`)
  }

  const txns = await pgQuery(
    `SELECT amount, type FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款'`,
    [saleOrderId]
  )
  if (txns.length !== 1) throw new Error(`expect 1 扣款 row, got ${txns.length}`)
  if (Number(txns[0].amount) !== -100) {
    throw new Error(`expect amount=-100, got ${txns[0].amount}`)
  }
}

async function caseStaffCreateClientNotRegisteredRejected() {
  // 用一个绝对未注册的手机号 → CLIENT_NOT_REGISTERED
  await ensureCrossEndStore()
  await createCrossManager()
  await ensureCrossSku()
  const UNREGISTERED_PHONE = '19999091099' // 不在任何 fixture 中
  // 双保险：清掉可能的残留
  await pgQuery(`DELETE FROM client_wechat_users WHERE phone = $1`, [UNREGISTERED_PHONE])
  const res = await invokeStaffAs(TEST_MANAGER_OPENID, 'order.create', {
    clientPhone: UNREGISTERED_PHONE,
    clientName: `${NS}_未注册`,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    paymentMethod: '微信',
  })
  if (res.code === 0) {
    throw new Error(`expect failure, got success: ${JSON.stringify(res.data)}`)
  }
  if (res.errorType !== 'CLIENT_NOT_REGISTERED') {
    throw new Error(`expect errorType=CLIENT_NOT_REGISTERED, got ${res.errorType} (msg=${res.message})`)
  }
}

const CASES = [
  ['staff.create → client.scan/adjust/confirm 全链路 + 余额扣减 + 扣款流水', caseRealStaffOpenThenClientPay],
  ['staff.create 顾客未注册 → CLIENT_NOT_REGISTERED', caseStaffCreateClientNotRegisteredRejected],
]

let pass = 0, fail = 0
console.log(`[cross-end/scan-pay-real] start | ${CASES.length} cases | ${new Date().toISOString()}`)
try {
  for (const [name, fn] of CASES) {
    await cleanupCrossEnd(NS)
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      pass++
    } catch (e) {
      console.log(`  ❌ ${name}`)
      console.log(`     ${e.message}`)
      if (process.env.E2E_DEBUG) console.log(e.stack)
      fail++
    }
  }
} finally {
  await cleanupCrossEnd(NS)
  await closePool()
}
console.log(`[cross-end/scan-pay-real] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
