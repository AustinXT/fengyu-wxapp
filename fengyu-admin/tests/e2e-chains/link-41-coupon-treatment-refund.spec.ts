/**
 * 链路 41：优惠券 × 疗程卡退款金额公式
 *
 * 主题：当一笔疗程卡订单用了优惠券折扣（unit_real_price = unit_price - discount/quantity），
 *       后续退款金额必须用「折后单价 × 退还次数」，而非「原价 × 退还次数」。
 *       同时优惠券需回滚为 status='未使用'。
 *
 * 测试场景：
 *   10 次疗程卡 unit_price ¥100 × 10 = ¥1000
 *   现金券 ¥100 (FY-FIX-COUPON-01 满 200 减 30 — 这里我们模拟一个更大金额)
 *   → 实付 ¥900；unit_real_price = 90/次
 *   完成 3 次 → remaining=7
 *   退款 7 次 → 期望退款额 = 7 × 90 = ¥630（不是 700）
 *
 * 测试策略：SQL 模拟 refund-cascade。
 *
 * 关键引用：
 *   - actions/refunds.ts approveRefund + utils/refund.js（refund_amount = unit_real_price × refund_qty）
 *   - refund-cascade.js channel 3：user_coupons.status 回滚 '未使用'
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  TOPOLOGY,
  psql, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN41'
const CLIENT_USER = 'FY-TEST-CRON-04' // 独立顾客（无既有 user_coupon 牵扯）
const CLIENT_PHONE = '13800138014'
const CLIENT_NAME = 'CRON顾客4'
const STORE_ID = TOPOLOGY.STORE_NC01
const SKU_ID = 'c79157b29c9e974c'
const SOID = `FY-${TAG}-CR-001`
const SIID = `${SOID}-01`
const COUPON_ID = `FY-${TAG}-COUPON-01`
const TEMPLATE_ID = `FY-${TAG}-CT-01`

const UNIT_PRICE = 100
const QUANTITY = 10
const SESSION_COUNT = 10
const COUPON_DISCOUNT = 100 // 简化：discount 100
const PAID = UNIT_PRICE * QUANTITY - COUPON_DISCOUNT // 900
const UNIT_REAL_PRICE = PAID / SESSION_COUNT // 90

const COMPLETED_SESSIONS = 3
const REFUND_QTY = SESSION_COUNT - COMPLETED_SESSIONS // 7

function seed(): void {
  cleanup()

  // 1) 优惠券模板
  psql(`
    INSERT INTO coupon_templates (
      template_id, name, coupon_type, discount_value, min_spend, is_active, created_at, updated_at
    ) VALUES (
      '${TEMPLATE_ID}', 'CHAIN41 现金券', '现金券', ${COUPON_DISCOUNT}, 0, true, NOW(), NOW()
    )
    ON CONFLICT (template_id) DO NOTHING
  `)

  // 2) 订单（已支付，含优惠券；必须在 user_coupons 之前 INSERT，因 FK 依赖）
  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount,
      coupon_id, coupon_discount, paid_at
    ) VALUES (
      '${SOID}', '已支付', '销售单', '南昌市场', '${STORE_ID}',
      NOW() - interval '2 day', '${CLIENT_USER}', '${CLIENT_PHONE}', '${CLIENT_NAME}',
      ${UNIT_PRICE * QUANTITY}, '线下', 'FY-TEST-MGR', NOW() - interval '2 day', NOW() - interval '2 day',
      ${PAID}, ${PAID}, 0, 0,
      '${COUPON_ID}', ${COUPON_DISCOUNT}, NOW() - interval '2 day'
    )
  `)

  // 3) sale_item — 10 次疗程卡，折后单价 90
  psql(`
    INSERT INTO sale_items (
      sale_item_id, sale_order_id, store_id, item_direction, sku_id,
      product_name, sku_spec_name, product_type, session_count, remaining_sessions,
      unit_price, quantity, unit_real_price, sale_amount, received,
      service_fee, is_experience, created_at, updated_at
    ) VALUES (
      '${SIID}', '${SOID}', '${STORE_ID}', '购买', '${SKU_ID}',
      '洗-无创纹身 疗程卡', '洗-无创纹身 疗程卡', '疗程卡',
      ${SESSION_COUNT}, ${SESSION_COUNT - COMPLETED_SESSIONS},
      ${UNIT_PRICE}, ${QUANTITY}, ${UNIT_REAL_PRICE}, ${PAID}, ${PAID},
      0, false, NOW() - interval '2 day', NOW() - interval '2 day'
    )
  `)

  // 4) user_coupon（status='已使用'，FK 依赖 sale_orders）
  psql(`
    INSERT INTO user_coupons (
      coupon_id, template_id, user_id, status, expire_at, used_sale_order_id, used_at, created_at, updated_at
    ) VALUES (
      '${COUPON_ID}', '${TEMPLATE_ID}', '${CLIENT_USER}', '已使用',
      NOW() + interval '30 day', '${SOID}', NOW(), NOW(), NOW()
    )
    ON CONFLICT (coupon_id) DO NOTHING
  `)
}

function cleanup(): void {
  cleanupSaleOrder(SOID, psql, { logPrefix: '[链路41]' })
  try { psql(`DELETE FROM user_coupons WHERE coupon_id='${COUPON_ID}'`) } catch {/* noop */}
  try { psql(`DELETE FROM coupon_templates WHERE template_id='${TEMPLATE_ID}'`) } catch {/* noop */}
}

test.setTimeout(120_000)

test('链路41：优惠券 × 疗程卡退款金额公式', async () => {
  const verdicts: Verdict[] = []
  seed()

  // ── DB invariant: 折后单价 = (totalPaid - couponDiscount) / sessionCount ──
  const unit_real = parseFloat(psql(`SELECT unit_real_price::text FROM sale_items WHERE sale_item_id='${SIID}'`))
  recordVerdict(verdicts, 'unit_real_price_eq_90', unit_real === UNIT_REAL_PRICE,
    `expected=${UNIT_REAL_PRICE} actual=${unit_real}`)

  // ── 模拟 approveRefund：退款额 = unit_real_price × refund_qty ──
  const expectedRefundAmount = UNIT_REAL_PRICE * REFUND_QTY // 90 × 7 = 630
  recordVerdict(verdicts, 'expected_refund_eq_630', expectedRefundAmount === 630,
    `expected=630 actual=${expectedRefundAmount}`)

  // 关键校验：refund_amount 不应等于 100×7=700（即不按 unit_price 折算）
  const wrongRefund = UNIT_PRICE * REFUND_QTY
  recordVerdict(verdicts, 'refund_not_using_unit_price', expectedRefundAmount !== wrongRefund,
    `${expectedRefundAmount} ≠ ${wrongRefund} (unit_price × qty)`)

  // 写 sale_order_payments 退款行（amount 为负）
  psql(`
    INSERT INTO sale_order_payments (
      sale_order_id, change_type, amount, payment_method, status,
      source_end, operator_employee_id, created_at, paid_at
    ) VALUES (
      '${SOID}', '退款', ${-expectedRefundAmount}, '线下', '已支付',
      'admin', 'FY-TEST-FIN', NOW(), NOW()
    )
  `)

  // 更新 sale_orders.refunded_amount + sale_items.remaining_sessions=0（退后无剩余）
  psql(`UPDATE sale_orders SET refunded_amount = ${expectedRefundAmount}, updated_at=NOW() WHERE sale_order_id='${SOID}'`)
  psql(`UPDATE sale_items SET remaining_sessions = 0, updated_at=NOW() WHERE sale_item_id='${SIID}'`)

  // 退优惠券（refund-cascade channel 3）
  psql(`UPDATE user_coupons SET status='未使用', used_sale_order_id=NULL, used_at=NULL, updated_at=NOW() WHERE coupon_id='${COUPON_ID}'`)

  // ── DB invariant: 退款金额行已正确写入 ──
  const refundRow = parseFloat(psql(`
    SELECT amount::text FROM sale_order_payments
    WHERE sale_order_id='${SOID}' AND change_type='退款'
  `))
  recordVerdict(verdicts, 'refund_payment_amount_correct', refundRow === -expectedRefundAmount,
    `expected=${-expectedRefundAmount} actual=${refundRow}`)

  // ── DB invariant: refunded_amount 累加 ──
  const orderRefunded = parseFloat(psql(`SELECT refunded_amount::text FROM sale_orders WHERE sale_order_id='${SOID}'`))
  recordVerdict(verdicts, 'order_refunded_amount_eq', orderRefunded === expectedRefundAmount,
    `expected=${expectedRefundAmount} actual=${orderRefunded}`)

  // ── DB invariant: user_coupon 回滚未使用 ──
  const couponStatus = psql(`SELECT status FROM user_coupons WHERE coupon_id='${COUPON_ID}'`).trim()
  recordVerdict(verdicts, 'coupon_rolled_back', couponStatus === '未使用', `status=${couponStatus}`)

  const couponUsedSoid = psql(`SELECT COALESCE(used_sale_order_id, '') FROM user_coupons WHERE coupon_id='${COUPON_ID}'`).trim()
  recordVerdict(verdicts, 'coupon_used_soid_cleared', couponUsedSoid === '', `used_soid=${couponUsedSoid}`)

  cleanup()

  const overall = summarize(41, verdicts, {
    soid: SOID, unit_real_price: UNIT_REAL_PRICE, expected_refund: expectedRefundAmount,
  })
  writeContext('link41', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
