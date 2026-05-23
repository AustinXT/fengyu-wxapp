#!/usr/bin/env bun
/**
 * order.createConversion 转换单冒烟
 *
 * 验证：
 *   1. 已支付 的疗程卡可作折抵（convertOutSaleItemIds）
 *   2. 转换单生成"转出"+"转入"双向 sale_items（item_direction='转出'/'转入'）
 *   3. priceDiff < 0 时（折抵金额 > 转入金额）→ prepaid_cards.balance 自动充值
 *   4. card_transactions 写一条 type='充值' 流水
 *   5. 原 sale_items.remaining_sessions 被原子置 0（防重复折抵）
 *   6. 转换单 sale_order_type='转换单'，priceDiff<0 时 status='已支付'
 */
import './setup.mjs'
import {
  NS,
  TEST_STORE_ID, TEST_MANAGER_EMP_ID, TEST_MANAGER_OPENID,
  TEST_CLIENT_USER_ID, TEST_CLIENT_PHONE,
  pgQuery, closePool,
} from './setup.mjs'
import { invokeStaffApi } from './helpers/invoke.mjs'
import {
  ensureTestStore, createTestStaff, createTestClient,
  createTestProduct, createTestSaleOrder, cleanupTestData,
} from './helpers/fixtures.mjs'

let pass = false
let exitCode = 1

function rec(line) { console.log(line) }

async function main() {
  rec(`[smoke-order-conversion] start | ${new Date().toISOString()}`)

  await cleanupTestData(NS)
  await ensureTestStore()
  await createTestStaff()
  await createTestClient()

  // 源卡：疗程卡 5 次 × ¥500 单价（折抵金额 = 5 × 500 = 2500）
  const sourceSku = await createTestProduct({
    suffix: 'SRC',
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销他耗',
    price: 500,
    sessionCount: 5,
  })
  // 目标 SKU：单品 ¥200（转入金额）
  const targetSku = await createTestProduct({
    suffix: 'TGT',
    productKind: '护理项目',
    productType: '疗程卡',
    salesCategory: '他销自耗',
    price: 200,
    sessionCount: 1,
  })

  // 源销售单（已支付，含 1 个疗程卡 sale_item，pack 价 500）
  // 业务侧 conversion 折抵公式：amount = unit_real_price × remaining_sessions
  //   = 500 × 5 = 2500（pack 价 × 卡内剩余次数）
  const sourceOrderId = `${NS}_CONV_SRC`
  await createTestSaleOrder({
    saleOrderId: sourceOrderId,
    clientUserId: TEST_CLIENT_USER_ID,
    skuId: sourceSku.skuId,
    productName: sourceSku.specName,
    productType: '疗程卡',
    quantity: 1,
    sessionCount: 5,
    isShengmei: true,
    salesCategory: '他销他耗',
    totalAmount: 500,
    status: '已支付',
  })
  // sale_items.received 需为正（源卡）：fixture 已写
  const sourceItems = await pgQuery(
    `SELECT sale_item_id FROM sale_items WHERE sale_order_id = $1`,
    [sourceOrderId]
  )
  const sourceItemId = sourceItems[0].sale_item_id
  rec(`  ✓ fixture: 源卡 ${sourceItemId} (5次×¥500=¥2500), 目标 ${targetSku.skuId} (¥200)`)

  // ─── 调用 createConversion ───
  const result = await invokeStaffApi('order.createConversion', {
    _testOpenid: TEST_MANAGER_OPENID,
    clientUserId: TEST_CLIENT_USER_ID,
    convertOutSaleItemIds: [sourceItemId],
    convertInItems: [{ skuId: targetSku.skuId, quantity: 1 }],
    paymentMethod: '线下',
    remark: 'e2e-conversion',
  })
  if (result.code !== 0) {
    rec(`  ✗ FAIL: createConversion code=${result.code} msg=${result.message}`)
    return
  }
  const { saleOrderId, status, totalIn, totalOut, priceDiff, prepaidCardCredit } = result.data
  rec(`  result: order=${saleOrderId} status=${status} totalIn=${totalIn} totalOut=${totalOut} diff=${priceDiff} credit=${prepaidCardCredit}`)

  const errors = []

  // 1. priceDiff = 200 - 2500 = -2300
  if (priceDiff !== -2300) errors.push(`priceDiff 应=-2300，实际=${priceDiff}`)
  if (Number(prepaidCardCredit) !== 2300) errors.push(`prepaidCardCredit 应=2300，实际=${prepaidCardCredit}`)
  if (status !== '已支付') errors.push(`priceDiff<0 时 status 应='已支付'，实际='${status}'`)

  // 2. 转换单主表
  const orders = await pgQuery(
    `SELECT sale_order_type, status, total_amount, payable_amount FROM sale_orders WHERE sale_order_id = $1`,
    [saleOrderId]
  )
  if (orders.length !== 1) errors.push(`sale_orders 行数=${orders.length}`)
  else {
    const o = orders[0]
    if (o.sale_order_type !== '转换单') errors.push(`sale_order_type 应='转换单'，实际='${o.sale_order_type}'`)
    if (Number(o.total_amount) !== 0) errors.push(`total_amount 应=0（负差额时取 max(0, diff)），实际=${o.total_amount}`)
  }

  // 3. 转出 + 转入双行
  const items = await pgQuery(
    `SELECT sale_item_id, item_direction, sku_id, quantity, received, ref_sale_item_id
     FROM sale_items WHERE sale_order_id = $1 ORDER BY item_direction`,
    [saleOrderId]
  )
  if (items.length !== 2) errors.push(`sale_items 应=2 行（转出+转入），实际=${items.length}`)
  else {
    const out = items.find(it => it.item_direction === '转出')
    const inn = items.find(it => it.item_direction === '转入')
    if (!out) errors.push(`缺少 item_direction='转出' 行`)
    else {
      if (out.ref_sale_item_id !== sourceItemId) errors.push(`转出.ref_sale_item_id 应=${sourceItemId}, 实际=${out.ref_sale_item_id}`)
      if (Number(out.received) >= 0) errors.push(`转出.received 应<0，实际=${out.received}`)
      if (Number(out.quantity) !== 5) errors.push(`转出.quantity 应=5（疗程剩余次数），实际=${out.quantity}`)
    }
    if (!inn) errors.push(`缺少 item_direction='转入' 行`)
    else {
      if (inn.sku_id !== targetSku.skuId) errors.push(`转入.sku_id 应=${targetSku.skuId}, 实际=${inn.sku_id}`)
      if (Number(inn.received) !== 200) errors.push(`转入.received 应=200，实际=${inn.received}`)
    }
  }

  // 4. 源卡 remaining_sessions = 0（已折抵）
  const sourceAfter = await pgQuery(
    `SELECT remaining_sessions FROM sale_items WHERE sale_item_id = $1`,
    [sourceItemId]
  )
  if (Number(sourceAfter[0]?.remaining_sessions) !== 0) {
    errors.push(`源卡 remaining_sessions 应=0（已折抵），实际=${sourceAfter[0]?.remaining_sessions}`)
  }

  // 5. prepaid_cards 充值 2300
  const cards = await pgQuery(
    `SELECT balance FROM prepaid_cards WHERE user_id = $1`,
    [TEST_CLIENT_USER_ID]
  )
  if (cards.length !== 1) errors.push(`prepaid_cards 应=1 行，实际=${cards.length}`)
  else if (Number(cards[0].balance) !== 2300) errors.push(`prepaid_cards.balance 应=2300，实际=${cards[0].balance}`)

  // 6. card_transactions 充值流水
  const txns = await pgQuery(
    `SELECT type, amount FROM card_transactions WHERE ref_order_id = $1`,
    [saleOrderId]
  )
  if (txns.length !== 1) errors.push(`card_transactions 应=1 行，实际=${txns.length}`)
  else {
    if (txns[0].type !== '充值') errors.push(`card_transactions.type 应='充值'，实际='${txns[0].type}'`)
    if (Number(txns[0].amount) !== 2300) errors.push(`card_transactions.amount 应=2300，实际=${txns[0].amount}`)
  }

  if (errors.length) {
    rec(`  ✗ FAIL: ${errors.length} 项断言失败`)
    for (const e of errors) rec(`    - ${e}`)
    return
  }

  pass = true
  exitCode = 0
  rec(`  ✅ PASS — 转换单完整链路正确（折抵 ¥2500, 转入 ¥200, 储值卡入账 ¥2300）`)
}

try {
  await main()
} catch (e) {
  console.error('[smoke-order-conversion] EXCEPTION:', e.message)
  if (e?.stack) console.error(e.stack)
} finally {
  try { await cleanupTestData(NS) } catch (e) { console.error('[cleanup error]', e.message) }
  await closePool()
  console.log(`[smoke-order-conversion] end | ${pass ? 'PASS' : 'FAIL'} | exit=${exitCode}`)
  process.exit(exitCode)
}
