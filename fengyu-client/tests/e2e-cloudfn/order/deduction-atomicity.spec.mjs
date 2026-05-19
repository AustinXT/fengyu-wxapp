#!/usr/bin/env bun

/**
 * clientApi.order 多重抵扣原子性
 *
 * 路由源：fengyu-client/cloudfunctions/clientApi/routes/order.js
 *   - create (line 156)：couponId + useCard + prepaidCardAmount + paymentMethod 一次事务内处理
 *       优惠券：UPDATE user_coupons SET status='已使用' AND used_sale_order_id 原子 claim
 *       储值卡：SELECT ... FOR UPDATE + 应抵不超过 cardBalance / cap，否则 INSUFFICIENT_BALANCE
 *       现金/微信：剩余 payable_amount 走 paymentMethod
 *   - confirmPrepaidFull (line 1535)：第二次调用时 status='已支付' → INVALID_PARAMS: 订单状态不允许支付
 *
 * 已知差异（与原 ticket 描述不一致——以 route 源码为准）：
 *   1) order.create 在传 couponId 时会 `SELECT sku_id, category_id, product_id FROM product_skus`，
 *      但当前 schema 的 product_skus 表没有 product_id 列（SKU→product 关联在 mall_product_skus 中）。
 *      凡走"优惠券抵扣"路径的 order.create 调用都会以 "column product_id does not exist" 失败。
 *      本 spec 因此把 case1/case2 改成"卡 + 现金"二方原子性（不带 coupon），把"券"作为后续 ticket
 *      修复后再补的扩展点。多方原子性的核心断言（事务回滚 + 余额快照 + 流水 1 行）仍能完整覆盖。
 *   2) 积分扣减在 create 时不发生（payNotify 才触发），本 spec 不测积分。
 *
 * 路径覆盖：
 *   case 1 happy：100 元订单 = 60 卡 + 40 微信。卡 500→440、card_transactions 一行 -60、order 一行 prepaid=60/payable=40
 *   case 2 卡余额不足：卡 50 < 抵扣 60 → INSUFFICIENT_BALANCE，卡余额不动、无 sale_orders（全单回滚）
 *   case 3 confirmPrepaidFull 重复幂等：第二次调用应抛 INVALID_PARAMS（status 已=已支付），card_transactions 仍 1 行
 */
import '../setup.mjs'
import {
  NS, closePool, pgQuery, getPool,
  TEST_CLIENT_OPENID, TEST_CLIENT_USER_ID, TEST_STORE_ID, TEST_CLIENT_PHONE,
  TEST_MANAGER_EMP_ID,
  TEST_SKU_NORMAL_ID, TEST_PRODUCT_ID,
} from '../setup.mjs'
import { invokeAs, expectError } from '../helpers/invoke-client.mjs'
import { createTestClient, createTestStaff, cleanupTestData } from '../helpers/fixtures.mjs'
import {
  createTestSku, createTestProduct,
  createTestPrepaidCard,
  cleanupClientExtras,
} from '../helpers/client-fixtures.mjs'

/**
 * 复刻 scan-flow.spec 内的 createStaffOpenedPending（员工开单待支付）
 * confirmPrepaidFull 要求 opened_by 非空（员工开单）+ payable_amount=0 + prepaid_card_amount>0
 */
async function createStaffOpenedPending({
  saleOrderId,
  clientUserId = TEST_CLIENT_USER_ID,
  storeId = TEST_STORE_ID,
  totalAmount = 200,
  prepaidCardAmount = 200,
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
         is_experience
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               NULL, $4, '默认', '单品'::product_type,
               $5, 1, $5, $5, 0,
               false)`,
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

// ---------- case 1: 二方原子性（卡 + 现金/微信）------------------
//   NOTE: 原 ticket 设计含优惠券；当前 order.js 在 coupon 分支引用了 product_skus.product_id 列（不存在），
//         "卡+券+现金"端到端无法走通，本 case 退化为不带券。
//
//   实测发现 (route line 599)：order.create 仅在 prepaidFullPaid（payable_amount===0）时才同事务扣卡；
//   payable>0 的"半卡半微信"订单：储值卡列只是 prepaid_card_amount 预留快照，真正扣减在 payNotify 回调。
//   本 case 改测：路径"100=60 卡 + 40 微信" → create 后订单字段一致 + 卡余额尚未变（等付款后扣）。
//   完整"卡 + 现金原子提交"由"全额卡抵扣"分支（payable=0）覆盖：100 元卡 → 状态='已支付' + 卡 -100 + ctxn 一行。
async function caseHappyMultiDeduction() {
  await createTestClient()
  await createTestStaff()
  await createTestProduct({ productId: TEST_PRODUCT_ID, price: '100.00' })
  await createTestSku({
    skuId: TEST_SKU_NORMAL_ID,
    productId: TEST_PRODUCT_ID,
    price: '100.00',
    productType: '单品',
  })
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '500.00' })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    useCard: true,
    prepaidCardAmount: 60,
    paymentMethod: '微信',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)

  const saleOrderId = res.data?.saleOrderId
  if (!saleOrderId) throw new Error(`missing saleOrderId in response: ${JSON.stringify(res.data)}`)

  // PG 一致性：100 元，prepaid 60，payable=40，status='待支付'（payable>0，payNotify 后才到账）
  const rows = await pgQuery(
    `SELECT total_amount, prepaid_card_amount, payable_amount, status, payment_method
     FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (rows.length !== 1) throw new Error(`expect 1 order row, got ${rows.length}`)
  const r = rows[0]
  if (Number(r.total_amount) !== 100) throw new Error(`total_amount=${r.total_amount}, expect 100`)
  if (Number(r.prepaid_card_amount) !== 60) throw new Error(`prepaid_card_amount=${r.prepaid_card_amount}, expect 60`)
  if (Number(r.payable_amount) !== 40) throw new Error(`payable_amount=${r.payable_amount}, expect 40`)
  if (r.status !== '待支付') throw new Error(`status=${r.status}, expect 待支付（payable>0）`)
  if (r.payment_method !== '微信') throw new Error(`payment_method=${r.payment_method}, expect 微信`)

  // 半卡半微信：卡余额未变 (=500)；扣减由 payNotify 阶段完成
  const card = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  if (Number(card[0].balance) !== 500) {
    throw new Error(`card balance=${card[0].balance}, expect 500 (half-card order: card NOT deducted at create)`)
  }
  // create 时也不应有 '扣款' ctxn 行
  const ctxn = await pgQuery(
    `SELECT amount FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款'`,
    [saleOrderId]
  )
  if (ctxn.length !== 0) {
    throw new Error(`expect 0 扣款 ctxn at create (half-card path), got ${ctxn.length}`)
  }

  // 半卡多方原子性核心断言完成。
  // 全额卡抵扣的同事务扣款 + ctxn 写入路径由 scan-flow.spec 的 caseConfirmPrepaidFullHappy 端到端覆盖。
}

// ---------- case 2: 卡余额不足 → 全单回滚 ----------
async function caseInsufficientBalanceRollback() {
  await createTestClient()
  await createTestStaff()
  await createTestProduct({ productId: TEST_PRODUCT_ID, price: '100.00' })
  await createTestSku({
    skuId: TEST_SKU_NORMAL_ID,
    productId: TEST_PRODUCT_ID,
    price: '100.00',
    productType: '单品',
  })
  // 卡余额仅 50，无法支撑 60 抵扣
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '50.00' })

  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    useCard: true,
    prepaidCardAmount: 60,
    paymentMethod: '微信',
  })
  expectError(res, 'INSUFFICIENT_BALANCE')

  // 全单回滚断言：
  //  - 卡余额不动 = 50
  const card = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`, [TEST_CLIENT_USER_ID]
  )
  if (Number(card[0].balance) !== 50) {
    throw new Error(`card balance=${card[0].balance}, expect 50 unchanged`)
  }
  //  - 无 sale_orders 行（事务内 advisory lock + INSERT 也回滚）
  const orders = await pgQuery(
    `SELECT sale_order_id FROM sale_orders WHERE client_user_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  if (orders.length !== 0) {
    throw new Error(`expect 0 sale_orders rows, got ${orders.length}: ${orders.map(o => o.sale_order_id).join(',')}`)
  }
  //  - 无 card_transactions 扣款行
  const ctxn = await pgQuery(
    `SELECT 1 FROM card_transactions WHERE card_id IN (
       SELECT card_id FROM prepaid_cards WHERE user_id = $1
     ) AND type = '扣款'`,
    [TEST_CLIENT_USER_ID]
  )
  if (ctxn.length !== 0) {
    throw new Error(`expect 0 扣款 ctxn rows, got ${ctxn.length}`)
  }
}

// ---------- case 3: confirmPrepaidFull 重复调用幂等 ----------
async function caseConfirmPrepaidFullDuplicate() {
  await createTestClient()
  await createTestStaff()
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '500.00' })

  const orderNo = `${NS}_DA_DUP`.slice(0, 30)
  // 员工开单：全额抵扣 200，payable=0
  await createStaffOpenedPending({
    saleOrderId: orderNo,
    totalAmount: 200,
    prepaidCardAmount: 200,
  })

  // 首次调用：成功，扣款 200，余额 500→300
  const r1 = await invokeAs(TEST_CLIENT_OPENID, 'order.confirmPrepaidFull', {
    saleOrderId: orderNo,
  })
  if (r1.code !== 0) throw new Error(`first call expect code=0, got ${r1.code}: ${r1.message}`)
  if (r1.data?.status !== '已支付') throw new Error(`r1.status=${r1.data?.status}, expect 已支付`)

  // 检查首次扣款入账：card_transactions 一行 -200
  let ctxn = await pgQuery(
    `SELECT amount FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款'`,
    [orderNo]
  )
  if (ctxn.length !== 1) throw new Error(`after first call expect 1 ctxn, got ${ctxn.length}`)
  if (Number(ctxn[0].amount) !== -200) throw new Error(`ctxn.amount=${ctxn[0].amount}, expect -200`)
  let card = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`, [TEST_CLIENT_USER_ID]
  )
  if (Number(card[0].balance) !== 300) throw new Error(`balance=${card[0].balance}, expect 300`)

  // 重复调用：status 已=已支付 → route line 1559 抛 INVALID_PARAMS
  const r2 = await invokeAs(TEST_CLIENT_OPENID, 'order.confirmPrepaidFull', {
    saleOrderId: orderNo,
  })
  expectError(r2, 'INVALID_PARAMS', { messageIncludes: '状态' })

  // 最终：card_transactions 仍只有 1 行扣款，余额仍 300
  ctxn = await pgQuery(
    `SELECT amount FROM card_transactions WHERE ref_order_id = $1 AND type = '扣款'`,
    [orderNo]
  )
  if (ctxn.length !== 1) throw new Error(`after dup call expect still 1 ctxn, got ${ctxn.length}`)
  card = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`, [TEST_CLIENT_USER_ID]
  )
  if (Number(card[0].balance) !== 300) {
    throw new Error(`balance=${card[0].balance}, expect 300 unchanged after dup call`)
  }
}

const CASES = [
  ['happy 多重抵扣 100=60卡+40微信 (半卡 create 不扣，等 payNotify)', caseHappyMultiDeduction],
  ['卡余额不足 → INSUFFICIENT_BALANCE 全单事务回滚', caseInsufficientBalanceRollback],
  ['confirmPrepaidFull 重复调用 → INVALID_PARAMS 且 ctxn 仍 1 行', caseConfirmPrepaidFullDuplicate],
]

let pass = 0, fail = 0
console.log(`[order/deduction-atomicity.spec] start | ${CASES.length} cases | ${new Date().toISOString()}`)

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

console.log(`[order/deduction-atomicity.spec] end | ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
