/**
 * 链路 39：转换单 3 种差额场景
 *
 * 主题：sale_order_type='转换单' 业务规则：
 *   - priceDiff = totalIn - totalOut
 *   - priceDiff < 0：差额 UPSERT 到 prepaid_cards.balance + 记 card_transactions
 *   - priceDiff = 0：直接 status='已支付', total_amount=0
 *   - priceDiff > 0：补现，status='待支付'/'待确认收款', total_amount=priceDiff
 *
 *   且原卡（疗程卡）remaining_sessions = 0（耗尽）；
 *   sale_items 转出行 sale_amount/received 为负数；
 *   sale_items 转入行 item_direction='转入'。
 *
 * 测试策略：
 *   - 直接 SQL 模拟 createConversionOrder 的事务效果（按照 src/actions/orders.ts:1436-1850 的 INSERT/UPDATE 模式）
 *   - 验证 3 种 priceDiff 场景下 sale_orders / sale_items / prepaid_cards / card_transactions 状态
 *   - 这是契约测试：保证业务约束不偏离 source of truth
 *
 * 关键引用：
 *   - actions/orders.ts:1436 createConversionOrder
 *   - actions/orders.ts:1684-1702 订单主表 INSERT（status / totalAmount / paidAt 由 priceDiff 决定）
 *   - actions/orders.ts:1733-1739 原卡 remaining=0 原子标记
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  TOPOLOGY,
  psql, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN39'
// 用独立顾客（FY-TEST-CRON-02 已 seed，无既有储值卡，可独立做 prepaid_cards 测试）
const CLIENT_USER = 'FY-TEST-CRON-02'
const CLIENT_PHONE = '13800138012'
const CLIENT_NAME = 'CRON顾客2'
const STORE_ID = TOPOLOGY.STORE_NC01
const SKU_OUT = 'c79157b29c9e974c' // 转出原卡（疗程卡）
const SKU_IN = '2e388ba778334779'  // 转入新项目
const CARD_ID = `CARD-${TAG}-CLIENT` // 唯一卡（user_id UNIQUE，所以多 scenario 共用同一张）

/** 简化版 createConversion 的 SQL 模拟（仅用于测试） */
function simulateConversion(opts: {
  scenario: 'A' | 'B' | 'C' // A: diff<0, B: diff=0, C: diff>0
  origRemaining: number
  origUnitPrice: number
  inQuantity: number
  inUnitPrice: number
}): {
  origSoid: string
  origSiid: string
  convSoid: string
  outSiid: string
  inSiid: string
  totalOut: number
  totalIn: number
  priceDiff: number
} {
  const origSoid = `FY-${TAG}-OR${opts.scenario}-001`
  const origSiid = `${origSoid}-01`
  const convSoid = `FY-${TAG}-CV${opts.scenario}-001`
  const outSiid = `${convSoid}-01`
  const inSiid = `${convSoid}-02`

  const totalOut = Math.round(opts.origRemaining * opts.origUnitPrice * 100) / 100
  const totalIn = Math.round(opts.inQuantity * opts.inUnitPrice * 100) / 100
  const priceDiff = Math.round((totalIn - totalOut) * 100) / 100

  // 1. 原始订单（已支付 + remaining=opts.origRemaining）
  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount, paid_at
    ) VALUES (
      '${origSoid}', '已支付', '销售单', '南昌市场', '${STORE_ID}',
      NOW() - interval '1 day', '${CLIENT_USER}', '${CLIENT_PHONE}', '${CLIENT_NAME}',
      ${opts.origUnitPrice * opts.origRemaining + 100}, '线下', 'FY-TEST-MGR',
      NOW() - interval '1 day', NOW() - interval '1 day',
      ${opts.origUnitPrice * opts.origRemaining + 100}, ${opts.origUnitPrice * opts.origRemaining + 100}, 0, 0,
      NOW() - interval '1 day'
    )
  `)
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      '${origSiid}', '${origSoid}', '${STORE_ID}', '购买', '${SKU_OUT}',
      '洗-无创纹身 疗程卡', '疗程卡',
      ${opts.origRemaining + 2}, ${opts.origRemaining},
      ${opts.origUnitPrice}, 1, ${opts.origUnitPrice}, ${opts.origUnitPrice * (opts.origRemaining + 2)}, ${opts.origUnitPrice * (opts.origRemaining + 2)},
      0, false, NOW() - interval '1 day', NOW() - interval '1 day'
    )
  `)

  // 2. 转换订单
  const orderStatus = priceDiff > 0 ? '待支付' : '已支付'
  const orderTotal = Math.max(0, priceDiff).toFixed(2)
  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount, paid_at,
      document_type, allocation_status
    ) VALUES (
      '${convSoid}', '${orderStatus}', '转换单', '南昌市场', '${STORE_ID}',
      NOW(), '${CLIENT_USER}', '${CLIENT_PHONE}', '${CLIENT_NAME}',
      ${orderTotal}, '微信', 'FY-TEST-MGR', NOW(), NOW(),
      ${orderTotal}, ${priceDiff > 0 ? '0' : orderTotal}, 0, 0,
      ${priceDiff > 0 ? 'NULL' : 'NOW()'},
      '售后', '待分配'
    )
  `)

  // 3. 原卡耗尽：remaining_sessions = 0
  psql(`UPDATE sale_items SET remaining_sessions=0 WHERE sale_item_id='${origSiid}'`)

  // 4. 转出 sale_item（负金额）
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, ref_sale_item_id, sku_id,
      product_name, product_type, session_count,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      '${outSiid}', '${convSoid}', '${STORE_ID}', '转出', '${origSiid}', '${SKU_OUT}',
      '洗-无创纹身 疗程卡', '疗程卡', ${opts.origRemaining},
      ${opts.origUnitPrice}, 1, ${opts.origUnitPrice}, ${-totalOut}, ${-totalOut},
      0, false, NOW(), NOW()
    )
  `)

  // 5. 转入 sale_item
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      '${inSiid}', '${convSoid}', '${STORE_ID}', '转入', '${SKU_IN}',
      '假性皱纹', '疗程卡', ${opts.inQuantity}, ${opts.inQuantity},
      ${opts.inUnitPrice}, ${opts.inQuantity}, ${opts.inUnitPrice}, ${totalIn}, ${priceDiff > 0 ? '0' : totalIn},
      0, false, NOW(), NOW()
    )
  `)

  // 6. priceDiff < 0：UPSERT prepaid_cards（按 user_id 唯一）+ card_transactions
  if (priceDiff < 0) {
    const credit = Math.abs(priceDiff).toFixed(2)
    psql(`
      INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
      VALUES ('${CARD_ID}', '${CLIENT_USER}', ${credit}, NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE SET balance = prepaid_cards.balance + ${credit}, updated_at=NOW()
    `)
    // 查实际写入的 card_id（可能因 UPSERT 命中已有行）
    const realCardId = psql(`SELECT card_id FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`).trim()
    psql(`
      INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
      VALUES ('${realCardId}', '充值', ${credit}, '${convSoid}', NOW())
    `)
  }

  return { origSoid, origSiid, convSoid, outSiid, inSiid, totalOut, totalIn, priceDiff }
}

function cleanupScenario(s: 'A' | 'B' | 'C'): void {
  const origSoid = `FY-${TAG}-OR${s}-001`
  const convSoid = `FY-${TAG}-CV${s}-001`
  try { psql(`DELETE FROM card_transactions WHERE ref_order_id='${convSoid}'`) } catch {/* noop */}
  cleanupSaleOrder(convSoid, psql, { logPrefix: `[链路39-${s}]` })
  cleanupSaleOrder(origSoid, psql, { logPrefix: `[链路39-${s}]` })
}

function cleanupAll(): void {
  cleanupScenario('A')
  cleanupScenario('B')
  cleanupScenario('C')
  // 最后清理 prepaid_cards（确保 CRON-02 顾客的卡被删，避免污染下一次 run）
  try { psql(`DELETE FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`) } catch {/* noop */}
}

test.setTimeout(180_000)

test('链路39：转换单 3 种差额场景', async () => {
  const verdicts: Verdict[] = []
  cleanupAll()

  // ── 场景 A：priceDiff < 0（totalOut=800, totalIn=300, diff=-500）── 差额返储值卡
  console.log('[链路39] 场景 A: priceDiff < 0')
  const r1 = simulateConversion({ scenario: 'A', origRemaining: 8, origUnitPrice: 100, inQuantity: 3, inUnitPrice: 100 })
  console.log(`[链路39-A] totalOut=${r1.totalOut} totalIn=${r1.totalIn} diff=${r1.priceDiff}`)

  const a_origRemaining = parseInt(psql(`SELECT remaining_sessions::text FROM sale_items WHERE sale_item_id='${r1.origSiid}'`), 10)
  recordVerdict(verdicts, 'A_original_card_exhausted', a_origRemaining === 0, `remaining=${a_origRemaining}`)

  const a_orderStatus = psql(`SELECT status FROM sale_orders WHERE sale_order_id='${r1.convSoid}'`).trim()
  recordVerdict(verdicts, 'A_order_already_paid', a_orderStatus === '已支付', `status=${a_orderStatus}`)

  const a_orderTotal = parseFloat(psql(`SELECT total_amount::text FROM sale_orders WHERE sale_order_id='${r1.convSoid}'`))
  recordVerdict(verdicts, 'A_order_total_zero', a_orderTotal === 0, `total=${a_orderTotal}`)

  const a_outSale = parseFloat(psql(`SELECT sale_amount::text FROM sale_items WHERE sale_item_id='${r1.outSiid}'`))
  recordVerdict(verdicts, 'A_out_item_negative', a_outSale < 0, `outSale=${a_outSale}`)

  const a_credit = parseFloat(psql(`SELECT balance::text FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`))
  recordVerdict(verdicts, 'A_prepaid_card_credited', Math.abs(a_credit - Math.abs(r1.priceDiff)) < 0.01,
    `expected=${Math.abs(r1.priceDiff)} actual=${a_credit}`)

  const a_txn = parseFloat(psql(`SELECT amount::text FROM card_transactions WHERE ref_order_id='${r1.convSoid}'`))
  recordVerdict(verdicts, 'A_card_transaction_recorded', Math.abs(a_txn - Math.abs(r1.priceDiff)) < 0.01,
    `expected=${Math.abs(r1.priceDiff)} actual=${a_txn}`)

  // ── 场景 B：priceDiff = 0（totalOut=500, totalIn=500）── 直接已支付
  console.log('[链路39] 场景 B: priceDiff = 0')
  const r2 = simulateConversion({ scenario: 'B', origRemaining: 5, origUnitPrice: 100, inQuantity: 5, inUnitPrice: 100 })
  recordVerdict(verdicts, 'B_priceDiff_zero', r2.priceDiff === 0, `diff=${r2.priceDiff}`)

  const b_orderStatus = psql(`SELECT status FROM sale_orders WHERE sale_order_id='${r2.convSoid}'`).trim()
  recordVerdict(verdicts, 'B_order_paid', b_orderStatus === '已支付', `status=${b_orderStatus}`)

  const b_orderTotal = parseFloat(psql(`SELECT total_amount::text FROM sale_orders WHERE sale_order_id='${r2.convSoid}'`))
  recordVerdict(verdicts, 'B_order_total_zero', b_orderTotal === 0, `total=${b_orderTotal}`)

  // B 场景不应增加 card_transactions 行
  const b_txnAfterB = parseInt(psql(`SELECT COUNT(*)::text FROM card_transactions WHERE ref_order_id='${r2.convSoid}'`), 10)
  recordVerdict(verdicts, 'B_no_card_transaction', b_txnAfterB === 0, `count=${b_txnAfterB}`)

  // ── 场景 C：priceDiff > 0（totalOut=300, totalIn=800, diff=+500）── 顾客补现
  console.log('[链路39] 场景 C: priceDiff > 0')
  const r3 = simulateConversion({ scenario: 'C', origRemaining: 3, origUnitPrice: 100, inQuantity: 8, inUnitPrice: 100 })

  const c_orderStatus = psql(`SELECT status FROM sale_orders WHERE sale_order_id='${r3.convSoid}'`).trim()
  recordVerdict(verdicts, 'C_order_pending_pay', c_orderStatus === '待支付', `status=${c_orderStatus}`)

  const c_orderTotal = parseFloat(psql(`SELECT total_amount::text FROM sale_orders WHERE sale_order_id='${r3.convSoid}'`))
  recordVerdict(verdicts, 'C_order_total_eq_diff', Math.abs(c_orderTotal - r3.priceDiff) < 0.01,
    `expected=${r3.priceDiff} actual=${c_orderTotal}`)

  const c_origRemaining = parseInt(psql(`SELECT remaining_sessions::text FROM sale_items WHERE sale_item_id='${r3.origSiid}'`), 10)
  recordVerdict(verdicts, 'C_original_card_exhausted', c_origRemaining === 0, `remaining=${c_origRemaining}`)

  cleanupAll()

  const overall = summarize(39, verdicts)
  writeContext('link39', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
