CREATE TEMP TABLE IF NOT EXISTS _0087_refund_allocation_targets (
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
TRUNCATE _0087_refund_allocation_targets;
--> statement-breakpoint
WITH refund_receipts AS (
  SELECT spir.id AS refund_receipt_id,
         spir.sale_payment_id,
         spir.sale_order_id,
         spir.sale_item_id,
         ABS(ROUND(spir.amount::numeric * 100)::bigint) AS refund_cents,
         COALESCE(sop.paid_at, sop.created_at, NOW()) AS created_at
    FROM sale_payment_item_receipts spir
    JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
    JOIN sale_orders so ON so.sale_order_id = spir.sale_order_id
   WHERE sop.change_type = '退款'
     AND sop.status = '已支付'
     AND sop.amount::numeric < 0
     AND spir.amount::numeric < 0
     AND so.sale_order_type IN ('销售单','转换单')
     AND so.legacy_source IS DISTINCT FROM 'workfine'
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
INSERT INTO _0087_refund_allocation_targets (
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
  FROM _0087_refund_allocation_targets
 WHERE amount_cents > 0
ON CONFLICT (sale_payment_item_receipt_id, employee_id, role_type) WHERE is_void = false
DO UPDATE SET department_name = EXCLUDED.department_name,
              allocation_ratio = EXCLUDED.allocation_ratio,
              allocated_amount = EXCLUDED.allocated_amount,
              commission_rate = EXCLUDED.commission_rate,
              commission_amount = EXCLUDED.commission_amount,
              updated_at = NOW();
--> statement-breakpoint
WITH log_rows AS (
  SELECT sale_order_id,
         SUM(amount_cents)::numeric / 100 AS mirrored_amount,
         jsonb_agg(
           jsonb_build_object(
             'salePaymentId', sale_payment_id,
             'refundReceiptId', refund_receipt_id,
             'saleItemId', sale_item_id,
             'employeeId', employee_id,
             'roleType', role_type,
             'amount', ROUND(amount_cents::numeric / 100, 2)
           )
           ORDER BY sale_payment_id, refund_receipt_id, employee_id, role_type
         ) AS mirrored_allocations
    FROM _0087_refund_allocation_targets
   GROUP BY sale_order_id
)
INSERT INTO operation_logs (
  operator_employee_id, operator_name, action, target_type, target_id, detail, source, created_at
)
SELECT NULL,
       '系统数据修复',
       'datafix.refundAllocationMirrorBackfill',
       'sale_order',
       lr.sale_order_id,
       jsonb_build_object(
         'saleOrderId', lr.sale_order_id,
         'mirroredAmount', lr.mirrored_amount,
         'mirroredAllocations', lr.mirrored_allocations,
         'reason', 'refund receipt allocation mirror backfill'
       ),
       'admin',
       NOW()
  FROM log_rows lr
 WHERE NOT EXISTS (
   SELECT 1
     FROM operation_logs ol
    WHERE ol.action = 'datafix.refundAllocationMirrorBackfill'
      AND ol.target_type = 'sale_order'
      AND ol.target_id = lr.sale_order_id
 );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM sale_orders so
     WHERE so.sale_order_type IN ('销售单','转换单')
       AND so.legacy_source IS DISTINCT FROM 'workfine'
       AND GREATEST(COALESCE(so.received::numeric, 0) - COALESCE(so.refunded_amount::numeric, 0), 0) <= 0.01
       AND ABS(COALESCE((
         SELECT SUM(spia.allocated_amount::numeric)
           FROM sale_payment_item_receipts spir
           JOIN sale_payment_item_allocations spia
             ON spia.sale_payment_item_receipt_id = spir.id
            AND spia.is_void = false
          WHERE spir.sale_order_id = so.sale_order_id
       ), 0)) > 0.01
  ) THEN
    RAISE EXCEPTION '0087 refund allocation mirror backfill left nonzero full-refund allocation net';
  END IF;
END $$;
--> statement-breakpoint
CREATE TEMP TABLE IF NOT EXISTS _0087_full_zero_allocation_status_orders (
  sale_order_id VARCHAR(30) PRIMARY KEY
) ON COMMIT PRESERVE ROWS;
--> statement-breakpoint
TRUNCATE _0087_full_zero_allocation_status_orders;
--> statement-breakpoint
INSERT INTO _0087_full_zero_allocation_status_orders (sale_order_id)
SELECT so.sale_order_id
  FROM sale_orders so
 WHERE so.sale_order_type IN ('销售单','转换单')
   AND so.legacy_source IS DISTINCT FROM 'workfine'
   AND GREATEST(COALESCE(so.received::numeric, 0) - COALESCE(so.refunded_amount::numeric, 0), 0) <= 0.01
   AND (
     so.allocation_status IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM sale_order_payments sop
        WHERE sop.sale_order_id = so.sale_order_id
          AND sop.allocation_status IS NOT NULL
     )
   )
ON CONFLICT (sale_order_id) DO NOTHING;
--> statement-breakpoint
UPDATE sale_order_payments sop
   SET allocation_status = NULL
  FROM _0087_full_zero_allocation_status_orders f
 WHERE sop.sale_order_id = f.sale_order_id
   AND sop.allocation_status IS NOT NULL;
--> statement-breakpoint
UPDATE sale_orders so
   SET allocation_status = NULL,
       updated_at = NOW()
  FROM _0087_full_zero_allocation_status_orders f
 WHERE so.sale_order_id = f.sale_order_id
   AND so.allocation_status IS NOT NULL;
--> statement-breakpoint
WITH log_rows AS (
  SELECT sale_order_id FROM _0087_full_zero_allocation_status_orders
)
INSERT INTO operation_logs (
  operator_employee_id, operator_name, action, target_type, target_id, detail, source, created_at
)
SELECT NULL,
       '系统数据修复',
       'datafix.fullRefundAllocationStatusClear',
       'sale_order',
       lr.sale_order_id,
       jsonb_build_object(
         'saleOrderId', lr.sale_order_id,
         'reason', 'clear allocation status for zero-net refunded or closed order'
       ),
       'admin',
       NOW()
  FROM log_rows lr
 WHERE NOT EXISTS (
   SELECT 1
     FROM operation_logs ol
    WHERE ol.action = 'datafix.fullRefundAllocationStatusClear'
      AND ol.target_type = 'sale_order'
      AND ol.target_id = lr.sale_order_id
 );
--> statement-breakpoint
DROP TABLE IF EXISTS _0087_full_zero_allocation_status_orders;
--> statement-breakpoint
DROP TABLE IF EXISTS _0087_refund_allocation_targets;
