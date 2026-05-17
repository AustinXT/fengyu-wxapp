#!/usr/bin/env bun
/**
 * clientApi.order.{scanDetail,scanAdjust,confirmPrepaidFull}
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js
 *   - scanDetail        (line 56)   仅限 opened_by IS NOT NULL 的员工开单
 *                                    待支付 → 返回 {order, items}；其他 → {orderNo,status,statusMsg}
 *                                    requirePhone 强制
 *   - scanAdjust        (line 1391) 仅 opened_by IS NOT NULL 且 status='待支付'
 *                                    重算 prepaid_card_amount/payable_amount/payment_method
 *                                    余额不足 → INSUFFICIENT_BALANCE
 *                                    跨用户：client_user_id 非空且不匹配 → PERMISSION_DENIED
 *   - confirmPrepaidFull(line 1501) 仅 payable_amount=0 (全额抵扣)；扣 balance + 写 card_transactions + 置 '已支付'
 *                                    余额不足 → INSUFFICIENT_BALANCE，无 card_transactions 写入
 *
 * 重要发现/差异：
 *   - scanDetail 跨用户：scanDetail 没有 client_user_id 匹配校验，只判 opened_by 存在
 *     → 顾客 A 也能扫顾客 B 的待支付员工单（路由设计：扫码绑定语义）
 *     → 实际跨用户隔离在 scanAdjust/confirmPrepaidFull 处（client_user_id 非空时校验）
 *   - 为测"跨用户 scanDetail 拒绝"，本 spec 用 scanAdjust 测跨用户更可靠
 *   - createTestPendingSaleOrder 默认 opened_by=NULL，本 spec 手工 INSERT 员工开单
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery, getPool,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID, TEST_CLIENT_PHONE,
  TEST_MANAGER_EMP_ID,
  TEST_CLIENT2_OPENID, TEST_CLIENT2_USER_ID,
} from '../setup.mjs'
import { invokeAs, expectError, expectSuccess } from '../helpers/invoke-client.mjs'
import {
  createTestClient, createTestStaff, cleanupTestData,
} from '../../../../tests/e2e-cloudfn/helpers/fixtures.mjs'
import {
  createTestPrepaidCard, setCardBalance, createTestClient2,
  cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'

/**
 * 创建员工开单的"待支付"销售单（opened_by 非空）
 * 默认绑定到顾客 A
 */
async function createStaffOpenedPending({
  saleOrderId,
  clientUserId = TEST_CLIENT_USER_ID,
  storeId = TEST_STORE_ID,
  totalAmount = 300,
  prepaidCardAmount = 0,
} = {}) {
  const payable = totalAmount - prepaidCardAmount
  const pool = getPool()
  const conn = await pool.connect()
  try {
    await conn.query('BEGIN')
    await conn.query(
      `INSERT INTO sale_orders (
         sale_order_id, status, sale_order_type, market_name, store_id,
         sale_order_datetime, client_user_id, client_phone, customer_name,
         total_amount, prepaid_card_amount, payable_amount, received,
         payment_method, allocation_status, opened_by
       )
       VALUES ($1, '待支付'::order_status, '销售单'::sale_order_type, $2, $3,
               NOW(), $4, $5, $6,
               $7, $8, $9, 0,
               '微信'::payment_method, '待分配'::allocation_status, $10)`,
      [saleOrderId, `${NS}_市场`, storeId,
       clientUserId, TEST_CLIENT_PHONE, `${NS}_顾客`,
       totalAmount, prepaidCardAmount, payable, TEST_MANAGER_EMP_ID]
    )
    const itemId = `${saleOrderId}_I1`.slice(0, 30)
    await conn.query(
      `INSERT INTO sale_items (
         sale_item_id, sale_order_id, store_id, item_direction,
         sku_id, product_name, sku_spec_name, product_type,
         unit_price, quantity, unit_real_price, sale_amount, received,
         is_experience, is_recharge_card
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               NULL, $4, '默认', '单品'::product_type,
               $5, 1, $5, $5, 0,
               false, false)`,
      [itemId, saleOrderId, storeId, `${NS}_员工单商品`, totalAmount]
    )
    await conn.query('COMMIT')
    return { saleOrderId, saleItemId: itemId }
  } catch (e) {
    await conn.query('ROLLBACK')
    throw e
  } finally {
    conn.release()
  }
}

async function caseScanDetailHappy() {
  await createTestClient()
  await createTestStaff()
  const orderNo = `${NS}_SCN_DT1`.slice(0, 30)
  await createStaffOpenedPending({ saleOrderId: orderNo, totalAmount: 300 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.scanDetail', { saleOrderId: orderNo })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data?.order?.orderNo !== orderNo) {
    throw new Error(`expect order.orderNo=${orderNo}, got: ${res.data?.order?.orderNo}`)
  }
  if (Number(res.data.order.totalAmount) !== 300) {
    throw new Error(`expect totalAmount=300, got: ${res.data.order.totalAmount}`)
  }
  if (Number(res.data.order.payableAmount) !== 300) {
    throw new Error(`expect payableAmount=300, got: ${res.data.order.payableAmount}`)
  }
  if (!Array.isArray(res.data.items) || res.data.items.length !== 1) {
    throw new Error(`expect items.length=1, got ${res.data.items?.length}`)
  }
}

async function caseScanAdjustFullPrepaid() {
  await createTestClient()
  await createTestStaff()
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '1000.00' })
  const orderNo = `${NS}_SCN_FULL`.slice(0, 30)
  await createStaffOpenedPending({ saleOrderId: orderNo, totalAmount: 300 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.scanAdjust', {
    saleOrderId: orderNo,
    useCard: true,
    prepaidCardAmount: 300,
    paymentMethod: '储值卡',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (Number(res.data.prepaidCardAmount) !== 300) {
    throw new Error(`expect prepaidCardAmount=300, got: ${res.data.prepaidCardAmount}`)
  }
  if (Number(res.data.paidAmount) !== 0) {
    throw new Error(`expect paidAmount=0, got: ${res.data.paidAmount}`)
  }
  // status 仍是 '待支付'，等 confirmPrepaidFull 才置 '已支付'
  const rows = await pgQuery(
    `SELECT status, prepaid_card_amount, payable_amount FROM sale_orders WHERE sale_order_id = $1`,
    [orderNo]
  )
  if (rows[0].status !== '待支付') throw new Error(`expect status=待支付, got ${rows[0].status}`)
  if (Number(rows[0].prepaid_card_amount) !== 300) {
    throw new Error(`PG prepaid_card_amount=${rows[0].prepaid_card_amount}`)
  }
  if (Number(rows[0].payable_amount) !== 0) {
    throw new Error(`PG payable_amount=${rows[0].payable_amount}`)
  }
  // 余额不应被动 (scanAdjust 不扣款)
  const cardRows = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  if (Number(cardRows[0].balance) !== 1000) {
    throw new Error(`expect balance unchanged=1000, got: ${cardRows[0].balance}`)
  }
}

async function caseScanAdjustPartialPrepaid() {
  await createTestClient()
  await createTestStaff()
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '100.00' })
  const orderNo = `${NS}_SCN_PART`.slice(0, 30)
  await createStaffOpenedPending({ saleOrderId: orderNo, totalAmount: 300 })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.scanAdjust', {
    saleOrderId: orderNo,
    useCard: true,
    prepaidCardAmount: 100,
    paymentMethod: '微信',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (Number(res.data.prepaidCardAmount) !== 100) {
    throw new Error(`expect prepaidCardAmount=100, got: ${res.data.prepaidCardAmount}`)
  }
  if (Number(res.data.paidAmount) !== 200) {
    throw new Error(`expect paidAmount=200, got: ${res.data.paidAmount}`)
  }
  if (res.data.paymentMethod !== '微信') {
    throw new Error(`expect paymentMethod=微信, got: ${res.data.paymentMethod}`)
  }
}

async function caseConfirmPrepaidFullHappy() {
  await createTestClient()
  await createTestStaff()
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '1000.00' })
  const orderNo = `${NS}_SCN_CFM`.slice(0, 30)
  // 先把订单造成全额抵扣（prepaid=300, payable=0）
  await createStaffOpenedPending({
    saleOrderId: orderNo, totalAmount: 300, prepaidCardAmount: 300,
  })
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.confirmPrepaidFull', {
    saleOrderId: orderNo,
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  if (res.data.status !== '已支付') {
    throw new Error(`expect status=已支付, got: ${res.data.status}`)
  }
  // card_transactions 有一行 type='扣款'
  const ctxn = await pgQuery(
    `SELECT amount FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款'`,
    [orderNo]
  )
  if (ctxn.length !== 1) throw new Error(`expect 1 扣款 row, got ${ctxn.length}`)
  if (Number(ctxn[0].amount) !== -300) {
    throw new Error(`expect amount=-300, got: ${ctxn[0].amount}`)
  }
  // balance 从 1000 → 700
  const cardRows = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  if (Number(cardRows[0].balance) !== 700) {
    throw new Error(`expect balance=700, got: ${cardRows[0].balance}`)
  }
  // 订单 status='已支付'
  const ord = await pgQuery(`SELECT status FROM sale_orders WHERE sale_order_id = $1`, [orderNo])
  if (ord[0].status !== '已支付') throw new Error(`PG status=${ord[0].status}`)
}

async function caseConfirmPrepaidFullInsufficient() {
  await createTestClient()
  await createTestStaff()
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '1000.00' })
  const orderNo = `${NS}_SCN_INSF`.slice(0, 30)
  await createStaffOpenedPending({
    saleOrderId: orderNo, totalAmount: 300, prepaidCardAmount: 300,
  })
  // 余额改为不足
  await setCardBalance(TEST_CLIENT_USER_ID, 100)
  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.confirmPrepaidFull', {
    saleOrderId: orderNo,
  })
  expectError(res, 'INSUFFICIENT_BALANCE')
  // 无 card_transactions 写入
  const ctxn = await pgQuery(
    `SELECT 1 FROM card_transactions WHERE ref_order_id = $1`,
    [orderNo]
  )
  if (ctxn.length !== 0) throw new Error(`expect 0 card_transactions rows, got ${ctxn.length}`)
  // 订单状态仍是 '待支付'
  const ord = await pgQuery(`SELECT status FROM sale_orders WHERE sale_order_id = $1`, [orderNo])
  if (ord[0].status !== '待支付') throw new Error(`expect status=待支付, got: ${ord[0].status}`)
}

async function caseScanAdjustCrossUserDenied() {
  await createTestClient()       // 顾客 A
  await createTestStaff()
  await createTestClient2()      // 顾客 B
  const orderNo = `${NS}_SCN_XU1`.slice(0, 30)
  // 订单绑顾客 A
  await createStaffOpenedPending({ saleOrderId: orderNo, totalAmount: 200 })
  // 顾客 B 调 scanAdjust → client_user_id 非空且不等 → PERMISSION_DENIED
  const res = await invokeAs(TEST_CLIENT2_OPENID, 'order.scanAdjust', {
    saleOrderId: orderNo,
    useCard: false,
    paymentMethod: '微信',
  })
  expectError(res, 'PERMISSION_DENIED')
}

const CASES = [
  ['scanDetail happy (staff-opened, status=待支付) → returns order + items', caseScanDetailHappy],
  ['scanAdjust full prepaid (300 from 1000 balance, payable→0)', caseScanAdjustFullPrepaid],
  ['scanAdjust partial prepaid (100 card + 200 wechat)', caseScanAdjustPartialPrepaid],
  ['confirmPrepaidFull happy → 扣款 written + balance -300 + status=已支付', caseConfirmPrepaidFullHappy],
  ['confirmPrepaidFull insufficient balance → INSUFFICIENT_BALANCE, no write', caseConfirmPrepaidFullInsufficient],
  ['scanAdjust cross-user → PERMISSION_DENIED', caseScanAdjustCrossUserDenied],
]

let pass = 0, fail = 0
console.log(`[order/scan-flow.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

try {
  for (const [name, fn] of CASES) {
    await cleanupClientExtras(NS)
    await cleanupTestData(NS)
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
  await cleanupClientExtras(NS)
  await cleanupTestData(NS)
  await closePool()
}

console.log(`[order/scan-flow.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
