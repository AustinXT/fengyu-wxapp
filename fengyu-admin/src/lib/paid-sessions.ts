
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { saleItems } from '@db/order'

type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function computePaidSessionsForItem({
  itemReceived,
  itemSaleAmount,
  itemSessionCount,
  orderTotal,
  orderRefunded,
}: {
  itemReceived: number | string
  itemSaleAmount: number | string
  itemSessionCount: number | null
  orderTotal: number | string
  orderRefunded?: number | string
}): number | null {
  if (itemSessionCount == null) return null
  const sa = Number(itemSaleAmount) || 0
  if (sa <= 0) return Number(itemSessionCount)
  const tot = Number(orderTotal) || 0
  if (tot <= 0) return Number(itemSessionCount)
  const itemRefundShare = tot > 0 ? (Number(orderRefunded) || 0) * sa / tot : 0
  const itemSettled = Math.max(0, (Number(itemReceived) || 0) - itemRefundShare)
  
  return Math.max(0, Math.min(Number(itemSessionCount), Math.floor(itemSettled * Number(itemSessionCount) / sa)))
}


export const PAID_SESSIONS_RECALC_SQL = `UPDATE sale_items
SET paid_sessions = CASE
  WHEN sale_items.session_count IS NULL THEN NULL
  WHEN op.total_amount <= 0 THEN sale_items.session_count
  WHEN sale_items.sale_amount <= 0 THEN sale_items.session_count
  ELSE LEAST(sale_items.session_count, FLOOR(sale_items.received::numeric * sale_items.session_count / sale_items.sale_amount::numeric)::integer)
END,
updated_at = NOW()
FROM (SELECT total_amount FROM sale_orders WHERE sale_order_id = $1) op
WHERE sale_items.sale_order_id = $1`


export const paidUnusedSessionsExpr = sql<number>`CASE WHEN ${saleItems.paidSessions} IS NULL THEN ${saleItems.remainingSessions} ELSE GREATEST(COALESCE(${saleItems.paidSessions}, 0) - GREATEST(${saleItems.sessionCount} - ${saleItems.remainingSessions}, 0), 0) END`.as('paid_unused_sessions')


export async function recalcPaidSessionsForOrder(tx: AdminTx, saleOrderId: string): Promise<void> {
  
  
  
  
  
  
  const covRes = await tx.execute(sql`
    SELECT COALESCE((SELECT SUM(amount::numeric) FROM sale_payment_allocatable_items WHERE sale_order_id = ${saleOrderId}), 0) AS spai_total,
           (SELECT received::numeric FROM sale_orders WHERE sale_order_id = ${saleOrderId}) AS order_received
  `)
  
  
  const covRows = covRes as unknown as Array<{ spai_total: string; order_received: string }>
  const spaiTotal = Number(covRows[0]?.spai_total || 0)
  const orderReceived = Number(covRows[0]?.order_received || 0)
  
  
  const hasSpai = spaiTotal > 0 && spaiTotal >= orderReceived - 0.01
  if (hasSpai) {
    
    await tx.execute(sql`
      UPDATE sale_items si
      SET received = COALESCE(GREATEST(0, (
        SELECT SUM(amount::numeric) FROM sale_payment_allocatable_items spai
         WHERE spai.sale_order_id = ${saleOrderId} AND spai.sale_item_id = si.sale_item_id
      )), 0),
      updated_at = NOW()
      WHERE si.sale_order_id = ${saleOrderId} AND si.item_direction = '购买'
    `)
  } else {
    
    await tx.execute(sql`
      WITH tg AS (
        SELECT ref_sale_item_id, SUM(amount) AS targeted
        FROM sale_order_payments
        WHERE sale_order_id = ${saleOrderId} AND status = '已支付'
          AND change_type IN ('首次支付','回款','储值卡抵扣') AND ref_sale_item_id IS NOT NULL
        GROUP BY ref_sale_item_id
      ),
      caps AS (
        SELECT si.sale_item_id,
               COALESCE(tg.targeted, 0)::numeric AS targeted,
               GREATEST(0, si.pending_received::numeric - COALESCE(tg.targeted, 0)::numeric) AS pend_cap,
               GREATEST(0, si.sale_amount::numeric - GREATEST(si.pending_received::numeric, COALESCE(tg.targeted, 0)::numeric)) AS sale_cap
        FROM sale_items si
        LEFT JOIN tg ON tg.ref_sale_item_id = si.sale_item_id
        WHERE si.sale_order_id = ${saleOrderId} AND si.item_direction = '购买'
      ),
      agg AS (
        SELECT GREATEST(0, (SELECT received FROM sale_orders WHERE sale_order_id = ${saleOrderId})::numeric - COALESCE((SELECT SUM(targeted) FROM tg), 0)::numeric) AS untargeted,
               COALESCE(SUM(pend_cap), 0)::numeric AS pend_cap_total,
               COALESCE(SUM(sale_cap), 0)::numeric AS sale_cap_total
        FROM caps
      )
      UPDATE sale_items si
      SET received = CASE
            WHEN agg.pend_cap_total > 0 OR agg.sale_cap_total > 0
              THEN caps.targeted
                + ROUND(
                    (CASE WHEN agg.pend_cap_total > 0
                          THEN LEAST(agg.untargeted, agg.pend_cap_total) * caps.pend_cap / agg.pend_cap_total
                          ELSE 0 END)
                  + (CASE WHEN agg.sale_cap_total > 0 AND agg.untargeted > agg.pend_cap_total
                          THEN (agg.untargeted - agg.pend_cap_total) * caps.sale_cap / agg.sale_cap_total
                          ELSE 0 END), 2)
            ELSE caps.targeted
          END,
          updated_at = NOW()
      FROM caps, agg
      WHERE si.sale_item_id = caps.sale_item_id
    `)
  }

  
  
  
  await tx.execute(sql`
    WITH refund_items AS (
      SELECT elem ->> 'refSaleItemId' AS sale_item_id,
             COALESCE((elem ->> 'refundAmount')::numeric, 0) AS refund_amount
      FROM sale_order_payments sop
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN sop.note LIKE '{%'
             THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                       THEN (sop.note)::jsonb -> 'items'
                       ELSE '[]'::jsonb END
             ELSE '[]'::jsonb END
      ) AS elem
      WHERE sop.sale_order_id = ${saleOrderId} AND sop.change_type = '退款' AND sop.status = '已支付'
    ),
    agg AS (
      SELECT sale_item_id, SUM(refund_amount) AS refunded
      FROM refund_items WHERE sale_item_id IS NOT NULL GROUP BY sale_item_id
    )
    UPDATE sale_items si
    SET received = GREATEST(0, si.received::numeric - COALESCE(agg.refunded, 0)),
        updated_at = NOW()
    FROM (SELECT sale_item_id FROM sale_items WHERE sale_order_id = ${saleOrderId} AND item_direction = '购买') ai
    LEFT JOIN agg ON agg.sale_item_id = ai.sale_item_id
    WHERE si.sale_item_id = ai.sale_item_id
  `)

  
  await tx.execute(sql`
    UPDATE sale_items
    SET paid_sessions = CASE
      WHEN sale_items.session_count IS NULL THEN NULL
      WHEN op.total_amount <= 0 THEN sale_items.session_count
      WHEN sale_items.sale_amount <= 0 THEN sale_items.session_count
      ELSE LEAST(sale_items.session_count, FLOOR(sale_items.received::numeric * sale_items.session_count / sale_items.sale_amount::numeric)::integer)
    END,
    updated_at = NOW()
    FROM (SELECT total_amount FROM sale_orders WHERE sale_order_id = ${saleOrderId}) op
    WHERE sale_items.sale_order_id = ${saleOrderId}
  `)
  const violation = await tx.execute(sql`
    SELECT sale_item_id, session_count, remaining_sessions, paid_sessions
      FROM sale_items
     WHERE sale_order_id = ${saleOrderId}
       AND session_count IS NOT NULL
       AND paid_sessions IS NOT NULL
       AND (session_count - remaining_sessions) > paid_sessions
     LIMIT 1
  `)
  const rows = violation == null
    ? []
    : ((violation as unknown as { rows?: Array<Record<string, unknown>> }).rows
       ?? (violation as unknown as Array<Record<string, unknown>>))
  if (Array.isArray(rows) && rows.length > 0) {
    const r = rows[0] as { sale_item_id?: string; session_count?: number; remaining_sessions?: number; paid_sessions?: number }
    
    if (r && r.sale_item_id) {
      throw new Error(
        `CONFLICT: PAID_SESSIONS_UNDERFLOW: 订单行 ${r.sale_item_id} 退款后已支付次数(${r.paid_sessions})低于已消费次数(${Number(r.session_count) - Number(r.remaining_sessions)})，请先取消相关服务单回滚消费再退款`,
      )
    }
  }
}
