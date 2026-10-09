import { sql } from 'drizzle-orm'
import { db } from '@/db'
// #548：转换资产不是新增现金；退款冻结该行原已付份额，后续补款只解锁未退项。
export const CONVERSION_VALUE_RECALC_SQL = `WITH refund_parts AS (
  SELECT elem ->> 'refSaleItemId' AS sale_item_id, sop.id,
         COALESCE(public.try_numeric(elem ->> 'paidAmount'), 0) AS paid_value,
         COALESCE(public.try_numeric(elem ->> 'netRefundAmount'), public.try_numeric(elem ->> 'refundAmount'), 0) AS net_refund,
         GREATEST(0, COALESCE(public.try_numeric(elem ->> 'refundAmount'),0) - COALESCE(public.try_numeric(elem ->> 'netRefundAmount'),public.try_numeric(elem ->> 'refundAmount'),0)) AS retained_fee
    FROM sale_order_payments sop
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
           THEN public.try_jsonb(sop.note) -> 'items' ELSE '[]'::jsonb END) elem
   WHERE sop.sale_order_id = $1 AND sop.change_type = '退款' AND sop.status = '已支付'
     AND public.try_jsonb(sop.note) ->> 'conversionRefund' = 'true'
), frozen AS (
  SELECT DISTINCT ON (sale_item_id) sale_item_id, paid_value,
         SUM(net_refund) OVER (PARTITION BY sale_item_id) AS net_refund,
         MIN(id) OVER (PARTITION BY sale_item_id) AS first_refund_id,
         SUM(retained_fee) OVER (PARTITION BY sale_item_id) AS retained_fee
    FROM refund_parts ORDER BY sale_item_id, id
), in_items AS (
  SELECT si.sale_item_id, si.sale_amount::numeric AS sale_amount, si.received::numeric AS received,
         f.paid_value, COALESCE(f.net_refund, 0) AS net_refund,
         si.conversion_value_snapshot AS value_snapshot, COALESCE(f.retained_fee,0) AS retained_fee,
         COALESCE((SELECT SUM(fresh_spir.amount::numeric) FROM sale_payment_item_receipts fresh_spir JOIN sale_order_payments fresh_cash ON fresh_cash.id=fresh_spir.sale_payment_id
           WHERE fresh_spir.sale_item_id=si.sale_item_id AND fresh_cash.status='已支付' AND fresh_cash.change_type IN ('首次支付','回款','储值卡抵扣') AND fresh_cash.id > public.try_numeric(si.conversion_value_snapshot ->> 'lastCashPaymentId')),0) AS fresh_paid,
         COALESCE((SELECT SUM(extra_spir.amount::numeric) FROM sale_payment_item_receipts extra_spir JOIN sale_order_payments cash ON cash.id=extra_spir.sale_payment_id
           WHERE extra_spir.sale_item_id=si.sale_item_id AND cash.status='已支付' AND cash.change_type IN ('首次支付','回款','储值卡抵扣') AND cash.id > f.first_refund_id),0) AS extra_paid,
         (EXISTS (SELECT 1 FROM sale_items out_item JOIN sale_orders out_order ON out_order.sale_order_id = out_item.sale_order_id
           WHERE out_item.ref_sale_item_id = si.sale_item_id AND out_item.item_direction = '转出' AND out_order.status <> '已关闭')
          AND CASE WHEN si.product_type = '疗程卡' THEN COALESCE(si.remaining_sessions, 0) = 0
                   ELSE COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0) >= si.quantity END) AS exited
    FROM sale_items si LEFT JOIN frozen f USING (sale_item_id)
   WHERE si.sale_order_id = $1 AND si.item_direction = '转入' AND si.sale_amount::numeric > 0
), totals AS (
  SELECT so.sale_order_type,
         COALESCE((SELECT SUM(GREATEST(0, -received::numeric)) FROM sale_items WHERE sale_order_id = $1 AND item_direction = '转出'), 0)
           + GREATEST(0, so.received::numeric - GREATEST(0, so.refunded_amount::numeric - COALESCE((SELECT SUM(net_refund) FROM refund_parts),0))) AS gross_value,
         COALESCE(SUM(i.sale_amount) FILTER (WHERE NOT i.exited AND i.paid_value IS NULL), 0) AS active_total,
         COALESCE(SUM(COALESCE(i.paid_value + i.extra_paid, i.received)) FILTER (WHERE i.exited OR i.paid_value IS NOT NULL), 0) AS reserved
    FROM sale_orders so LEFT JOIN in_items i ON true
   WHERE so.sale_order_id = $1 GROUP BY so.sale_order_type, so.received, so.refunded_amount
), ranked AS (
  SELECT i.*, t.active_total,
         LEAST(t.active_total, GREATEST(0, t.gross_value - t.reserved)) AS target,
         SUM(CASE WHEN NOT i.exited AND i.paid_value IS NULL THEN i.sale_amount ELSE 0 END) OVER (ORDER BY i.sale_item_id) AS cumulative
    FROM in_items i CROSS JOIN totals t WHERE t.sale_order_type = '转换单'
), allocated AS (
  SELECT sale_item_id,
         CASE WHEN exited THEN received
              WHEN public.try_numeric(value_snapshot ->> 'lastCashPaymentId') IS NOT NULL
                THEN GREATEST(0, COALESCE(public.try_numeric(value_snapshot ->> 'valueCents'),0)/100 + retained_fee + fresh_paid)
              WHEN paid_value IS NOT NULL THEN GREATEST(0, paid_value + extra_paid - net_refund)
              WHEN active_total > 0 THEN ROUND(target * cumulative / active_total, 2)
                   - ROUND(target * (cumulative - sale_amount) / active_total, 2)
              ELSE 0 END::numeric(10,2) AS item_received
    FROM ranked
)
UPDATE sale_items si SET received = a.item_received, updated_at = NOW()
  FROM allocated a WHERE si.sale_item_id = a.sale_item_id`

export function conversionDebtSql(orderExpression: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(orderExpression)) throw new Error('INVALID_PARAMS: 非法订单引用')
  return `COALESCE((SELECT SUM(GREATEST(0, debt_item.sale_amount::numeric - debt_item.received::numeric
 - COALESCE((SELECT SUM(COALESCE(public.try_numeric(debt_part ->> 'netRefundAmount'), public.try_numeric(debt_part ->> 'refundAmount'),0)
   - COALESCE(public.try_numeric(debt_part ->> 'overpayAmount'),0))
   FROM sale_order_payments debt_refund CROSS JOIN LATERAL jsonb_array_elements(
     CASE WHEN jsonb_typeof(public.try_jsonb(debt_refund.note) -> 'items') = 'array'
          THEN public.try_jsonb(debt_refund.note) -> 'items' ELSE '[]'::jsonb END) debt_part
   WHERE debt_refund.sale_order_id = debt_item.sale_order_id AND debt_refund.change_type = '退款' AND debt_refund.status = '已支付'
     AND debt_part ->> 'refSaleItemId' = debt_item.sale_item_id),0)))
 FROM sale_items debt_item
 WHERE debt_item.sale_order_id = ${orderExpression} AND debt_item.item_direction = '转入'
   AND NOT EXISTS (SELECT 1 FROM sale_order_payments full_refund CROSS JOIN LATERAL jsonb_array_elements(
     CASE WHEN jsonb_typeof(public.try_jsonb(full_refund.note) -> 'items') = 'array'
          THEN public.try_jsonb(full_refund.note) -> 'items' ELSE '[]'::jsonb END) full_part
     WHERE full_refund.sale_order_id = debt_item.sale_order_id AND full_refund.change_type = '退款' AND full_refund.status = '已支付'
       AND full_part ->> 'refSaleItemId' = debt_item.sale_item_id AND full_part ->> 'isFullItemRefund' = 'true')
   AND NOT EXISTS (SELECT 1 FROM sale_items debt_out JOIN sale_orders debt_order ON debt_order.sale_order_id = debt_out.sale_order_id
     WHERE debt_out.ref_sale_item_id = debt_item.sale_item_id AND debt_out.item_direction = '转出' AND debt_order.status <> '已关闭')), 0)`
}

// 已有未冻结/未退款转换单保留历史 signed 分币算法；新单及退款后只用本单增量债务。
export const CONVERSION_RECEIPT_SQL = `WITH current_local_receipts AS (WITH refunded AS (
  SELECT part ->> 'refSaleItemId' AS sale_item_id,
    SUM(COALESCE(public.try_numeric(part ->> 'netRefundAmount'), public.try_numeric(part ->> 'refundAmount'), 0)
        - COALESCE(public.try_numeric(part ->> 'overpayAmount'), 0)) AS price_reduction,
    BOOL_OR(part ->> 'isFullItemRefund' = 'true') AS fully_refunded
  FROM sale_order_payments sop CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
         THEN public.try_jsonb(sop.note) -> 'items' ELSE '[]'::jsonb END) part
  WHERE sop.sale_order_id = $1 AND sop.change_type = '退款' AND sop.status = '已支付'
  GROUP BY part ->> 'refSaleItemId'
), incoming AS (
  SELECT si.*, GREATEST(0, si.sale_amount::numeric - COALESCE(r.price_reduction,0)) AS retained_price,
    COALESCE(r.fully_refunded,false) AS fully_refunded,
    (EXISTS (SELECT 1 FROM sale_items out_item JOIN sale_orders out_order ON out_order.sale_order_id = out_item.sale_order_id
      WHERE out_item.ref_sale_item_id = si.sale_item_id AND out_item.item_direction = '转出' AND out_order.status <> '已关闭')
      AND CASE WHEN si.product_type = '疗程卡' THEN COALESCE(si.remaining_sessions, 0) = 0 ELSE COALESCE(si.picked_up_quantity,0)+COALESCE(si.refunded_quantity,0)+COALESCE(si.converted_quantity,0)>=si.quantity END) AS exited,
    SUM(si.sale_amount::numeric) OVER () AS price_total,
    SUM(si.sale_amount::numeric) OVER (ORDER BY si.sale_item_id) AS price_running,
    LEAST((SELECT SUM(sale_amount::numeric) FROM sale_items WHERE sale_order_id=$1 AND item_direction='转入'),
      GREATEST(0, (SELECT received::numeric FROM sale_orders WHERE sale_order_id=$1) - $2::numeric
        + COALESCE((SELECT SUM(GREATEST(0,-received::numeric)) FROM sale_items WHERE sale_order_id=$1 AND item_direction='转出'),0))) AS value_before
  FROM sale_items si LEFT JOIN refunded r USING (sale_item_id)
  WHERE si.sale_order_id = $1 AND si.item_direction = '转入' AND si.sale_amount::numeric > 0
), capacities AS (
  SELECT *, CASE WHEN fully_refunded OR exited THEN 0 ELSE GREATEST(0, retained_price -
    CASE WHEN conversion_value_snapshot IS NOT NULL THEN received::numeric
      ELSE ROUND(value_before * price_running / price_total,2)
        - ROUND(value_before * (price_running-sale_amount::numeric) / price_total,2) END) END AS debt
  FROM incoming
), ranked AS (
  SELECT *, SUM(debt) OVER () AS debt_total, SUM(debt) OVER (ORDER BY sale_item_id) AS debt_running FROM capacities
)
SELECT sale_item_id,
  (ROUND(LEAST($2::numeric,debt_total) * debt_running / debt_total,2)
   - ROUND(LEAST($2::numeric,debt_total) * (debt_running-debt) / debt_total,2))::numeric(10,2) AS amount,
  sales_category
FROM ranked WHERE debt > 0 AND debt_total > 0 ORDER BY sale_item_id), legacy_signed_receipts AS (WITH conversion_receipt_order AS (
      SELECT so.sale_order_type,
             GREATEST(0, so.received::numeric - so.refunded_amount::numeric) AS net_received,
             COALESCE((
               SELECT SUM(GREATEST(0, -out_item.received::numeric))
               FROM sale_items out_item
               WHERE out_item.sale_order_id = $1 AND out_item.item_direction = '转出'
             ), 0)::numeric AS converted_value,
             COALESCE((
               SELECT SUM(in_item.sale_amount::numeric)
               FROM sale_items in_item
               WHERE in_item.sale_order_id = $1 AND in_item.item_direction = '转入'
                 AND in_item.sale_amount::numeric > 0
                 AND NOT (EXISTS (SELECT 1 FROM sale_items conv_out JOIN sale_orders conv_out_order ON conv_out_order.sale_order_id = conv_out.sale_order_id WHERE conv_out.ref_sale_item_id = in_item.sale_item_id AND conv_out.item_direction = '转出' AND conv_out_order.status <> '已关闭') AND (CASE WHEN in_item.product_type = '疗程卡' THEN COALESCE(in_item.remaining_sessions, 0) = 0 ELSE (COALESCE(in_item.picked_up_quantity, 0) + COALESCE(in_item.refunded_quantity, 0) + COALESCE(in_item.converted_quantity, 0)) >= in_item.quantity END))
             ), 0)::numeric AS in_total,
             COALESCE((
               SELECT SUM(in_item.received::numeric)
               FROM sale_items in_item
               WHERE in_item.sale_order_id = $1 AND in_item.item_direction = '转入'
                 AND (EXISTS (SELECT 1 FROM sale_items conv_out JOIN sale_orders conv_out_order ON conv_out_order.sale_order_id = conv_out.sale_order_id WHERE conv_out.ref_sale_item_id = in_item.sale_item_id AND conv_out.item_direction = '转出' AND conv_out_order.status <> '已关闭') AND (CASE WHEN in_item.product_type = '疗程卡' THEN COALESCE(in_item.remaining_sessions, 0) = 0 ELSE (COALESCE(in_item.picked_up_quantity, 0) + COALESCE(in_item.refunded_quantity, 0) + COALESCE(in_item.converted_quantity, 0)) >= in_item.quantity END))
             ), 0)::numeric AS waived_in_received
      FROM sale_orders so
      WHERE so.sale_order_id = $1
    ),
    ranked AS (
      SELECT si.sale_item_id,
             si.sale_amount::numeric AS item_sale_amount,
             conversion_receipt_order.in_total,
             LEAST(conversion_receipt_order.in_total,
                   GREATEST(0, conversion_receipt_order.converted_value + conversion_receipt_order.net_received
                               - conversion_receipt_order.waived_in_received)) AS target_received,
             LEAST(conversion_receipt_order.in_total,
                   GREATEST(0, conversion_receipt_order.converted_value
                     + GREATEST(0, conversion_receipt_order.net_received - $2::numeric)
                     - conversion_receipt_order.waived_in_received)) AS target_before,
             SUM(si.sale_amount::numeric) OVER (
               ORDER BY si.sale_item_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS cumulative_sale_amount
      FROM sale_items si
      CROSS JOIN conversion_receipt_order
      WHERE conversion_receipt_order.sale_order_type = '转换单'
        AND si.sale_order_id = $1
        AND si.item_direction = '转入'
        AND si.sale_amount::numeric > 0
        AND NOT (EXISTS (SELECT 1 FROM sale_items conv_out JOIN sale_orders conv_out_order ON conv_out_order.sale_order_id = conv_out.sale_order_id WHERE conv_out.ref_sale_item_id = si.sale_item_id AND conv_out.item_direction = '转出' AND conv_out_order.status <> '已关闭') AND (CASE WHEN si.product_type = '疗程卡' THEN COALESCE(si.remaining_sessions, 0) = 0 ELSE (COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0)) >= si.quantity END))
    ),
    allocated AS (
      SELECT sale_item_id,
             (
               ROUND(target_received * cumulative_sale_amount / in_total, 2)
               - ROUND(target_received * (cumulative_sale_amount - item_sale_amount) / in_total, 2)
              - (
               ROUND(target_before * cumulative_sale_amount / in_total, 2)
               - ROUND(target_before * (cumulative_sale_amount - item_sale_amount) / in_total, 2)
             ))::numeric(10, 2) AS amount
      FROM ranked
      WHERE in_total > 0
    )
    SELECT a.sale_item_id, a.amount, si.sales_category
    FROM allocated a
    JOIN sale_items si ON si.sale_item_id = a.sale_item_id
    WHERE a.amount <> 0
    ORDER BY a.sale_item_id)
SELECT sale_item_id,amount,sales_category FROM current_local_receipts WHERE (EXISTS (SELECT 1 FROM sale_items WHERE sale_order_id=$1 AND conversion_value_snapshot IS NOT NULL) OR EXISTS (SELECT 1 FROM sale_order_payments WHERE sale_order_id=$1 AND change_type='退款' AND status='已支付' AND public.try_jsonb(note)->>'conversionRefund'='true'))
UNION ALL
SELECT sale_item_id,amount,sales_category FROM legacy_signed_receipts WHERE NOT (EXISTS (SELECT 1 FROM sale_items WHERE sale_order_id=$1 AND conversion_value_snapshot IS NOT NULL) OR EXISTS (SELECT 1 FROM sale_order_payments WHERE sale_order_id=$1 AND change_type='退款' AND status='已支付' AND public.try_jsonb(note)->>'conversionRefund'='true'))
ORDER BY sale_item_id`

export async function getConversionDebt(executor: Pick<typeof db, 'execute'>, saleOrderId: string): Promise<number> {
  const rows = await executor.execute(sql`SELECT ${sql.raw(conversionDebtSql('so.sale_order_id'))} AS remaining FROM sale_orders so WHERE so.sale_order_id = ${saleOrderId}`)
  return Number((rows as unknown as Array<{ remaining: string }>)[0]?.remaining || 0)
}
