/**
 * STEP 7 — 5 项资金不变量守护（2026-04-26 sale-order-domain-refactor §4.6 + audit-CC1 §7）
 *
 * 背景：
 *   重构后 sale_orders.received / refunded_amount / prepaid_card_amount 均为
 *   sale_order_payments 的冗余快照；customer_points.points_balance / prepaid_cards.balance
 *   也是流水的冗余快照。任何应用层双写漏写、并发写偏、或人为脱拍都会让冗余值与
 *   流水真值漂移。本 STEP 每日只读校验 5 项不变量，发现偏差仅告警不修复（与 STEP 5
 *   auditPointsBalance / STEP 6 auditRoleTypeNulls 决策一致 — 自动修补会掩盖上游 bug）。
 *
 * 5 项不变量（详见 ticket §1.2 + audit-CC1 §7）：
 *   I1: sale_orders.received        = Σ sop[已支付, 首次支付/回款/储值卡抵扣].amount
 *   I2: sale_orders.refunded_amount = -Σ sop[已支付, 退款].amount
 *   I3: client_wechat_users.points_balance = Σ point_transactions.amount
 *   I4: prepaid_cards.balance       = Σ card_transactions.amount
 *   I5: sale_orders.payable_amount  = total_amount - prepaid_card_amount
 *
 * 容差：金额不变量（I1/I2/I4/I5）容忍 0.01 元（NUMERIC(10,2) 累加边界），
 *       积分不变量（I3）严格相等（integer，无舍入误差）。
 *
 * 告警机制（与 STEP 5/6 一致）：
 *   - operation_logs(action='cron.audit_invariants', target_type='invariant_violation')
 *     单条 INSERT，detail 含每项 violations 行数 + 前 100 条样例
 *   - 命中任意 violation 时调用 notifyOps（企微机器人）
 *   - 永远不修补（自动修复会掩盖上游 bug）
 *
 * 执行频次：每日 1 次（与 cron-worker 其他 STEP 同 03:00 串行）。
 *   ticket 原文建议"凌晨 4 点单独跑"避免与其他 STEP 争资源；当前 cron-worker
 *   STEP 串行 + 全部只读 SELECT，放在 03:00 STEP 链末尾即可，无需独立 cron 句柄。
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

const MONEY_EPSILON = 0.01

interface ViolationSample {
  invariant: string
  count: number
  samples: Array<Record<string, unknown>>
}

export interface PaymentInvariantsResult {
  violations: number
  details: ViolationSample[]
}

const SAMPLE_LIMIT = 100

export async function auditPaymentInvariants(db: Db): Promise<PaymentInvariantsResult> {
  const details: ViolationSample[] = []

  // ── I1: received = Σ sop[已支付, 首次支付/回款/储值卡抵扣].amount ──
  const r1 = (await db.execute(sql`
    SELECT so.sale_order_id,
           so.received::numeric                  AS received,
           COALESCE(SUM(sop.amount::numeric), 0) AS computed
    FROM sale_orders so
    LEFT JOIN sale_order_payments sop
      ON sop.sale_order_id = so.sale_order_id
     AND sop.status = '已支付'
     AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
    GROUP BY so.sale_order_id, so.received
    HAVING ABS(so.received::numeric - COALESCE(SUM(sop.amount::numeric), 0)) > ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ sale_order_id: string; received: string | number; computed: string | number }>
  if (r1.length > 0) {
    details.push({ invariant: 'received_eq_sum_payments', count: r1.length, samples: r1 as unknown as Array<Record<string, unknown>> })
  }

  // ── I2: refunded_amount = -Σ sop[已支付, 退款].amount ──
  const r2 = (await db.execute(sql`
    SELECT so.sale_order_id,
           so.refunded_amount::numeric             AS refunded_amount,
           COALESCE(-SUM(sop.amount::numeric), 0) AS computed
    FROM sale_orders so
    LEFT JOIN sale_order_payments sop
      ON sop.sale_order_id = so.sale_order_id
     AND sop.status = '已支付'
     AND sop.change_type = '退款'
    GROUP BY so.sale_order_id, so.refunded_amount
    HAVING ABS(so.refunded_amount::numeric - COALESCE(-SUM(sop.amount::numeric), 0)) > ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ sale_order_id: string; refunded_amount: string | number; computed: string | number }>
  if (r2.length > 0) {
    details.push({ invariant: 'refunded_amount_eq_neg_sum_refund_payments', count: r2.length, samples: r2 as unknown as Array<Record<string, unknown>> })
  }

  // ── I3: client_wechat_users.points_balance = Σ point_transactions.amount ──
  // 与 STEP 5 (audit-points-balance) 重叠，但语义独立：本处作为"5 项不变量"统一报表的一项。
  // 容差严格相等（integer 无浮点误差）。
  const r3 = (await db.execute(sql`
    WITH sums AS (
      SELECT user_id, COALESCE(SUM(amount), 0)::int AS total_from_txns
      FROM point_transactions
      GROUP BY user_id
    )
    SELECT u.user_id,
           COALESCE(u.points_balance, 0) AS cached_balance,
           COALESCE(s.total_from_txns, 0) AS expected_balance
    FROM client_wechat_users u
    LEFT JOIN sums s ON s.user_id = u.user_id
    WHERE COALESCE(u.points_balance, 0) <> COALESCE(s.total_from_txns, 0)
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ user_id: string; cached_balance: number | string; expected_balance: number | string }>
  if (r3.length > 0) {
    details.push({ invariant: 'points_balance_eq_sum_txns', count: r3.length, samples: r3 as unknown as Array<Record<string, unknown>> })
  }

  // ── I4: prepaid_cards.balance = Σ card_transactions.amount ──
  const r4 = (await db.execute(sql`
    SELECT pc.card_id,
           pc.balance::numeric                    AS balance,
           COALESCE(SUM(ct.amount::numeric), 0)  AS computed
    FROM prepaid_cards pc
    LEFT JOIN card_transactions ct ON ct.card_id = pc.card_id
    GROUP BY pc.card_id, pc.balance
    HAVING ABS(pc.balance::numeric - COALESCE(SUM(ct.amount::numeric), 0)) > ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ card_id: string; balance: string | number; computed: string | number }>
  if (r4.length > 0) {
    details.push({ invariant: 'prepaid_balance_eq_sum_card_txns', count: r4.length, samples: r4 as unknown as Array<Record<string, unknown>> })
  }

  // ── I5: payable_amount = total_amount - prepaid_card_amount ──
  // 仅校验非退款冲销链（销售单 / 内部单 / 转换单）。重构后 saleOrderType 已无 '退款单'，
  // 但保险起见仍仅在正向单上校验，未来若再加单据类型不会误报。
  const r5 = (await db.execute(sql`
    SELECT sale_order_id,
           total_amount::numeric        AS total_amount,
           prepaid_card_amount::numeric AS prepaid_card_amount,
           payable_amount::numeric      AS payable_amount
    FROM sale_orders
    WHERE ABS(payable_amount::numeric - (total_amount::numeric - prepaid_card_amount::numeric)) > ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{
    sale_order_id: string
    total_amount: string | number
    prepaid_card_amount: string | number
    payable_amount: string | number
  }>
  if (r5.length > 0) {
    details.push({ invariant: 'payable_eq_total_minus_prepaid', count: r5.length, samples: r5 as unknown as Array<Record<string, unknown>> })
  }

  if (details.length > 0) {
    // operation_logs 单条聚合写入（避免 N 条小写）。target_id 用日期戳便于查询。
    const dateStamp = new Date().toISOString().slice(0, 10)
    const detailJson = JSON.stringify({
      _v: 1,
      _t: 'invariants',
      date: dateStamp,
      total: details.length,
      violations: details,
    })
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.audit_invariants', 'invariant_violation', ${dateStamp}, ${detailJson}::jsonb, 'cronTask', NOW())
    `)

    const lines = details.map(
      (d) => `- ${d.invariant}: ${d.count} 条偏差`,
    )
    await notifyOps(
      [
        '⚠️ [cron-worker] cron.audit_invariants',
        '5 项资金不变量违规：',
        ...lines,
        '',
        `时间：${new Date().toISOString()}`,
      ].join('\n'),
    )
  }

  return { violations: details.length, details }
}
