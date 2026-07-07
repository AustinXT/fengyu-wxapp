

import { sql } from 'drizzle-orm'
import type { Db } from '../run'
import { notifyOps } from '../lib/notify'

const SAMPLE_LIMIT = 10

type CascadeChannel =
  | 'sa_not_reversed'
  | 'sc_not_voided'
  | 'coupon_not_returned'
  | 'point_not_reversed'
  | 'pickup_not_rolled_back'

interface CascadeViolation {
  channel: CascadeChannel
  count: number
  samples: Array<Record<string, unknown>>
}

export interface RefundCascadeCoverageResult {
  violations: number
  details: CascadeViolation[]
}

export async function auditRefundCascadeCoverage(db: Db): Promise<RefundCascadeCoverageResult> {
  const details: CascadeViolation[] = []

  
  
  
  const c1 = (await db.execute(sql`
    WITH refunds AS (
      SELECT sop.id AS sop_id, sop.sale_order_id, sop.ref_sale_item_id
      FROM sale_order_payments sop
      WHERE sop.change_type = '退款' AND sop.status = '已支付'
    )
    SELECT r.sop_id, r.sale_order_id, r.ref_sale_item_id
    FROM refunds r
    WHERE EXISTS (
            SELECT 1 FROM sale_items si
            JOIN sale_allocations sa ON sa.sale_item_id = si.sale_item_id
            WHERE (
                    (r.ref_sale_item_id IS NOT NULL AND si.sale_item_id = r.ref_sale_item_id)
                 OR (r.ref_sale_item_id IS NULL     AND si.sale_order_id = r.sale_order_id)
                  )
              AND sa.is_void = false AND sa.total_amount > 0
          )
      AND NOT EXISTS (
            SELECT 1 FROM sale_allocations sa
            WHERE sa.sale_payment_id = r.sop_id AND sa.total_amount < 0
          )
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c1.length > 0) {
    details.push({ channel: 'sa_not_reversed', count: c1.length, samples: c1 })
  }

  
  const c2 = (await db.execute(sql`
    WITH refunds AS (
      SELECT sop.id AS sop_id, sop.sale_order_id, sop.ref_sale_item_id
      FROM sale_order_payments sop
      WHERE sop.change_type = '退款' AND sop.status = '已支付'
    ),
    sc_status AS (
      SELECT r.sop_id, r.sale_order_id, r.ref_sale_item_id,
             COUNT(*) FILTER (WHERE sc.voided_at IS NOT NULL) AS voided,
             COUNT(sc.id)                                      AS total
      FROM refunds r
      LEFT JOIN sale_items s
        ON (r.ref_sale_item_id IS NOT NULL AND s.sale_item_id = r.ref_sale_item_id)
        OR (r.ref_sale_item_id IS NULL     AND s.sale_order_id = r.sale_order_id)
      LEFT JOIN service_items si ON si.sale_item_id = s.sale_item_id
      LEFT JOIN service_commissions sc ON sc.service_item_id = si.service_item_id
      GROUP BY r.sop_id, r.sale_order_id, r.ref_sale_item_id
    )
    SELECT sop_id, sale_order_id, ref_sale_item_id
    FROM sc_status
    WHERE total > 0 AND voided = 0
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c2.length > 0) {
    details.push({ channel: 'sc_not_voided', count: c2.length, samples: c2 })
  }

  
  
  
  const c3 = (await db.execute(sql`
    WITH refunds AS (
      SELECT sop.id AS sop_id, sop.sale_order_id, sop.paid_at
      FROM sale_order_payments sop
      WHERE sop.change_type = '退款' AND sop.status = '已支付'
        AND sop.paid_at IS NOT NULL
    )
    SELECT r.sop_id, r.sale_order_id
    FROM refunds r
    WHERE EXISTS (
      SELECT 1 FROM user_coupons uc
      WHERE uc.used_sale_order_id = r.sale_order_id
        AND uc.status = '已使用'
        AND uc.expire_at > r.paid_at
    )
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c3.length > 0) {
    details.push({ channel: 'coupon_not_returned', count: c3.length, samples: c3 })
  }

  
  
  
  
  const c4 = (await db.execute(sql`
    WITH refunds AS (
      SELECT DISTINCT sop.sale_order_id
      FROM sale_order_payments sop
      WHERE sop.change_type = '退款' AND sop.status = '已支付'
    )
    SELECT r.sale_order_id, MIN(pt_pos.user_id) AS user_id
    FROM refunds r
    JOIN point_transactions pt_pos
      ON pt_pos.ref_order_id = r.sale_order_id
     AND pt_pos.type IN ('消费赠送','回款赠送','获取')
     AND pt_pos.amount > 0
    WHERE NOT EXISTS (
      SELECT 1 FROM point_transactions pt_neg
      WHERE pt_neg.ref_order_id = r.sale_order_id
        AND pt_neg.type = '消费冲销'
    )
    GROUP BY r.sale_order_id
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c4.length > 0) {
    details.push({ channel: 'point_not_reversed', count: c4.length, samples: c4 })
  }

  
  
  
  
  const c5 = (await db.execute(sql`
    WITH refunds AS (
      SELECT sop.id AS sop_id, sop.sale_order_id, sop.ref_sale_item_id
      FROM sale_order_payments sop
      WHERE sop.change_type = '退款' AND sop.status = '已支付'
    )
    SELECT r.sop_id, s.sale_item_id,
           COALESCE(s.picked_up_quantity, 0) AS current_picked,
           (SELECT COALESCE(SUM(pr.pickup_quantity), 0)
            FROM pickup_records pr
            WHERE pr.sale_item_id = s.sale_item_id) AS total_picked
    FROM refunds r
    JOIN sale_items s
      ON (r.ref_sale_item_id IS NOT NULL AND s.sale_item_id = r.ref_sale_item_id)
      OR (r.ref_sale_item_id IS NULL     AND s.sale_order_id = r.sale_order_id)
    WHERE EXISTS (
      SELECT 1 FROM pickup_records pr WHERE pr.sale_item_id = s.sale_item_id
    )
      AND COALESCE(s.picked_up_quantity, 0) >= (
        SELECT COALESCE(SUM(pr.pickup_quantity), 0)
        FROM pickup_records pr
        WHERE pr.sale_item_id = s.sale_item_id
      )
    LIMIT ${SAMPLE_LIMIT}
  `)) as Array<Record<string, unknown>>
  if (c5.length > 0) {
    details.push({ channel: 'pickup_not_rolled_back', count: c5.length, samples: c5 })
  }

  if (details.length > 0) {
    const dateStamp = new Date().toISOString().slice(0, 10)
    const detailJson = JSON.stringify({
      _v: 1,
      _t: 'refund_cascade_coverage',
      date: dateStamp,
      total: details.length,
      violations: details,
    })
    await db.execute(sql`
      INSERT INTO operation_logs (action, target_type, target_id, detail, source, created_at)
      VALUES ('cron.audit_refund_cascade', 'cascade_violation', ${dateStamp},
              ${detailJson}::jsonb, 'cronTask', NOW())
    `)

    const lines = details.map((d) => `- ${d.channel}: ${d.count} 条 mismatch`)
    await notifyOps(
      [
        '⚠️ [cron-worker] cron.audit_refund_cascade',
        '退款 5 通道级联巡检发现 mismatch：',
        ...lines,
        '',
        `时间：${new Date().toISOString()}`,
      ].join('\n'),
    )
  }

  return { violations: details.length, details }
}
