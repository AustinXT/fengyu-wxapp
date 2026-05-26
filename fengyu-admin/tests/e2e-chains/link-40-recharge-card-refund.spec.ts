/**
 * 链路 40：充值卡退款 → 余额回退 + 卡流水冲销
 *
 * 主题：充值卡退款的余额/流水恒等公式：
 *   prepaid_cards.balance ≡ Σ(card_transactions.amount × sign) for that card
 *
 *   退款冲销使用 card_transactions.type='扣款'，amount<0（chk_card_tx_amount_sign 约束）。
 *
 * 测试场景：
 *   场景 A：充值 ¥500 → 退款全额 → balance 回到原值（0 或起始）+ card_transactions 多 1 行扣款（-500）
 *   场景 B：充值 ¥500 → 已消费 ¥100 → 申请全额退款 → 验证退款失败 / 仅可退剩余 ¥400
 *
 * 测试策略：SQL 模拟 refund-cascade 行为，校验 invariant。
 *
 * 关键引用：
 *   - actions/refunds.ts approveRefund / refund-cascade.ts (储值卡回冲)
 *   - chk_card_tx_amount_sign：'充值' AND amount>0 OR '扣款' AND amount<0
 *   - prepaid_cards.uq_prepaid_cards_user：user_id 唯一
 */

import { test, expect } from '@playwright/test'
import { cleanupSaleOrder } from './_helpers/cleanup'
import {
  TOPOLOGY,
  psql, recordVerdict, summarize, writeContext, type Verdict,
} from './_helpers/scope-helpers'

const TAG = 'CHAIN40'
const CLIENT_USER = 'FY-TEST-CRON-03' // 独立顾客（无既有卡）
const CLIENT_PHONE = '13800138013'
const CLIENT_NAME = 'CRON顾客3'
const STORE_ID = TOPOLOGY.STORE_NC01
const CARD_ID = `CARD-${TAG}-CLIENT`

// 场景 A：充值 → 退款
const SOID_A = `FY-${TAG}-RCA-001`
const SIID_A = `${SOID_A}-01`
const REFUND_SOID_A = `FY-${TAG}-RCA-RF1` // 退款关联订单

// 场景 B：充值 → 部分消费 → 试图退款
const SOID_B = `FY-${TAG}-RCB-001`
const SIID_B = `${SOID_B}-01`

const RECHARGE_AMOUNT = 500

function seedRecharge(soid: string, siid: string): void {
  psql(`
    INSERT INTO sale_orders (
      sale_order_id, status, sale_order_type, market_name, store_id,
      sale_order_datetime, client_user_id, client_phone, customer_name,
      total_amount, payment_method, opened_by, created_at, updated_at,
      payable_amount, received, refunded_amount, prepaid_card_amount, paid_at
    ) VALUES (
      '${soid}', '已支付', '充值单', '南昌市场', '${STORE_ID}',
      NOW(), '${CLIENT_USER}', '${CLIENT_PHONE}', '${CLIENT_NAME}',
      ${RECHARGE_AMOUNT}, '线下', 'FY-TEST-MGR', NOW(), NOW(),
      ${RECHARGE_AMOUNT}, ${RECHARGE_AMOUNT}, 0, 0, NOW()
    )
  `)
  // 2026-05-21：充值卡 SKU 化剥离（commit 44f35b00）后，充值订单 sale_order_type='充值单' 且不生成 sale_items
  // （原 sku-007-01 充值卡 SKU 已不存在于 product_skus，FK 不通）。本 seed 不再插 sale_items——
  // 退款不变量测试只操作 prepaid_cards + card_transactions，不依赖明细行。
  void siid // 充值单无明细，siid 不再用于 sale_items 插入（保留签名兼容调用方）
  // UPSERT prepaid_cards（user_id 唯一）+ 充值 card_transaction
  psql(`
    INSERT INTO prepaid_cards (card_id, user_id, balance, created_at, updated_at)
    VALUES ('${CARD_ID}', '${CLIENT_USER}', ${RECHARGE_AMOUNT}, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET balance = prepaid_cards.balance + ${RECHARGE_AMOUNT}, updated_at=NOW()
  `)
  const realCard = psql(`SELECT card_id FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`).trim()
  psql(`
    INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
    VALUES ('${realCard}', '充值', ${RECHARGE_AMOUNT}, '${soid}', NOW())
  `)
}

function cleanup(): void {
  for (const soid of [SOID_A, SOID_B, REFUND_SOID_A]) {
    try { psql(`DELETE FROM card_transactions WHERE ref_order_id='${soid}'`) } catch {/* noop */}
    cleanupSaleOrder(soid, psql, { logPrefix: '[链路40]' })
  }
  try { psql(`DELETE FROM card_transactions WHERE card_id IN (SELECT card_id FROM prepaid_cards WHERE user_id='${CLIENT_USER}')`) } catch {/* noop */}
  try { psql(`DELETE FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`) } catch {/* noop */}
}

test.setTimeout(180_000)

test('链路40：充值卡退款 → 余额回退 + 卡流水冲销', async () => {
  const verdicts: Verdict[] = []
  cleanup()

  // ───────── 场景 A：充值 → 全额退款 ─────────
  console.log('[链路40] 场景 A: 充值 → 全额退款')
  seedRecharge(SOID_A, SIID_A)

  const a_balBefore = parseFloat(psql(`SELECT balance::text FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`))
  recordVerdict(verdicts, 'A_balance_after_recharge', a_balBefore === RECHARGE_AMOUNT,
    `expected=${RECHARGE_AMOUNT} actual=${a_balBefore}`)

  // 模拟 approveRefund：扣减 balance, 写 card_transaction (扣款, 负), 标记原订单为已退款
  const cardId = psql(`SELECT card_id FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`).trim()
  psql(`UPDATE prepaid_cards SET balance = balance - ${RECHARGE_AMOUNT}, updated_at=NOW() WHERE card_id='${cardId}'`)
  psql(`
    INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
    VALUES ('${cardId}', '扣款', ${-RECHARGE_AMOUNT}, '${SOID_A}', NOW())
  `)
  psql(`UPDATE sale_orders SET refunded_amount = ${RECHARGE_AMOUNT}, status='已支付', updated_at=NOW() WHERE sale_order_id='${SOID_A}'`)

  const a_balAfter = parseFloat(psql(`SELECT balance::text FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`))
  recordVerdict(verdicts, 'A_balance_after_refund_zero', a_balAfter === 0, `actual=${a_balAfter}`)

  // 流水恒等公式：Σ(amount) (充值正 + 扣款负) = balance
  const a_sumTxn = parseFloat(psql(`SELECT COALESCE(SUM(amount), 0)::text FROM card_transactions WHERE card_id='${cardId}'`))
  recordVerdict(verdicts, 'A_balance_eq_sum_transactions', Math.abs(a_balAfter - a_sumTxn) < 0.01,
    `balance=${a_balAfter} sumTxn=${a_sumTxn}`)

  // 退款流水行
  const a_refundTxn = parseFloat(psql(`SELECT amount::text FROM card_transactions WHERE ref_order_id='${SOID_A}' AND type='扣款'`))
  recordVerdict(verdicts, 'A_refund_transaction_neg', a_refundTxn === -RECHARGE_AMOUNT,
    `expected=${-RECHARGE_AMOUNT} actual=${a_refundTxn}`)

  // chk 约束验证：试图插入 type='充值' amount<0 应失败
  let chkPassed = true
  try {
    psql(`INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at) VALUES ('${cardId}', '充值', -50, '${SOID_A}', NOW())`)
    chkPassed = false
  } catch {
    chkPassed = true
  }
  recordVerdict(verdicts, 'A_chk_constraint_enforced', chkPassed, `约束阻止 type=充值且 amount<0`)

  // 清理 A 场景
  cleanup()

  // ───────── 场景 B：充值 → 部分消费 → 退款剩余 ─────────
  console.log('[链路40] 场景 B: 充值 → 部分消费 → 验证 chk_prepaid_balance_nonneg')
  seedRecharge(SOID_B, SIID_B)

  const cardB = psql(`SELECT card_id FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`).trim()
  // 消费 ¥100（type='扣款' amount=-100）
  psql(`UPDATE prepaid_cards SET balance = balance - 100, updated_at=NOW() WHERE card_id='${cardB}'`)
  psql(`
    INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
    VALUES ('${cardB}', '扣款', -100, '${SOID_B}', NOW())
  `)

  const b_balAfterDebit = parseFloat(psql(`SELECT balance::text FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`))
  recordVerdict(verdicts, 'B_balance_after_debit', b_balAfterDebit === RECHARGE_AMOUNT - 100,
    `expected=${RECHARGE_AMOUNT - 100} actual=${b_balAfterDebit}`)

  // 尝试退款全额 ¥500 → 应失败（chk_prepaid_balance_nonneg 阻止 balance<0）
  let overRefundBlocked = false
  try {
    psql(`UPDATE prepaid_cards SET balance = balance - 500, updated_at=NOW() WHERE card_id='${cardB}'`)
    overRefundBlocked = false
  } catch {
    overRefundBlocked = true
  }
  recordVerdict(verdicts, 'B_over_refund_blocked', overRefundBlocked,
    `chk_prepaid_balance_nonneg 阻止 balance<0`)

  // 部分退款（剩余 ¥400）应成功
  psql(`UPDATE prepaid_cards SET balance = balance - 400, updated_at=NOW() WHERE card_id='${cardB}'`)
  psql(`
    INSERT INTO card_transactions (card_id, type, amount, ref_order_id, created_at)
    VALUES ('${cardB}', '扣款', -400, '${SOID_B}', NOW())
  `)
  const b_balFinal = parseFloat(psql(`SELECT balance::text FROM prepaid_cards WHERE user_id='${CLIENT_USER}'`))
  recordVerdict(verdicts, 'B_partial_refund_balance_zero', b_balFinal === 0, `actual=${b_balFinal}`)

  // 流水恒等
  const b_sumTxn = parseFloat(psql(`SELECT COALESCE(SUM(amount), 0)::text FROM card_transactions WHERE card_id='${cardB}'`))
  recordVerdict(verdicts, 'B_balance_eq_sum_transactions', Math.abs(b_balFinal - b_sumTxn) < 0.01,
    `balance=${b_balFinal} sumTxn=${b_sumTxn}`)

  cleanup()

  const overall = summarize(40, verdicts)
  writeContext('link40', { status: overall, verdicts })

  for (const v of verdicts) {
    if (v.verdict !== 'SKIP') expect(v.verdict, `check=${v.check} actual=${v.actual}`).toBe('PASS')
  }
})
