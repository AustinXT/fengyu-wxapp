CREATE TEMP TABLE IF NOT EXISTS _0029_receipt_targets (
  sale_payment_id BIGINT NOT NULL,
  sale_order_id VARCHAR(30) NOT NULL,
  sale_item_id VARCHAR(30) NOT NULL,
  amount_cents INTEGER NOT NULL,
  sales_category sales_category,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL,
  PRIMARY KEY (sale_payment_id, sale_item_id)
) ON COMMIT DROP;
--> statement-breakpoint
TRUNCATE _0029_receipt_targets;
--> statement-breakpoint
WITH overpay_refunds AS (
  SELECT sop.id AS sale_payment_id,
         sop.sale_order_id,
         SUM(ROUND(COALESCE((elem ->> 'refundAmount')::numeric, 0) * 100)::integer) AS overpay_cents,
         COALESCE(sop.paid_at, sop.created_at, NOW()) AS created_at
    FROM sale_order_payments sop
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN sop.note LIKE '{%'
           THEN CASE WHEN jsonb_typeof((sop.note)::jsonb -> 'items') = 'array'
                     THEN (sop.note)::jsonb -> 'items' ELSE '[]'::jsonb END
           ELSE '[]'::jsonb END
    ) elem
   WHERE sop.change_type = '退款'
     AND sop.status = '已支付'
     AND sop.amount::numeric < 0
     AND (elem ->> 'refSaleItemId' = 'OVERPAY'
          OR LOWER(COALESCE(elem ->> 'isOverpay', 'false')) = 'true')
     AND COALESCE((elem ->> 'refundAmount')::numeric, 0) > 0
   GROUP BY sop.id, sop.sale_order_id, sop.paid_at, sop.created_at
),
real_refunds AS (
  SELECT sop.id AS sale_payment_id,
         sop.sale_order_id,
         elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(ROUND(COALESCE((elem ->> 'refundAmount')::numeric, 0) * 100)::integer) AS refund_cents
    FROM sale_order_payments sop
    JOIN overpay_refunds opr ON opr.sale_payment_id = sop.id
    CROSS JOIN LATERAL jsonb_array_elements((sop.note)::jsonb -> 'items') elem
   WHERE elem ->> 'refSaleItemId' IS NOT NULL
     AND elem ->> 'refSaleItemId' <> 'OVERPAY'
     AND LOWER(COALESCE(elem ->> 'isOverpay', 'false')) <> 'true'
     AND COALESCE((elem ->> 'refundAmount')::numeric, 0) > 0
   GROUP BY sop.id, sop.sale_order_id, elem ->> 'refSaleItemId'
),
item_capacity AS (
  SELECT opr.sale_payment_id,
         opr.sale_order_id,
         si.sale_item_id,
         si.sales_category,
         opr.created_at,
         opr.overpay_cents,
         GREATEST(0,
           ROUND(COALESCE(SUM(spir.amount::numeric) FILTER (
             WHERE psop.status = '已支付'
               AND psop.change_type IN ('首次支付','回款','储值卡抵扣')
           ), 0) * 100)::integer
           - ROUND(COALESCE(ABS(SUM(spir.amount::numeric) FILTER (
             WHERE psop.status = '已支付'
               AND psop.change_type = '退款'
               AND spir.sale_payment_id <> opr.sale_payment_id
           )), 0) * 100)::integer
           - COALESCE(rr.refund_cents, 0)
         ) AS capacity_cents
    FROM overpay_refunds opr
    JOIN sale_items si ON si.sale_order_id = opr.sale_order_id AND si.item_direction = '购买'
    LEFT JOIN real_refunds rr
      ON rr.sale_payment_id = opr.sale_payment_id AND rr.sale_item_id = si.sale_item_id
    LEFT JOIN sale_payment_item_receipts spir
      ON spir.sale_order_id = si.sale_order_id AND spir.sale_item_id = si.sale_item_id
    LEFT JOIN sale_order_payments psop ON psop.id = spir.sale_payment_id
   GROUP BY opr.sale_payment_id, opr.sale_order_id, si.sale_item_id, si.sales_category,
            opr.created_at, opr.overpay_cents, rr.refund_cents
),
eligible AS (
  SELECT *,
         SUM(capacity_cents) OVER (PARTITION BY sale_payment_id) AS capacity_total
    FROM item_capacity
   WHERE capacity_cents > 0
),
weighted AS (
  SELECT *,
         FLOOR(overpay_cents::numeric * capacity_cents / NULLIF(capacity_total, 0))::integer AS base_cents,
         overpay_cents::numeric * capacity_cents / NULLIF(capacity_total, 0)
           - FLOOR(overpay_cents::numeric * capacity_cents / NULLIF(capacity_total, 0)) AS frac
    FROM eligible
   WHERE capacity_total >= overpay_cents
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY sale_payment_id ORDER BY frac DESC, sale_item_id) AS rn,
         overpay_cents - SUM(base_cents) OVER (PARTITION BY sale_payment_id) AS remainder
    FROM weighted
),
overpay_targets AS (
  SELECT sale_payment_id, sale_order_id, sale_item_id,
         base_cents + CASE WHEN rn <= remainder THEN 1 ELSE 0 END AS amount_cents,
         sales_category, created_at
    FROM ranked
),
all_targets AS (
  SELECT rr.sale_payment_id, rr.sale_order_id, rr.sale_item_id, rr.refund_cents AS amount_cents,
         si.sales_category, opr.created_at
    FROM real_refunds rr
    JOIN overpay_refunds opr ON opr.sale_payment_id = rr.sale_payment_id
    JOIN sale_items si ON si.sale_item_id = rr.sale_item_id AND si.sale_order_id = rr.sale_order_id
  UNION ALL
  SELECT sale_payment_id, sale_order_id, sale_item_id, amount_cents, sales_category, created_at
    FROM overpay_targets
)
INSERT INTO _0029_receipt_targets
SELECT sale_payment_id, sale_order_id, sale_item_id, SUM(amount_cents), MAX(sales_category), MIN(created_at)
  FROM all_targets
 GROUP BY sale_payment_id, sale_order_id, sale_item_id
HAVING SUM(amount_cents) > 0;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    WITH overpay_refunds AS (
      SELECT sop.id, ABS(ROUND(sop.amount::numeric * 100))::integer AS refund_cents
        FROM sale_order_payments sop
       WHERE sop.change_type = '退款' AND sop.status = '已支付'
         AND sop.note LIKE '%OVERPAY%'
    )
    SELECT 1 FROM overpay_refunds o
    LEFT JOIN (SELECT sale_payment_id, SUM(amount_cents) cents FROM _0029_receipt_targets GROUP BY sale_payment_id) t
      ON t.sale_payment_id = o.id
    WHERE COALESCE(t.cents, 0) <> o.refund_cents
  ) THEN
    RAISE EXCEPTION '0029 cannot map every refunded cent to a funded sale item';
  END IF;
END $$;
--> statement-breakpoint
DELETE FROM sale_payment_item_allocations spia
USING sale_payment_item_receipts spir
WHERE spia.sale_payment_item_receipt_id = spir.id
  AND spir.sale_payment_id IN (SELECT DISTINCT sale_payment_id FROM _0029_receipt_targets)
  AND spir.amount::numeric < 0;
--> statement-breakpoint
DELETE FROM sale_payment_item_receipts spir
WHERE spir.sale_payment_id IN (SELECT DISTINCT sale_payment_id FROM _0029_receipt_targets)
  AND spir.amount::numeric < 0
  AND NOT EXISTS (
    SELECT 1 FROM _0029_receipt_targets t
     WHERE t.sale_payment_id = spir.sale_payment_id AND t.sale_item_id = spir.sale_item_id
  );
--> statement-breakpoint
INSERT INTO sale_payment_item_receipts
  (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
SELECT sale_payment_id, sale_order_id, sale_item_id,
       ROUND(-amount_cents::numeric / 100, 2), sales_category, created_at
  FROM _0029_receipt_targets
ON CONFLICT (sale_payment_id, sale_item_id)
DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category;
--> statement-breakpoint
WITH positive_groups AS (
  SELECT target.sale_payment_id AS refund_payment_id,
         refund_receipt.id AS refund_receipt_id,
         target.amount_cents AS refund_cents,
         spia.employee_id, spia.role_type,
         MAX(spia.department_name) AS department_name,
         MAX(spia.allocation_ratio) AS allocation_ratio,
         SUM(ROUND(spia.allocated_amount::numeric * 100))::bigint AS weight_cents,
         MAX(spia.commission_rate) AS commission_rate,
         SUM(COALESCE(spia.commission_amount, 0)) AS commission_amount
    FROM _0029_receipt_targets target
    JOIN sale_payment_item_receipts refund_receipt
      ON refund_receipt.sale_payment_id = target.sale_payment_id
     AND refund_receipt.sale_item_id = target.sale_item_id
    JOIN sale_payment_item_receipts positive_receipt
      ON positive_receipt.sale_order_id = target.sale_order_id
     AND positive_receipt.sale_item_id = target.sale_item_id
     AND positive_receipt.amount::numeric > 0
    JOIN sale_order_payments positive_payment
      ON positive_payment.id = positive_receipt.sale_payment_id
     AND positive_payment.status = '已支付'
     AND positive_payment.change_type IN ('首次支付','回款','储值卡抵扣')
    JOIN sale_payment_item_allocations spia
      ON spia.sale_payment_item_receipt_id = positive_receipt.id
     AND spia.is_void = false AND spia.allocated_amount::numeric > 0
   GROUP BY target.sale_payment_id, refund_receipt.id, target.amount_cents,
            spia.employee_id, spia.role_type
),
weighted AS (
  SELECT *, SUM(weight_cents) OVER (PARTITION BY refund_receipt_id) AS total_weight,
         FLOOR(refund_cents::numeric * weight_cents / NULLIF(SUM(weight_cents) OVER (PARTITION BY refund_receipt_id), 0))::bigint AS base_cents,
         refund_cents::numeric * weight_cents / NULLIF(SUM(weight_cents) OVER (PARTITION BY refund_receipt_id), 0)
           - FLOOR(refund_cents::numeric * weight_cents / NULLIF(SUM(weight_cents) OVER (PARTITION BY refund_receipt_id), 0)) AS frac
    FROM positive_groups
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY refund_receipt_id ORDER BY frac DESC, employee_id, role_type) AS rn,
         refund_cents - SUM(base_cents) OVER (PARTITION BY refund_receipt_id) AS remainder
    FROM weighted
)
INSERT INTO sale_payment_item_allocations (
  sale_payment_item_receipt_id, employee_id, role_type, department_name, allocation_ratio,
  allocated_amount, commission_rate, commission_amount, is_void, created_at, updated_at
)
SELECT refund_receipt_id, employee_id, role_type, department_name, allocation_ratio,
       ROUND(-(base_cents + CASE WHEN rn <= remainder THEN 1 ELSE 0 END)::numeric / 100, 2),
       commission_rate,
       CASE WHEN weight_cents > 0 THEN
         -ROUND(commission_amount * (base_cents + CASE WHEN rn <= remainder THEN 1 ELSE 0 END) / weight_cents, 2)
       ELSE 0 END,
       false, NOW(), NOW()
  FROM ranked
 WHERE base_cents + CASE WHEN rn <= remainder THEN 1 ELSE 0 END > 0
ON CONFLICT (sale_payment_item_receipt_id, employee_id, role_type) WHERE is_void = false
DO UPDATE SET allocated_amount = EXCLUDED.allocated_amount,
              commission_amount = EXCLUDED.commission_amount,
              updated_at = NOW();
--> statement-breakpoint
WITH touched AS (SELECT DISTINCT sale_order_id FROM _0029_receipt_targets)
UPDATE sale_items si
   SET received = COALESCE(GREATEST(0, (
         SELECT SUM(spir.amount::numeric)
           FROM sale_payment_item_receipts spir
           JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
          WHERE spir.sale_order_id = si.sale_order_id
            AND spir.sale_item_id = si.sale_item_id
            AND sop.status = '已支付'
            AND sop.change_type IN ('首次支付','回款','储值卡抵扣','退款')
       )), 0), updated_at = NOW()
  FROM touched t
 WHERE si.sale_order_id = t.sale_order_id AND si.item_direction = '购买';
--> statement-breakpoint
WITH touched AS (SELECT DISTINCT sale_order_id FROM _0029_receipt_targets)
UPDATE sale_items si
   SET paid_sessions = CASE
         WHEN si.session_count IS NULL THEN NULL
         WHEN si.sale_amount::numeric <= 0 THEN si.session_count
         ELSE LEAST(si.session_count, FLOOR(si.received::numeric * si.session_count / si.sale_amount::numeric)::integer)
       END,
       updated_at = NOW()
  FROM touched t
 WHERE si.sale_order_id = t.sale_order_id;
--> statement-breakpoint
WITH touched AS (SELECT DISTINCT sale_order_id FROM _0029_receipt_targets),
item_totals AS (
  SELECT si.sale_order_id, SUM(GREATEST(si.received::numeric, 0)) AS item_net
    FROM sale_items si JOIN touched t ON t.sale_order_id = si.sale_order_id
   WHERE si.item_direction = '购买' GROUP BY si.sale_order_id
)
UPDATE sale_orders so
   SET status = CASE
         WHEN GREATEST(so.received::numeric - so.refunded_amount::numeric, 0) <= 0.01
          AND it.item_net <= 0.01 THEN '已退款'::order_status
         WHEN it.item_net + 0.01 < so.total_amount::numeric THEN '部分支付'::order_status
         ELSE '已支付'::order_status
       END,
       updated_at = NOW()
  FROM item_totals it
 WHERE so.sale_order_id = it.sale_order_id;
--> statement-breakpoint
INSERT INTO operation_logs (
  operator_employee_id, operator_name, action, target_type, target_id, detail, source, created_at
)
SELECT NULL, '系统数据修复', 'datafix.overpayItemReceiptDrain', 'sale_order', sale_order_id,
       jsonb_build_object('saleOrderId', sale_order_id, 'reason', 'drain refunded amount from the actual funded sale item rows'),
       'admin', NOW()
  FROM (SELECT DISTINCT sale_order_id FROM _0029_receipt_targets) t
 WHERE NOT EXISTS (
   SELECT 1 FROM operation_logs ol
    WHERE ol.action = 'datafix.overpayItemReceiptDrain' AND ol.target_id = t.sale_order_id
 );
