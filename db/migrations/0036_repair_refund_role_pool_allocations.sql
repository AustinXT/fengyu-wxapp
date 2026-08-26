-- 修复 2026-06-24 至 2026-08-26 期间退款营业额跨角色共用目标额的问题。
-- 旧算法把同一商品行所有 role_type 混成一个池；两个各 100% 的角色池会各退 50%。
-- 本迁移仅重算“每个商品行恰好一笔成功退款”的历史行。上线前审计确认三环境不存在
-- 多笔退款商品行；迁移期间锁定支付与行级收款事实，并在发现多笔成功退款时显式中止。
LOCK TABLE sale_order_payments, sale_payment_item_receipts IN SHARE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM sale_payment_item_receipts refund_receipt
      JOIN sale_order_payments refund_payment
        ON refund_payment.id = refund_receipt.sale_payment_id
     WHERE refund_receipt.amount < 0
       AND refund_payment.status = '已支付'
       AND refund_payment.change_type = '退款'
       AND EXISTS (
         SELECT 1
           FROM sale_payment_item_receipts positive_receipt
           JOIN sale_order_payments positive_payment
             ON positive_payment.id = positive_receipt.sale_payment_id
          WHERE positive_receipt.sale_order_id = refund_receipt.sale_order_id
            AND positive_receipt.sale_item_id = refund_receipt.sale_item_id
            AND positive_receipt.amount > 0
            AND positive_payment.status = '已支付'
            AND positive_payment.change_type IN ('首次支付','回款','储值卡抵扣')
       )
     GROUP BY refund_receipt.sale_order_id, refund_receipt.sale_item_id
    HAVING COUNT(DISTINCT refund_receipt.sale_payment_id) > 1
  ) THEN
    RAISE EXCEPTION '0036 refund role-pool repair does not support multiple paid refunds per sale item';
  END IF;
END $$;
--> statement-breakpoint
CREATE TEMP TABLE _0035_refund_role_pool_targets (
  refund_receipt_id BIGINT NOT NULL,
  sale_order_id VARCHAR(30) NOT NULL,
  sale_item_id VARCHAR(30) NOT NULL,
  employee_id VARCHAR(30) NOT NULL,
  role_type VARCHAR(20) NOT NULL,
  department_name VARCHAR(100),
  allocation_ratio NUMERIC(5, 3) NOT NULL,
  allocated_cents BIGINT NOT NULL,
  commission_rate NUMERIC(5, 4),
  commission_cents BIGINT NOT NULL,
  PRIMARY KEY (refund_receipt_id, employee_id, role_type)
) ON COMMIT DROP;
--> statement-breakpoint
WITH receipt_totals AS (
  SELECT spir.sale_order_id, spir.sale_item_id,
         ROUND(SUM(spir.amount::numeric) FILTER (
           WHERE spir.amount > 0
             AND sop.status = '已支付'
             AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
         ) * 100)::bigint AS positive_receipt_cents,
         COUNT(DISTINCT spir.sale_payment_id) FILTER (
           WHERE spir.amount < 0
             AND sop.status = '已支付'
             AND sop.change_type = '退款'
         ) AS refund_count
    FROM sale_payment_item_receipts spir
    JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
   GROUP BY spir.sale_order_id, spir.sale_item_id
),
refund_receipts AS (
  SELECT spir.id AS refund_receipt_id, spir.sale_order_id, spir.sale_item_id,
         ABS(ROUND(spir.amount::numeric * 100))::bigint AS refund_cents
    FROM sale_payment_item_receipts spir
    JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
    JOIN receipt_totals rt
      ON rt.sale_order_id = spir.sale_order_id AND rt.sale_item_id = spir.sale_item_id
   WHERE spir.amount < 0
     AND sop.status = '已支付'
     AND sop.change_type = '退款'
     AND rt.refund_count = 1
     AND rt.positive_receipt_cents > 0
),
positive_groups AS (
  SELECT rr.refund_receipt_id, rr.sale_order_id, rr.sale_item_id, rr.refund_cents,
         rt.positive_receipt_cents,
         spia.employee_id, spia.role_type,
         MAX(spia.department_name) AS department_name,
         SUM(ROUND(spia.allocated_amount::numeric * 100))::bigint AS weight_cents,
         MAX(spia.commission_rate) AS commission_rate,
         SUM(ROUND(COALESCE(spia.commission_amount, 0)::numeric * 100))::bigint AS commission_cents
    FROM refund_receipts rr
    JOIN receipt_totals rt
      ON rt.sale_order_id = rr.sale_order_id AND rt.sale_item_id = rr.sale_item_id
    JOIN sale_payment_item_receipts positive_receipt
      ON positive_receipt.sale_order_id = rr.sale_order_id
     AND positive_receipt.sale_item_id = rr.sale_item_id
     AND positive_receipt.amount > 0
    JOIN sale_order_payments positive_payment
      ON positive_payment.id = positive_receipt.sale_payment_id
     AND positive_payment.status = '已支付'
     AND positive_payment.change_type IN ('首次支付','回款','储值卡抵扣')
    JOIN sale_payment_item_allocations spia
      ON spia.sale_payment_item_receipt_id = positive_receipt.id
     AND spia.is_void = false
     AND spia.allocated_amount > 0
   GROUP BY rr.refund_receipt_id, rr.sale_order_id, rr.sale_item_id, rr.refund_cents,
            rt.positive_receipt_cents, spia.employee_id, spia.role_type
),
role_totals AS (
  SELECT *, SUM(weight_cents) OVER (PARTITION BY refund_receipt_id, role_type) AS role_cents
    FROM positive_groups
),
weighted AS (
  SELECT *,
         LEAST(
           refund_cents,
           role_cents,
           ROUND(refund_cents::numeric * role_cents / NULLIF(positive_receipt_cents, 0))::bigint
         ) AS role_target_cents
    FROM role_totals
),
floored AS (
  SELECT *,
         FLOOR(role_target_cents::numeric * weight_cents / NULLIF(role_cents, 0))::bigint AS base_cents,
         role_target_cents::numeric * weight_cents / NULLIF(role_cents, 0)
           - FLOOR(role_target_cents::numeric * weight_cents / NULLIF(role_cents, 0)) AS frac
    FROM weighted
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY refund_receipt_id, role_type
           ORDER BY frac DESC, employee_id
         ) AS rn,
         role_target_cents - SUM(base_cents) OVER (
           PARTITION BY refund_receipt_id, role_type
         ) AS remainder
    FROM floored
),
targets AS (
  SELECT *, base_cents + CASE WHEN rn <= remainder THEN 1 ELSE 0 END AS target_cents
    FROM ranked
)
INSERT INTO _0035_refund_role_pool_targets (
  refund_receipt_id, sale_order_id, sale_item_id, employee_id, role_type,
  department_name, allocation_ratio, allocated_cents, commission_rate, commission_cents
)
SELECT refund_receipt_id, sale_order_id, sale_item_id, employee_id, role_type,
       department_name,
       GREATEST(0.001, LEAST(1, target_cents::numeric / NULLIF(refund_cents, 0)))::numeric(5, 3),
       target_cents,
       commission_rate,
       CASE
         WHEN target_cents >= weight_cents THEN commission_cents
         ELSE LEAST(commission_cents, ROUND(commission_cents::numeric * target_cents / NULLIF(weight_cents, 0))::bigint)
       END
  FROM targets
 WHERE target_cents > 0;
--> statement-breakpoint
CREATE TEMP TABLE _0035_touched_orders (
  sale_order_id VARCHAR(30) PRIMARY KEY
) ON COMMIT DROP;
--> statement-breakpoint
INSERT INTO _0035_touched_orders (sale_order_id)
SELECT DISTINCT target.sale_order_id
  FROM _0035_refund_role_pool_targets target
  LEFT JOIN sale_payment_item_allocations current
    ON current.sale_payment_item_receipt_id = target.refund_receipt_id
   AND current.employee_id = target.employee_id
   AND current.role_type = target.role_type
   AND current.is_void = false
 WHERE current.id IS NULL
    OR ABS(ROUND(current.allocated_amount::numeric * 100)::bigint + target.allocated_cents) > 1
    OR ABS(ROUND(COALESCE(current.commission_amount, 0)::numeric * 100)::bigint + target.commission_cents) > 1;
--> statement-breakpoint
INSERT INTO sale_payment_item_allocations (
  sale_payment_item_receipt_id, employee_id, role_type, department_name, allocation_ratio,
  allocated_amount, commission_rate, commission_amount, is_void, created_at, updated_at
)
SELECT target.refund_receipt_id, target.employee_id, target.role_type, target.department_name,
       target.allocation_ratio, ROUND(-target.allocated_cents::numeric / 100, 2),
       target.commission_rate, ROUND(-target.commission_cents::numeric / 100, 2),
       false, NOW(), NOW()
  FROM _0035_refund_role_pool_targets target
  JOIN _0035_touched_orders touched ON touched.sale_order_id = target.sale_order_id
ON CONFLICT (sale_payment_item_receipt_id, employee_id, role_type) WHERE is_void = false
DO UPDATE SET department_name = EXCLUDED.department_name,
              allocation_ratio = EXCLUDED.allocation_ratio,
              allocated_amount = EXCLUDED.allocated_amount,
              commission_rate = EXCLUDED.commission_rate,
              commission_amount = EXCLUDED.commission_amount,
              updated_at = NOW();
--> statement-breakpoint
INSERT INTO operation_logs (
  operator_employee_id, operator_name, action, target_type, target_id, detail, source, created_at
)
SELECT NULL, '系统数据修复', 'datafix.refundRolePoolAllocation', 'sale_order', touched.sale_order_id,
       jsonb_build_object(
         'saleOrderId', touched.sale_order_id,
         'reason', 'rebuild refund allocations independently for every role_type pool'
       ),
       'admin', NOW()
  FROM _0035_touched_orders touched
 WHERE NOT EXISTS (
   SELECT 1 FROM operation_logs ol
    WHERE ol.action = 'datafix.refundRolePoolAllocation'
      AND ol.target_id = touched.sale_order_id
 );
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    WITH receipt_totals AS (
      SELECT spir.sale_order_id, spir.sale_item_id,
             SUM(spir.amount::numeric) FILTER (
               WHERE spir.amount > 0
                 AND sop.status = '已支付'
                 AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
             ) AS positive_receipt,
             ABS(COALESCE(SUM(spir.amount::numeric) FILTER (
               WHERE spir.amount < 0
                 AND sop.status = '已支付'
                 AND sop.change_type = '退款'
             ), 0)) AS refund_receipt
        FROM sale_payment_item_receipts spir
        JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
       GROUP BY spir.sale_order_id, spir.sale_item_id
    ),
    positive_pools AS (
      SELECT spir.sale_order_id, spir.sale_item_id, spia.role_type,
             SUM(spia.allocated_amount::numeric) AS positive_allocated
        FROM sale_payment_item_allocations spia
        JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
        JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
       WHERE spia.is_void = false AND spia.allocated_amount > 0 AND spir.amount > 0
         AND sop.status = '已支付'
         AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
       GROUP BY spir.sale_order_id, spir.sale_item_id, spia.role_type
    ),
    negative_pools AS (
      SELECT spir.sale_order_id, spir.sale_item_id, spia.role_type,
             ABS(SUM(spia.allocated_amount::numeric)) AS negative_allocated
        FROM sale_payment_item_allocations spia
        JOIN sale_payment_item_receipts spir ON spir.id = spia.sale_payment_item_receipt_id
        JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
       WHERE spia.is_void = false AND spia.allocated_amount < 0 AND spir.amount < 0
         AND sop.status = '已支付' AND sop.change_type = '退款'
       GROUP BY spir.sale_order_id, spir.sale_item_id, spia.role_type
    )
    SELECT 1
      FROM positive_pools pp
      JOIN _0035_touched_orders touched ON touched.sale_order_id = pp.sale_order_id
      JOIN receipt_totals rt
        ON rt.sale_order_id = pp.sale_order_id AND rt.sale_item_id = pp.sale_item_id
      LEFT JOIN negative_pools np
        ON np.sale_order_id = pp.sale_order_id
       AND np.sale_item_id = pp.sale_item_id
       AND np.role_type = pp.role_type
     WHERE rt.positive_receipt > 0 AND rt.refund_receipt > 0
       AND ABS(
         COALESCE(np.negative_allocated, 0)
         - LEAST(
             pp.positive_allocated,
             rt.refund_receipt,
             ROUND(rt.refund_receipt * pp.positive_allocated / NULLIF(rt.positive_receipt, 0), 2)
           )
       ) > 0.01
  ) THEN
    RAISE EXCEPTION '0035 refund role-pool allocation invariant still mismatched after repair';
  END IF;
END $$;
