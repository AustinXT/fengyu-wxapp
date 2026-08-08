CREATE TEMP TABLE IF NOT EXISTS _0090_overpay_receipt_targets (
  sale_payment_id BIGINT NOT NULL,
  sale_order_id VARCHAR(30) NOT NULL,
  sale_item_id VARCHAR(30) NOT NULL,
  amount_cents INTEGER NOT NULL,
  sales_category sales_category,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (sale_payment_id, sale_item_id)
) ON COMMIT PRESERVE ROWS;
--> statement-breakpoint
CREATE TEMP TABLE IF NOT EXISTS _0090_refund_allocation_targets (
  refund_receipt_id BIGINT NOT NULL,
  sale_payment_id BIGINT NOT NULL,
  sale_order_id VARCHAR(30) NOT NULL,
  sale_item_id VARCHAR(30) NOT NULL,
  employee_id VARCHAR(30) NOT NULL,
  role_type VARCHAR(20) NOT NULL,
  department_name VARCHAR(100),
  allocation_ratio NUMERIC(5,3) NOT NULL,
  amount_cents BIGINT NOT NULL,
  commission_rate NUMERIC(5,4),
  commission_amount NUMERIC(10,2),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (refund_receipt_id, employee_id, role_type)
) ON COMMIT PRESERVE ROWS;
--> statement-breakpoint
TRUNCATE _0090_overpay_receipt_targets;
--> statement-breakpoint
TRUNCATE _0090_refund_allocation_targets;
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
         sop.sale_order_id,
         elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(ROUND(COALESCE((elem ->> 'refundAmount')::numeric, 0) * 100)::integer) AS refund_cents,
         MIN(COALESCE(sop.paid_at, sop.created_at, NOW())) AS created_at
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
   GROUP BY sop.id, sop.sale_order_id, elem ->> 'refSaleItemId'
),
item_caps AS (
  SELECT opr.sale_payment_id,
         opr.sale_order_id,
         si.sale_item_id,
         si.sales_category,
         opr.created_at,
         opr.overpay_cents,
         GREATEST(
           0,
           ROUND((COALESCE(receipts.positive_amount, 0) - COALESCE(receipts.prior_refund_amount, 0)) * 100)::integer
             - ROUND((
                 CASE WHEN si.product_type = '疗程卡'
                   THEN GREATEST(0, COALESCE(si.session_count, 0) - COALESCE(si.remaining_sessions, 0)) * COALESCE(si.unit_real_price::numeric, 0)
                   ELSE GREATEST(0, COALESCE(si.picked_up_quantity, 0)) * COALESCE(si.unit_real_price::numeric, 0)
                 END
               ) * 100)::integer
             - ROUND((
                 CASE WHEN si.product_type = '疗程卡'
                   THEN GREATEST(0, LEAST(
                     COALESCE(si.remaining_sessions, 0),
                     CASE WHEN si.paid_sessions IS NULL
                       THEN COALESCE(si.remaining_sessions, 0)
                       ELSE COALESCE(si.paid_sessions, 0) - GREATEST(0, COALESCE(si.session_count, 0) - COALESCE(si.remaining_sessions, 0))
                     END
                   )) * COALESCE(si.unit_real_price::numeric, 0)
                   ELSE GREATEST(0, COALESCE(si.quantity, 0) - COALESCE(si.picked_up_quantity, 0)) * COALESCE(si.unit_real_price::numeric, 0)
                 END
               ) * 100)::integer
         ) AS overpay_capacity_cents
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
   WHERE rr.sale_item_id IS NOT NULL
      OR NOT EXISTS (
           SELECT 1 FROM real_refund_cents rr2 WHERE rr2.sale_payment_id = opr.sale_payment_id
         )
),
eligible AS (
  SELECT *,
         SUM(overpay_capacity_cents) OVER (PARTITION BY sale_payment_id) AS capacity_total_cents,
         LEAST(overpay_cents, SUM(overpay_capacity_cents) OVER (PARTITION BY sale_payment_id)) AS target_overpay_cents
    FROM item_caps
   WHERE overpay_capacity_cents > 0
),
weighted AS (
  SELECT *,
         FLOOR(target_overpay_cents::numeric * overpay_capacity_cents::numeric / NULLIF(capacity_total_cents, 0))::integer AS base_cents,
         (target_overpay_cents::numeric * overpay_capacity_cents::numeric / NULLIF(capacity_total_cents, 0))
           - FLOOR(target_overpay_cents::numeric * overpay_capacity_cents::numeric / NULLIF(capacity_total_cents, 0)) AS frac
    FROM eligible
   WHERE target_overpay_cents > 0
     AND capacity_total_cents > 0
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY sale_payment_id ORDER BY frac DESC, sale_item_id) AS rn,
         target_overpay_cents - SUM(base_cents) OVER (PARTITION BY sale_payment_id) AS rem_cents
    FROM weighted
),
overpay_targets AS (
  SELECT sale_payment_id,
         sale_order_id,
         sale_item_id,
         base_cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END AS amount_cents,
         sales_category,
         created_at
    FROM ranked
   WHERE base_cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END > 0
),
receipt_targets AS (
  SELECT sale_payment_id, sale_order_id, sale_item_id, refund_cents AS amount_cents, created_at
    FROM real_refund_cents
  UNION ALL
  SELECT sale_payment_id, sale_order_id, sale_item_id, amount_cents, created_at
    FROM overpay_targets
)
INSERT INTO _0090_overpay_receipt_targets
  (sale_payment_id, sale_order_id, sale_item_id, amount_cents, sales_category, created_at)
SELECT rt.sale_payment_id,
       rt.sale_order_id,
       rt.sale_item_id,
       SUM(rt.amount_cents) AS amount_cents,
       si.sales_category,
       MIN(rt.created_at) AS created_at
  FROM receipt_targets rt
  JOIN sale_items si
    ON si.sale_order_id = rt.sale_order_id
   AND si.sale_item_id = rt.sale_item_id
   AND si.item_direction = '购买'
 GROUP BY rt.sale_payment_id, rt.sale_order_id, rt.sale_item_id, si.sales_category
HAVING SUM(rt.amount_cents) > 0
ON CONFLICT (sale_payment_id, sale_item_id)
DO UPDATE SET amount_cents = EXCLUDED.amount_cents,
              sales_category = EXCLUDED.sales_category,
              created_at = EXCLUDED.created_at;
--> statement-breakpoint
DELETE FROM sale_payment_item_allocations spia
USING sale_payment_item_receipts spir
WHERE spia.sale_payment_item_receipt_id = spir.id
  AND spir.sale_payment_id IN (SELECT DISTINCT sale_payment_id FROM _0090_overpay_receipt_targets)
  AND spia.allocated_amount::numeric < 0;
--> statement-breakpoint
DELETE FROM sale_payment_item_receipts spir
WHERE spir.sale_payment_id IN (SELECT DISTINCT sale_payment_id FROM _0090_overpay_receipt_targets)
  AND spir.amount::numeric < 0
  AND NOT EXISTS (
    SELECT 1 FROM _0090_overpay_receipt_targets t
     WHERE t.sale_payment_id = spir.sale_payment_id
       AND t.sale_item_id = spir.sale_item_id
  );
--> statement-breakpoint
INSERT INTO sale_payment_item_receipts
  (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
SELECT t.sale_payment_id,
       t.sale_order_id,
       t.sale_item_id,
       ROUND(-(t.amount_cents::numeric) / 100, 2),
       t.sales_category,
       t.created_at
  FROM _0090_overpay_receipt_targets t
ON CONFLICT (sale_payment_id, sale_item_id)
DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category;
--> statement-breakpoint
WITH refund_receipts AS (
  SELECT spir.id AS refund_receipt_id,
         spir.sale_payment_id,
         spir.sale_order_id,
         spir.sale_item_id,
         ABS(ROUND(spir.amount::numeric * 100)::bigint) AS refund_cents,
         COALESCE(sop.paid_at, sop.created_at, NOW()) AS created_at
    FROM sale_payment_item_receipts spir
    JOIN _0090_overpay_receipt_targets t
      ON t.sale_payment_id = spir.sale_payment_id
     AND t.sale_item_id = spir.sale_item_id
    JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
   WHERE sop.change_type = '退款'
     AND sop.status = '已支付'
     AND sop.amount::numeric < 0
     AND spir.amount::numeric < 0
),
grouped_positive_allocations AS (
  SELECT rr.refund_receipt_id,
         rr.sale_payment_id,
         rr.sale_order_id,
         rr.sale_item_id,
         rr.refund_cents,
         rr.created_at,
         spia.employee_id,
         spia.role_type,
         MAX(spia.department_name) AS department_name,
         MAX(spia.allocation_ratio) AS allocation_ratio,
         SUM(ROUND(spia.allocated_amount::numeric * 100)::bigint) AS group_amount_cents,
         MAX(spia.commission_rate) AS commission_rate,
         COALESCE(SUM(spia.commission_amount::numeric), 0) AS group_commission_amount
    FROM refund_receipts rr
    JOIN sale_payment_item_receipts pos_spir
      ON pos_spir.sale_order_id = rr.sale_order_id
     AND pos_spir.sale_item_id = rr.sale_item_id
    JOIN sale_order_payments pos_sop
      ON pos_sop.id = pos_spir.sale_payment_id
    JOIN sale_payment_item_allocations spia
      ON spia.sale_payment_item_receipt_id = pos_spir.id
     AND spia.is_void = false
     AND spia.allocated_amount::numeric > 0
   WHERE pos_sop.status = '已支付'
     AND pos_sop.change_type IN ('首次支付','回款','储值卡抵扣')
   GROUP BY rr.refund_receipt_id, rr.sale_payment_id, rr.sale_order_id, rr.sale_item_id,
            rr.refund_cents, rr.created_at, spia.employee_id, spia.role_type
),
allocation_totals AS (
  SELECT rr.refund_receipt_id,
         COALESCE(SUM(ROUND(spia.allocated_amount::numeric * 100)::bigint) FILTER (WHERE spia.allocated_amount::numeric > 0), 0) AS positive_total_cents,
         COALESCE(ABS(SUM(ROUND(spia.allocated_amount::numeric * 100)::bigint) FILTER (
           WHERE spia.allocated_amount::numeric < 0
             AND spir.id IS DISTINCT FROM rr.refund_receipt_id
         )), 0) AS other_negative_total_cents
    FROM refund_receipts rr
    LEFT JOIN sale_payment_item_receipts spir
      ON spir.sale_order_id = rr.sale_order_id
     AND spir.sale_item_id = rr.sale_item_id
    LEFT JOIN sale_payment_item_allocations spia
      ON spia.sale_payment_item_receipt_id = spir.id
     AND spia.is_void = false
   GROUP BY rr.refund_receipt_id
),
eligible AS (
  SELECT gpa.*,
         LEAST(
           gpa.refund_cents,
           GREATEST(0, at.positive_total_cents - at.other_negative_total_cents)
         ) AS target_cents,
         SUM(gpa.group_amount_cents) OVER (PARTITION BY gpa.refund_receipt_id) AS base_total_cents
    FROM grouped_positive_allocations gpa
    JOIN allocation_totals at ON at.refund_receipt_id = gpa.refund_receipt_id
   WHERE gpa.group_amount_cents > 0
),
weighted AS (
  SELECT *,
         FLOOR(target_cents::numeric * group_amount_cents::numeric / NULLIF(base_total_cents, 0))::bigint AS base_cents,
         (target_cents::numeric * group_amount_cents::numeric / NULLIF(base_total_cents, 0))
           - FLOOR(target_cents::numeric * group_amount_cents::numeric / NULLIF(base_total_cents, 0)) AS frac
    FROM eligible
   WHERE target_cents > 0
     AND base_total_cents > 0
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY refund_receipt_id ORDER BY frac DESC, employee_id, role_type) AS rn,
         target_cents - SUM(base_cents) OVER (PARTITION BY refund_receipt_id) AS rem_cents
    FROM weighted
)
INSERT INTO _0090_refund_allocation_targets (
  refund_receipt_id, sale_payment_id, sale_order_id, sale_item_id, employee_id, role_type,
  department_name, allocation_ratio, amount_cents, commission_rate, commission_amount, created_at
)
SELECT refund_receipt_id,
       sale_payment_id,
       sale_order_id,
       sale_item_id,
       employee_id,
       role_type,
       department_name,
       allocation_ratio,
       base_cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END AS amount_cents,
       commission_rate,
       CASE
         WHEN group_amount_cents > 0
           THEN ROUND(group_commission_amount * (base_cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END)::numeric / group_amount_cents::numeric, 2)
         ELSE 0
       END AS commission_amount,
       created_at
  FROM ranked
 WHERE base_cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END > 0
ON CONFLICT (refund_receipt_id, employee_id, role_type)
DO UPDATE SET amount_cents = EXCLUDED.amount_cents,
              department_name = EXCLUDED.department_name,
              allocation_ratio = EXCLUDED.allocation_ratio,
              commission_rate = EXCLUDED.commission_rate,
              commission_amount = EXCLUDED.commission_amount,
              created_at = EXCLUDED.created_at;
--> statement-breakpoint
INSERT INTO sale_payment_item_allocations (
  sale_payment_item_receipt_id, employee_id, role_type, department_name, allocation_ratio,
  allocated_amount, commission_rate, commission_amount, is_void, created_at, updated_at
)
SELECT refund_receipt_id,
       employee_id,
       role_type,
       department_name,
       allocation_ratio,
       ROUND(-(amount_cents::numeric) / 100, 2),
       commission_rate,
       -commission_amount,
       false,
       created_at,
       NOW()
  FROM _0090_refund_allocation_targets
 WHERE amount_cents > 0
ON CONFLICT (sale_payment_item_receipt_id, employee_id, role_type) WHERE is_void = false
DO UPDATE SET department_name = EXCLUDED.department_name,
              allocation_ratio = EXCLUDED.allocation_ratio,
              allocated_amount = EXCLUDED.allocated_amount,
              commission_rate = EXCLUDED.commission_rate,
              commission_amount = EXCLUDED.commission_amount,
              updated_at = NOW();
--> statement-breakpoint
WITH touched_orders AS (
  SELECT DISTINCT sale_order_id FROM _0090_overpay_receipt_targets
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
  SELECT DISTINCT sale_order_id FROM _0090_overpay_receipt_targets
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
  SELECT DISTINCT sale_order_id FROM _0090_overpay_receipt_targets
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
      JOIN (SELECT DISTINCT sale_order_id FROM _0090_overpay_receipt_targets) t
        ON t.sale_order_id = si.sale_order_id
     WHERE si.session_count IS NOT NULL
       AND si.paid_sessions IS NOT NULL
       AND (si.session_count - si.remaining_sessions) > si.paid_sessions
  ) THEN
    RAISE EXCEPTION '0090 overpay remap would make consumed sessions exceed paid_sessions';
  END IF;
END $$;
--> statement-breakpoint
WITH log_rows AS (
  SELECT sale_order_id,
         SUM(amount_cents)::numeric / 100 AS remapped_amount,
         jsonb_agg(
           jsonb_build_object(
             'salePaymentId', sale_payment_id,
             'saleItemId', sale_item_id,
             'amount', ROUND(amount_cents::numeric / 100, 2)
           )
           ORDER BY sale_payment_id, sale_item_id
         ) AS mapped_items
    FROM _0090_overpay_receipt_targets
   GROUP BY sale_order_id
)
INSERT INTO operation_logs (
  operator_employee_id, operator_name, action, target_type, target_id, detail, source, created_at
)
SELECT NULL,
       '系统数据修复',
       'datafix.overpayReceiptItemRemap',
       'sale_order',
       lr.sale_order_id,
       jsonb_build_object(
         'saleOrderId', lr.sale_order_id,
         'remappedAmount', lr.remapped_amount,
         'mappedItems', lr.mapped_items,
         'reason', 'remap overpay refund receipts by item-owned excess'
       ),
       'admin',
       NOW()
  FROM log_rows lr
 WHERE NOT EXISTS (
   SELECT 1
     FROM operation_logs ol
    WHERE ol.action = 'datafix.overpayReceiptItemRemap'
      AND ol.target_type = 'sale_order'
      AND ol.target_id = lr.sale_order_id
 );
--> statement-breakpoint
DROP TABLE IF EXISTS _0090_refund_allocation_targets;
--> statement-breakpoint
DROP TABLE IF EXISTS _0090_overpay_receipt_targets;
