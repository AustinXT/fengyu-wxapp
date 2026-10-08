// #548：转换资产不是新增现金；退款冻结该行原已付份额，后续补款只解锁未退项。
const CONVERSION_VALUE_RECALC_SQL = `WITH refund_parts AS (
  SELECT elem ->> 'refSaleItemId' AS sale_item_id, sop.id,
         COALESCE(public.try_numeric(elem ->> 'paidAmount'), 0) AS paid_value,
         COALESCE(public.try_numeric(elem ->> 'netRefundAmount'), public.try_numeric(elem ->> 'refundAmount'), 0) AS net_refund
    FROM sale_order_payments sop
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
           THEN public.try_jsonb(sop.note) -> 'items' ELSE '[]'::jsonb END) elem
   WHERE sop.sale_order_id = $1 AND sop.change_type = '退款' AND sop.status = '已支付'
     AND public.try_jsonb(sop.note) ->> 'conversionRefund' = 'true'
), frozen AS (
  SELECT DISTINCT ON (sale_item_id) sale_item_id, paid_value,
         SUM(net_refund) OVER (PARTITION BY sale_item_id) AS net_refund
    FROM refund_parts ORDER BY sale_item_id, id
), in_items AS (
  SELECT si.sale_item_id, si.sale_amount::numeric AS sale_amount, si.received::numeric AS received,
         f.paid_value, COALESCE(f.net_refund, 0) AS net_refund,
         (EXISTS (SELECT 1 FROM sale_items out_item JOIN sale_orders out_order ON out_order.sale_order_id = out_item.sale_order_id
           WHERE out_item.ref_sale_item_id = si.sale_item_id AND out_item.item_direction = '转出' AND out_order.status <> '已关闭')
          AND CASE WHEN si.product_type = '疗程卡' THEN COALESCE(si.remaining_sessions, 0) = 0
                   ELSE COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0) >= si.quantity END) AS exited
    FROM sale_items si LEFT JOIN frozen f USING (sale_item_id)
   WHERE si.sale_order_id = $1 AND si.item_direction = '转入' AND si.sale_amount::numeric > 0
), totals AS (
  SELECT so.sale_order_type,
         COALESCE((SELECT SUM(GREATEST(0, -received::numeric)) FROM sale_items WHERE sale_order_id = $1 AND item_direction = '转出'), 0)
           + so.received::numeric AS gross_value,
         COALESCE(SUM(i.sale_amount) FILTER (WHERE NOT i.exited AND i.paid_value IS NULL), 0) AS active_total,
         COALESCE(SUM(COALESCE(i.paid_value, i.received)) FILTER (WHERE i.exited OR i.paid_value IS NOT NULL), 0) AS reserved
    FROM sale_orders so LEFT JOIN in_items i ON true
   WHERE so.sale_order_id = $1 GROUP BY so.sale_order_type, so.received
), ranked AS (
  SELECT i.*, t.active_total,
         LEAST(t.active_total, GREATEST(0, t.gross_value - t.reserved)) AS target,
         SUM(CASE WHEN NOT i.exited AND i.paid_value IS NULL THEN i.sale_amount ELSE 0 END) OVER (ORDER BY i.sale_item_id) AS cumulative
    FROM in_items i CROSS JOIN totals t WHERE t.sale_order_type = '转换单'
), allocated AS (
  SELECT sale_item_id,
         CASE WHEN exited THEN received
              WHEN paid_value IS NOT NULL THEN GREATEST(0, paid_value - net_refund)
              WHEN active_total > 0 THEN ROUND(target * cumulative / active_total, 2)
                   - ROUND(target * (cumulative - sale_amount) / active_total, 2)
              ELSE 0 END::numeric(10,2) AS item_received
    FROM ranked
)
UPDATE sale_items si SET received = a.item_received, updated_at = NOW()
  FROM allocated a WHERE si.sale_item_id = a.sale_item_id`

function conversionDebtSql(orderExpression) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(orderExpression)) throw new Error('INVALID_PARAMS: 非法订单引用')
  return `COALESCE((SELECT SUM(GREATEST(0, debt_item.sale_amount::numeric - debt_item.received::numeric))
 FROM sale_items debt_item
 WHERE debt_item.sale_order_id = ${orderExpression} AND debt_item.item_direction = '转入'
   AND NOT EXISTS (SELECT 1 FROM sale_order_payments debt_refund CROSS JOIN LATERAL jsonb_array_elements(
     CASE WHEN jsonb_typeof(public.try_jsonb(debt_refund.note) -> 'items') = 'array'
          THEN public.try_jsonb(debt_refund.note) -> 'items' ELSE '[]'::jsonb END) debt_part
     WHERE debt_refund.sale_order_id = debt_item.sale_order_id AND debt_refund.change_type = '退款' AND debt_refund.status = '已支付'
       AND debt_part ->> 'refSaleItemId' = debt_item.sale_item_id)
   AND NOT EXISTS (SELECT 1 FROM sale_items debt_out JOIN sale_orders debt_order ON debt_order.sale_order_id = debt_out.sale_order_id
     WHERE debt_out.ref_sale_item_id = debt_item.sale_item_id AND debt_out.item_direction = '转出' AND debt_order.status <> '已关闭')), 0)`
}

module.exports = { CONVERSION_VALUE_RECALC_SQL, conversionDebtSql }

const CONVERSION_RECEIPT_SQL = `WITH refund_parts AS (
  SELECT elem ->> 'refSaleItemId' AS sale_item_id, sop.id,
         COALESCE(public.try_numeric(elem ->> 'paidAmount'), 0) AS paid_value,
         COALESCE(public.try_numeric(elem ->> 'netRefundAmount'), public.try_numeric(elem ->> 'refundAmount'), 0) AS net_refund
    FROM sale_order_payments sop
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(public.try_jsonb(sop.note) -> 'items') = 'array'
           THEN public.try_jsonb(sop.note) -> 'items' ELSE '[]'::jsonb END) elem
   WHERE sop.sale_order_id = $1 AND sop.change_type = '退款' AND sop.status = '已支付'
     AND public.try_jsonb(sop.note) ->> 'conversionRefund' = 'true'
), frozen AS (
  SELECT DISTINCT ON (sale_item_id) sale_item_id, paid_value,
         SUM(net_refund) OVER (PARTITION BY sale_item_id) AS net_refund
    FROM refund_parts ORDER BY sale_item_id, id
), in_items AS (
  SELECT si.sale_item_id, si.sale_amount::numeric AS sale_amount, si.received::numeric AS received,
         f.paid_value, COALESCE(f.net_refund, 0) AS net_refund,
         (EXISTS (SELECT 1 FROM sale_items out_item JOIN sale_orders out_order ON out_order.sale_order_id = out_item.sale_order_id
           WHERE out_item.ref_sale_item_id = si.sale_item_id AND out_item.item_direction = '转出' AND out_order.status <> '已关闭')
          AND CASE WHEN si.product_type = '疗程卡' THEN COALESCE(si.remaining_sessions, 0) = 0
                   ELSE COALESCE(si.picked_up_quantity, 0) + COALESCE(si.refunded_quantity, 0) + COALESCE(si.converted_quantity, 0) >= si.quantity END) AS exited
    FROM sale_items si LEFT JOIN frozen f USING (sale_item_id)
   WHERE si.sale_order_id = $1 AND si.item_direction = '转入' AND si.sale_amount::numeric > 0
), totals AS (
  SELECT so.sale_order_type,
         COALESCE((SELECT SUM(GREATEST(0, -received::numeric)) FROM sale_items WHERE sale_order_id = $1 AND item_direction = '转出'), 0)
           + so.received::numeric AS gross_value,
         COALESCE(SUM(i.sale_amount) FILTER (WHERE NOT i.exited AND i.paid_value IS NULL), 0) AS active_total,
         COALESCE(SUM(COALESCE(i.paid_value, i.received)) FILTER (WHERE i.exited OR i.paid_value IS NOT NULL), 0) AS reserved
    FROM sale_orders so LEFT JOIN in_items i ON true
   WHERE so.sale_order_id = $1 GROUP BY so.sale_order_type, so.received
), ranked AS (
  SELECT i.*, t.active_total,
         LEAST(t.active_total, GREATEST(0, t.gross_value - t.reserved)) AS target,
         LEAST(t.active_total, GREATEST(0, t.gross_value - $2::numeric - t.reserved)) AS target_before,
         SUM(CASE WHEN NOT i.exited AND i.paid_value IS NULL THEN i.sale_amount ELSE 0 END) OVER (ORDER BY i.sale_item_id) AS cumulative
    FROM in_items i CROSS JOIN totals t WHERE t.sale_order_type = '转换单'
)
SELECT r.sale_item_id,
       (ROUND(r.target * r.cumulative / r.active_total, 2)
        - ROUND(r.target * (r.cumulative - r.sale_amount) / r.active_total, 2)
        - ROUND(r.target_before * r.cumulative / r.active_total, 2)
        + ROUND(r.target_before * (r.cumulative - r.sale_amount) / r.active_total, 2))::numeric(10,2) AS amount,
       si.sales_category
  FROM ranked r JOIN sale_items si USING (sale_item_id)
 WHERE r.active_total > 0 AND NOT r.exited AND r.paid_value IS NULL
 ORDER BY r.sale_item_id`
module.exports.CONVERSION_RECEIPT_SQL = CONVERSION_RECEIPT_SQL

async function getConversionDebt(executor, saleOrderId) {
  const result = await executor.query(`SELECT ${conversionDebtSql('so.sale_order_id')} AS remaining FROM sale_orders so WHERE so.sale_order_id = $1`, [saleOrderId])
  const rows = result.rows || result
  return Number(rows[0]?.remaining || 0)
}
module.exports.getConversionDebt = getConversionDebt
