

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

  
  const r2b = (await db.execute(sql`
    SELECT so.sale_order_id,
           so.received::numeric        AS received,
           so.refunded_amount::numeric AS refunded_amount
    FROM sale_orders so
    WHERE so.refunded_amount::numeric > so.received::numeric + ${MONEY_EPSILON}
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<{ sale_order_id: string; received: string | number; refunded_amount: string | number }>
  if (r2b.length > 0) {
    details.push({ invariant: 'refunded_le_received', count: r2b.length, samples: r2b as unknown as Array<Record<string, unknown>> })
  }

  
  
  
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

  
  
  
  
  
  const r5 = (await db.execute(sql`
    SELECT sale_order_id,
           total_amount::numeric        AS total_amount,
           prepaid_card_amount::numeric AS prepaid_card_amount,
           payable_amount::numeric      AS payable_amount
    FROM sale_orders
    WHERE sale_order_type IN ('销售单','内部单','转换单','寄存单')
      AND ABS(payable_amount::numeric - (total_amount::numeric - prepaid_card_amount::numeric)) > ${MONEY_EPSILON}
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
