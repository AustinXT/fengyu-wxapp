CREATE TEMP TABLE IF NOT EXISTS _0086_overpay_receipt_mappings (
  sale_payment_id BIGINT NOT NULL,
  sale_order_id VARCHAR(30) NOT NULL,
  sale_item_id VARCHAR(30) NOT NULL,
  amount_cents INTEGER NOT NULL,
  sales_category sales_category,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (sale_payment_id, sale_item_id)
) ON COMMIT PRESERVE ROWS;
--> statement-breakpoint
TRUNCATE _0086_overpay_receipt_mappings;
--> statement-breakpoint
WITH overpay_refunds AS (
  SELECT sop.id AS sale_payment_id,
         sop.sale_order_id,
         SUM(ROUND(COALESCE((elem ->> 'refundAmount')::numeric, 0) * 100)::integer) AS overpay_cents,
         MIN(COALESCE(sop.paid_at, sop.created_at, NOW())) AS created_at
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN sop.note LIKE '{%'
           THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                     THEN (sop.note)::jsonb -> 'items'
                     ELSE '[]'::jsonb END
           ELSE '[]'::jsonb END
    ) AS elem
   WHERE sop.change_type = '退款'
     AND sop.status = '已支付'
     AND sop.amount::numeric < 0
     AND so.sale_order_type IN ('销售单','转换单')
     AND so.legacy_source IS DISTINCT FROM 'workfine'
     AND (elem ->> 'refSaleItemId' = 'OVERPAY'
          OR LOWER(COALESCE(elem ->> 'isOverpay', 'false')) = 'true')
     AND COALESCE((elem ->> 'refundAmount')::numeric, 0) > 0
   GROUP BY sop.id, sop.sale_order_id
),
real_refund_cents AS (
  SELECT sop.id AS sale_payment_id,
         elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(ROUND(COALESCE((elem ->> 'refundAmount')::numeric, 0) * 100)::integer) AS refund_cents
    FROM sale_order_payments sop
    JOIN overpay_refunds opr ON opr.sale_payment_id = sop.id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN sop.note LIKE '{%'
           THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                     THEN (sop.note)::jsonb -> 'items'
                     ELSE '[]'::jsonb END
           ELSE '[]'::jsonb END
    ) AS elem
   WHERE elem ->> 'refSaleItemId' IS NOT NULL
     AND elem ->> 'refSaleItemId' <> 'OVERPAY'
     AND LOWER(COALESCE(elem ->> 'isOverpay', 'false')) <> 'true'
     AND COALESCE((elem ->> 'refundAmount')::numeric, 0) > 0
   GROUP BY sop.id, elem ->> 'refSaleItemId'
),
item_residuals AS (
  SELECT opr.sale_payment_id,
         opr.sale_order_id,
         si.sale_item_id,
         si.sales_category,
         opr.created_at,
         opr.overpay_cents,
         GREATEST(
           0,
           ROUND((COALESCE(receipts.positive_amount, 0) - COALESCE(receipts.prior_refund_amount, 0)) * 100)::integer
             - COALESCE(rr.refund_cents, 0)
         ) AS residual_cents
    FROM overpay_refunds opr
    JOIN sale_items si
      ON si.sale_order_id = opr.sale_order_id
     AND si.item_direction = '购买'
    LEFT JOIN real_refund_cents rr
      ON rr.sale_payment_id = opr.sale_payment_id
     AND rr.sale_item_id = si.sale_item_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(CASE
               WHEN sop2.status = '已支付'
                AND sop2.change_type IN ('首次支付','回款','储值卡抵扣')
               THEN spir.amount::numeric ELSE 0 END), 0) AS positive_amount,
             COALESCE(ABS(SUM(CASE
               WHEN sop2.status = '已支付'
                AND sop2.change_type = '退款'
                AND spir.sale_payment_id IS DISTINCT FROM opr.sale_payment_id
               THEN spir.amount::numeric ELSE 0 END)), 0) AS prior_refund_amount
        FROM sale_payment_item_receipts spir
        JOIN sale_order_payments sop2 ON sop2.id = spir.sale_payment_id
       WHERE spir.sale_order_id = opr.sale_order_id
         AND spir.sale_item_id = si.sale_item_id
    ) receipts ON TRUE
),
eligible AS (
  SELECT *,
         SUM(residual_cents) OVER (PARTITION BY sale_payment_id) AS residual_total_cents,
         LEAST(overpay_cents, SUM(residual_cents) OVER (PARTITION BY sale_payment_id)) AS target_cents
    FROM item_residuals
   WHERE residual_cents > 0
),
weighted AS (
  SELECT *,
         FLOOR(target_cents::numeric * residual_cents::numeric / NULLIF(residual_total_cents, 0))::integer AS base_cents,
         (target_cents::numeric * residual_cents::numeric / NULLIF(residual_total_cents, 0))
           - FLOOR(target_cents::numeric * residual_cents::numeric / NULLIF(residual_total_cents, 0)) AS frac
    FROM eligible
   WHERE target_cents > 0
     AND residual_total_cents > 0
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY sale_payment_id ORDER BY frac DESC, sale_item_id) AS rn,
         target_cents - SUM(base_cents) OVER (PARTITION BY sale_payment_id) AS rem_cents
    FROM weighted
)
INSERT INTO _0086_overpay_receipt_mappings
  (sale_payment_id, sale_order_id, sale_item_id, amount_cents, sales_category, created_at)
SELECT sale_payment_id,
       sale_order_id,
       sale_item_id,
       base_cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END AS amount_cents,
       sales_category,
       created_at
  FROM ranked
 WHERE base_cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END > 0
ON CONFLICT (sale_payment_id, sale_item_id)
DO UPDATE SET amount_cents = EXCLUDED.amount_cents,
              sales_category = EXCLUDED.sales_category,
              created_at = EXCLUDED.created_at;
--> statement-breakpoint
WITH real_refund_items AS (
  SELECT sop.id AS sale_payment_id,
         sop.sale_order_id,
         elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(ROUND(COALESCE((elem ->> 'refundAmount')::numeric, 0) * 100)::integer) AS amount_cents,
         MIN(COALESCE(sop.paid_at, sop.created_at, NOW())) AS created_at
    FROM sale_order_payments sop
    JOIN (SELECT DISTINCT sale_payment_id FROM _0086_overpay_receipt_mappings) m
      ON m.sale_payment_id = sop.id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN sop.note LIKE '{%'
           THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                     THEN (sop.note)::jsonb -> 'items'
                     ELSE '[]'::jsonb END
           ELSE '[]'::jsonb END
    ) AS elem
   WHERE elem ->> 'refSaleItemId' IS NOT NULL
     AND elem ->> 'refSaleItemId' <> 'OVERPAY'
     AND LOWER(COALESCE(elem ->> 'isOverpay', 'false')) <> 'true'
     AND COALESCE((elem ->> 'refundAmount')::numeric, 0) > 0
   GROUP BY sop.id, sop.sale_order_id, elem ->> 'refSaleItemId'
),
receipt_targets AS (
  SELECT sale_payment_id,
         sale_order_id,
         sale_item_id,
         SUM(amount_cents) AS amount_cents,
         MIN(created_at) AS created_at
    FROM (
      SELECT sale_payment_id, sale_order_id, sale_item_id, amount_cents, created_at
        FROM real_refund_items
      UNION ALL
      SELECT sale_payment_id, sale_order_id, sale_item_id, amount_cents, created_at
        FROM _0086_overpay_receipt_mappings
    ) x
   GROUP BY sale_payment_id, sale_order_id, sale_item_id
)
INSERT INTO sale_payment_item_receipts
  (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
SELECT rt.sale_payment_id,
       rt.sale_order_id,
       rt.sale_item_id,
       ROUND(-(rt.amount_cents::numeric) / 100, 2),
       si.sales_category,
       rt.created_at
  FROM receipt_targets rt
  JOIN sale_items si
    ON si.sale_order_id = rt.sale_order_id
   AND si.sale_item_id = rt.sale_item_id
   AND si.item_direction = '购买'
 WHERE rt.amount_cents > 0
ON CONFLICT (sale_payment_id, sale_item_id)
DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category;
--> statement-breakpoint
WITH touched_orders AS (
  SELECT DISTINCT sale_order_id FROM _0086_overpay_receipt_mappings
)
UPDATE sale_items si
   SET received = COALESCE(GREATEST(0, (
         SELECT SUM(spir.amount::numeric)
           FROM sale_payment_item_receipts spir
           JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
          WHERE spir.sale_order_id = si.sale_order_id
            AND spir.sale_item_id = si.sale_item_id
            AND sop.status = '已支付'
            AND sop.change_type IN ('首次支付','回款','储值卡抵扣','退款')
       )), 0),
       updated_at = NOW()
  FROM touched_orders t
 WHERE si.sale_order_id = t.sale_order_id
   AND si.item_direction = '购买';
--> statement-breakpoint
WITH touched_orders AS (
  SELECT DISTINCT sale_order_id FROM _0086_overpay_receipt_mappings
)
UPDATE sale_items si
   SET paid_sessions = CASE
         WHEN si.session_count IS NULL THEN NULL
         WHEN so.total_amount::numeric <= 0 THEN si.session_count
         WHEN si.sale_amount::numeric <= 0 THEN si.session_count
         ELSE LEAST(si.session_count, FLOOR(si.received::numeric * si.session_count / si.sale_amount::numeric)::integer)
       END,
       updated_at = NOW()
  FROM sale_orders so, touched_orders t
 WHERE si.sale_order_id = so.sale_order_id
   AND si.sale_order_id = t.sale_order_id;
--> statement-breakpoint
WITH touched_orders AS (
  SELECT DISTINCT sale_order_id FROM _0086_overpay_receipt_mappings
),
full_refund_zero_items AS (
  SELECT sop.sale_order_id, elem ->> 'refSaleItemId' AS sale_item_id
    FROM sale_order_payments sop
    JOIN touched_orders t ON t.sale_order_id = sop.sale_order_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN sop.note LIKE '{%'
           THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                     THEN (sop.note)::jsonb -> 'items'
                     ELSE '[]'::jsonb END
           ELSE '[]'::jsonb END
    ) AS elem
   WHERE sop.change_type = '退款'
     AND sop.status = '已支付'
     AND LOWER(COALESCE(elem ->> 'isFullItemRefund', 'false')) = 'true'
)
UPDATE sale_items si
   SET paid_sessions = 0,
       updated_at = NOW()
  FROM full_refund_zero_items fri
 WHERE si.sale_order_id = fri.sale_order_id
   AND si.sale_item_id = fri.sale_item_id
   AND si.item_direction = '购买'
   AND si.session_count IS NOT NULL
   AND si.sale_amount::numeric <= 0;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM sale_items si
      JOIN (SELECT DISTINCT sale_order_id FROM _0086_overpay_receipt_mappings) t
        ON t.sale_order_id = si.sale_order_id
     WHERE si.session_count IS NOT NULL
       AND si.paid_sessions IS NOT NULL
       AND (si.session_count - si.remaining_sessions) > si.paid_sessions
  ) THEN
    RAISE EXCEPTION '0086 overpay backfill would make consumed sessions exceed paid_sessions';
  END IF;
END $$;
--> statement-breakpoint
WITH log_rows AS (
  SELECT sale_order_id,
         SUM(amount_cents)::numeric / 100 AS overpay_amount,
         jsonb_agg(
           jsonb_build_object(
             'saleItemId', sale_item_id,
             'amount', ROUND(amount_cents::numeric / 100, 2)
           )
           ORDER BY sale_item_id
         ) AS mapped_items
    FROM _0086_overpay_receipt_mappings
   GROUP BY sale_order_id
)
INSERT INTO operation_logs (
  operator_employee_id, operator_name, action, target_type, target_id, detail, source, created_at
)
SELECT NULL,
       '系统数据修复',
       'datafix.overpayItemReceiptBackfill',
       'sale_order',
       lr.sale_order_id,
       jsonb_build_object(
         'saleOrderId', lr.sale_order_id,
         'overpayAmount', lr.overpay_amount,
         'mappedItems', lr.mapped_items,
         'reason', 'overpay refund item receipt backfill'
       ),
       'admin',
       NOW()
  FROM log_rows lr
 WHERE NOT EXISTS (
   SELECT 1
     FROM operation_logs ol
    WHERE ol.action = 'datafix.overpayItemReceiptBackfill'
      AND ol.target_type = 'sale_order'
      AND ol.target_id = lr.sale_order_id
 );
--> statement-breakpoint
DROP TABLE IF EXISTS _0086_overpay_receipt_mappings;
