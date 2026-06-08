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
 * ticket 2026-05-21（已修复，case 4 守护）：
 *   order.create 带 couponId 旧版会双重崩溃返回 -1：
 *     (a) `SELECT ... product_id FROM product_skus` — product_skus 无 product_id 列（SKU→product 关联在 mall_product_skus）；
 *     (b) 券 claim UPDATE 早于 INSERT sale_orders — used_sale_order_id FK（非 deferrable）立即校验失败。
 *   修复：(a) 改 LEFT JOIN mall_product_skus 取 product_id；(b) 券 claim 移到 INSERT sale_orders 之后。
 *   积分扣减在 create 时不发生（payNotify 才触发），本 spec 不测积分。
 *
 * 路径覆盖：
 *   case 1 happy：100 元订单 = 60 卡 + 40 微信。卡 500→440、card_transactions 一行 -60、order 一行 prepaid=60/payable=40
 *   case 2 卡余额不足：卡 50 < 抵扣 60 → INSUFFICIENT_BALANCE，卡余额不动、无 sale_orders（全单回滚）
 *   case 3 confirmPrepaidFull 重复幂等：第二次调用应抛 INVALID_PARAMS（status 已=已支付），card_transactions 仍 1 行
 *   case 4 券 + 卡 + 微信：限定商品现金券满100减10 → total=90/prepaid=60/payable=30，券原子 claim 指向本单
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
  createTestCoupon, createTestCouponTemplate,
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
         sku_id, product_name, product_type,
         unit_price, quantity, unit_real_price, sale_amount, received,
         is_experience
       )
       VALUES ($1, $2, $3, '购买'::item_direction,
               NULL, $4, '疗程卡'::product_type,
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
//   本 case 专注"卡 + 微信"半卡路径；含券的端到端由 case 4 覆盖。
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
    productType: '疗程卡',
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
    productType: '疗程卡',
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

// ---------- case 4: 优惠券 + 卡 + 微信（回归 ticket 2026-05-21：product_id 列 + 券 claim FK 顺序）----------
//   修复前 order.create 带 couponId 双重崩溃返回 -1（详见文件头注释）。
//   用"限定商品的现金券"端到端验证：商品维度过滤（skuProductMap）+ 券原子 claim（FK 顺序）均已修复。
async function caseCouponDeductionHappy() {
  await createTestClient()
  await createTestStaff()
  await createTestProduct({ productId: TEST_PRODUCT_ID, price: '100.00' })
  await createTestSku({
    skuId: TEST_SKU_NORMAL_ID,
    productId: TEST_PRODUCT_ID,
    price: '100.00',
    productType: '疗程卡',
  })
  await createTestPrepaidCard({ userId: TEST_CLIENT_USER_ID, balance: '500.00' })
  // 满100减10 现金券，限定 TEST_PRODUCT_ID → 强制走商品维度过滤（skuProductMap）
  await createTestCouponTemplate({ applicableProductIds: [TEST_PRODUCT_ID] })
  const { couponId } = await createTestCoupon({})

  const res = await invokeAs(TEST_CLIENT_OPENID, 'order.create', {
    storeId: TEST_STORE_ID,
    items: [{ skuId: TEST_SKU_NORMAL_ID, quantity: 1 }],
    couponId,
    useCard: true,
    prepaidCardAmount: 60,
    paymentMethod: '微信',
  })
  if (res.code !== 0) throw new Error(`expect code=0, got ${res.code}: ${res.message}`)
  const saleOrderId = res.data?.saleOrderId
  if (!saleOrderId) throw new Error(`missing saleOrderId: ${JSON.stringify(res.data)}`)

  // 订单：total=90(100-10券)、prepaid=60、payable=30、coupon_discount=10、coupon_id=本券、待支付
  const rows = await pgQuery(
    `SELECT total_amount, prepaid_card_amount, payable_amount, coupon_discount, coupon_id, status
       FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (rows.length !== 1) throw new Error(`expect 1 order row, got ${rows.length}`)
  const r = rows[0]
  if (Number(r.total_amount) !== 90) throw new Error(`total_amount=${r.total_amount}, expect 90`)
  if (Number(r.prepaid_card_amount) !== 60) throw new Error(`prepaid_card_amount=${r.prepaid_card_amount}, expect 60`)
  if (Number(r.payable_amount) !== 30) throw new Error(`payable_amount=${r.payable_amount}, expect 30`)
  if (Number(r.coupon_discount) !== 10) throw new Error(`coupon_discount=${r.coupon_discount}, expect 10`)
  if (r.coupon_id !== couponId) throw new Error(`coupon_id=${r.coupon_id}, expect ${couponId}`)
  if (r.status !== '待支付') throw new Error(`status=${r.status}, expect 待支付（payable>0）`)

  // 券原子 claim：status='已使用' + used_sale_order_id 指向本单（FK 顺序回归点）
  const uc = await pgQuery(
    `SELECT status, used_sale_order_id FROM user_coupons WHERE coupon_id = $1`,
    [couponId]
  )
  if (uc[0]?.status !== '已使用') throw new Error(`coupon status=${uc[0]?.status}, expect 已使用`)
  if (uc[0]?.used_sale_order_id !== saleOrderId) {
    throw new Error(`used_sale_order_id=${uc[0]?.used_sale_order_id}, expect ${saleOrderId}`)
  }

  // 半卡半微信：create 时卡余额未变（=500），扣减留待 payNotify
  const card = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`, [TEST_CLIENT_USER_ID]
  )
  if (Number(card[0].balance) !== 500) throw new Error(`card balance=${card[0].balance}, expect 500`)
}

const CASES = [
  ['happy 多重抵扣 100=60卡+40微信 (半卡 create 不扣，等 payNotify)', caseHappyMultiDeduction],
  ['卡余额不足 → INSUFFICIENT_BALANCE 全单事务回滚', caseInsufficientBalanceRollback],
  ['confirmPrepaidFull 重复调用 → INVALID_PARAMS 且 ctxn 仍 1 行', caseConfirmPrepaidFullDuplicate],
  ['券 + 卡 + 微信 → total=90/prepaid=60/payable=30 + 券原子 claim 指向本单', caseCouponDeductionHappy],
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
