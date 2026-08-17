DROP VIEW "public"."sale_item_performance_events";--> statement-breakpoint
CREATE VIEW "public"."sale_item_performance_events" AS (
  WITH performance_events AS (
    
  WITH classified AS (
    SELECT
      sop.id AS sale_payment_id,
      sop.sale_order_id,
      so.store_id,
      so.sale_order_type,
      so.legacy_source,
      sop.change_type,
      sop.payment_method,
      sop.status,
      sop.amount,
      sop.paid_at,
      so.performance_attribution_date,
      (
        sop.change_type = '首次支付'
        OR (
          sop.change_type = '储值卡抵扣'
          AND sop.status = '已支付'
          AND NOT EXISTS (
            SELECT 1
            FROM sale_order_payments prior
            WHERE prior.sale_order_id = sop.sale_order_id
              AND prior.status = '已支付'
              AND prior.change_type IN ('首次支付', '回款', '储值卡抵扣')
              AND (
                COALESCE(prior.paid_at, prior.created_at),
                prior.id
              ) < (
                COALESCE(sop.paid_at, sop.created_at),
                sop.id
              )
          )
        )
      ) AS is_initial_event
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
  )
  SELECT
    sale_payment_id,
    sale_order_id,
    store_id,
    sale_order_type,
    legacy_source,
    change_type,
    payment_method,
    status,
    amount,
    paid_at,
    CASE
      WHEN is_initial_event THEN performance_attribution_date
      ELSE (COALESCE(paid_at, CURRENT_TIMESTAMP) AT TIME ZONE 'Asia/Shanghai')::date
    END AS performance_date,
    is_initial_event
  FROM classified

  ),
  paid_receipts AS (
    SELECT
      spir.id,
      spir.sale_payment_id,
      spir.sale_order_id,
      spir.sale_item_id,
      spir.amount,
      spir.sales_category,
      spe.store_id,
      spe.change_type,
      spe.performance_date,
      spe.is_initial_event
    FROM sale_payment_item_receipts spir
    JOIN performance_events spe
      ON spe.sale_payment_id = spir.sale_payment_id
     AND spe.status = '已支付'
  ),
  receipt_totals AS (
    SELECT sale_item_id, SUM(amount)::numeric(10, 2) AS amount
    FROM paid_receipts
    GROUP BY sale_item_id
  ),
  residuals AS (
    SELECT
      si.sale_item_id,
      si.sale_order_id,
      so.store_id,
      ROUND(si.received::numeric - COALESCE(rt.amount, 0)::numeric, 2)::numeric(10, 2) AS amount,
      si.sales_category,
      so.performance_attribution_date
    FROM sale_items si
    JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
    LEFT JOIN receipt_totals rt ON rt.sale_item_id = si.sale_item_id
    WHERE ROUND(si.received::numeric - COALESCE(rt.amount, 0)::numeric, 2) <> 0
  )
  SELECT
    'receipt:' || pr.id::text AS event_key,
    pr.id AS receipt_id,
    pr.sale_payment_id,
    pr.sale_order_id,
    pr.sale_item_id,
    pr.store_id,
    pr.amount,
    pr.sales_category,
    pr.change_type,
    pr.performance_date,
    pr.is_initial_event,
    false AS is_legacy_residual
  FROM paid_receipts pr
  UNION ALL
  SELECT
    'residual:' || r.sale_item_id AS event_key,
    NULL::bigint AS receipt_id,
    NULL::bigint AS sale_payment_id,
    r.sale_order_id,
    r.sale_item_id,
    r.store_id,
    r.amount,
    r.sales_category,
    '首次支付'::payment_change_type AS change_type,
    r.performance_attribution_date AS performance_date,
    true AS is_initial_event,
    true AS is_legacy_residual
  FROM residuals r
);--> statement-breakpoint

-- WorkFine 旧导入器曾把 SQL Server 墙上时间序列化成 UTC 字面量。
-- 原始快照的日期前缀不受时区影响；缺少快照时回退到 timestamptz 的 UTC 日期部分。
WITH workfine_dates AS (
  SELECT sale_order_id,
         COALESCE(
           (substring(legacy_raw_snapshot ->> 'sale_date' FROM '^(\d{4}-\d{2}-\d{2})'))::date,
           (sale_order_datetime AT TIME ZONE 'UTC')::date
         ) AS business_date
  FROM sale_orders
  WHERE legacy_source = 'workfine'
)
UPDATE sale_orders so
SET performance_attribution_date = wd.business_date,
    updated_at = NOW()
FROM workfine_dates wd
WHERE so.sale_order_id = wd.sale_order_id
  AND so.performance_attribution_date IS DISTINCT FROM wd.business_date;--> statement-breakpoint

-- 0011 已在旧环境执行时，终态订单的旧 prepaid_card_amount 已被清零，不能再依赖该快照恢复。
-- card_transactions 的有符号净额保留了真实扣卡事实；与现有已支付卡款流水比较后只补正向缺口。
-- 差额算法使本段可重复执行：首次补齐后 settled_prepaid 与 evidenced_prepaid 相等，不会再次插入。
WITH card_evidence AS (
  SELECT ct.ref_order_id AS sale_order_id,
         GREATEST(0, ROUND(-SUM(ct.amount::numeric), 2))::numeric(10, 2) AS evidenced_prepaid,
         MIN(ct.created_at) AS first_card_at
  FROM card_transactions ct
  JOIN sale_orders so ON so.sale_order_id = ct.ref_order_id
  WHERE ct.ref_order_id IS NOT NULL
    AND so.sale_order_type IN ('销售单', '内部单', '转换单')
  GROUP BY ct.ref_order_id
),
settled_card_payments AS (
  SELECT so.sale_order_id,
         GREATEST(0, COALESCE(SUM(sop.amount::numeric) FILTER (
           WHERE sop.status = '已支付'
             AND (sop.change_type = '储值卡抵扣'
                  OR (sop.change_type = '退款' AND sop.payment_method = '储值卡'))
         ), 0))::numeric(10, 2) AS settled_prepaid
  FROM sale_orders so
  LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
  WHERE so.sale_order_type IN ('销售单', '内部单', '转换单')
  GROUP BY so.sale_order_id
),
missing_card_payments AS (
  SELECT ce.sale_order_id,
         ROUND(ce.evidenced_prepaid - scp.settled_prepaid, 2)::numeric(10, 2) AS missing_prepaid,
         ce.first_card_at
  FROM card_evidence ce
  JOIN settled_card_payments scp ON scp.sale_order_id = ce.sale_order_id
  WHERE ROUND(ce.evidenced_prepaid - scp.settled_prepaid, 2) > 0
)
INSERT INTO sale_order_payments (
  sale_order_id, change_type, amount, payment_method, external_txn_id,
  status, source_end, operator_employee_id, note, created_at, paid_at
)
SELECT mcp.sale_order_id,
       '储值卡抵扣'::payment_change_type,
       mcp.missing_prepaid,
       '储值卡'::payment_method,
       NULL,
       '已支付'::payment_flow_status,
       'admin'::payment_source_end,
       NULL,
       'migration:0012:card-transaction-recovery',
       COALESCE(mcp.first_card_at, so.paid_at, so.sale_order_datetime, so.created_at),
       COALESCE(mcp.first_card_at, so.paid_at, so.sale_order_datetime, so.created_at)
FROM missing_card_payments mcp
JOIN sale_orders so ON so.sale_order_id = mcp.sale_order_id;--> statement-breakpoint

-- 从权威支付流水重建订单 actual 卡款；payable 始终从 total 减 actual/pending 计算，禁止在旧值上累加减造成二次放大。
WITH card_totals AS (
  SELECT so.sale_order_id,
         GREATEST(0, COALESCE(SUM(sop.amount::numeric) FILTER (
           WHERE sop.status = '已支付'
             AND (sop.change_type = '储值卡抵扣'
                  OR (sop.change_type = '退款' AND sop.payment_method = '储值卡'))
         ), 0))::numeric(10, 2) AS settled_prepaid
  FROM sale_orders so
  LEFT JOIN sale_order_payments sop ON sop.sale_order_id = so.sale_order_id
  WHERE so.sale_order_type IN ('销售单', '内部单', '转换单')
  GROUP BY so.sale_order_id
),
order_targets AS (
  SELECT so.sale_order_id,
         ct.settled_prepaid,
         GREATEST(
           0,
           so.total_amount::numeric - ct.settled_prepaid - so.pending_prepaid_card_amount::numeric
         )::numeric(10, 2) AS payable
  FROM sale_orders so
  JOIN card_totals ct ON ct.sale_order_id = so.sale_order_id
)
UPDATE sale_orders so
SET prepaid_card_amount = ot.settled_prepaid,
    payable_amount = ot.payable,
    updated_at = NOW()
FROM order_targets ot
WHERE so.sale_order_id = ot.sale_order_id
  AND (so.prepaid_card_amount IS DISTINCT FROM ot.settled_prepaid
       OR so.payable_amount IS DISTINCT FROM ot.payable);--> statement-breakpoint

-- 同步重建行级储值卡快照。累计比例相减让分币结果精确闭合，且同号正向行不会出现负尾差。
WITH ranked AS (
  SELECT si.sale_item_id,
         si.sale_order_id,
         si.received::numeric AS item_received,
         so.prepaid_card_amount::numeric AS prepaid_total,
         SUM(si.received::numeric) OVER (PARTITION BY si.sale_order_id) AS received_total,
         SUM(si.received::numeric) OVER (
           PARTITION BY si.sale_order_id
           ORDER BY si.sale_item_id
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS cumulative_received
  FROM sale_items si
  JOIN sale_orders so ON so.sale_order_id = si.sale_order_id
  WHERE si.received::numeric <> 0
),
allocated AS (
  SELECT sale_item_id,
         (
           ROUND(prepaid_total * cumulative_received / received_total, 2)
           - ROUND(prepaid_total * (cumulative_received - item_received) / received_total, 2)
         )::numeric(10, 2) AS prepaid_share
  FROM ranked
  WHERE received_total <> 0 AND prepaid_total <> 0
),
targets AS (
  SELECT si.sale_item_id,
         COALESCE(a.prepaid_share, 0)::numeric(10, 2) AS prepaid_share
  FROM sale_items si
  LEFT JOIN allocated a ON a.sale_item_id = si.sale_item_id
)
UPDATE sale_items si
SET prepaid_card_received = targets.prepaid_share,
    updated_at = NOW()
FROM targets
WHERE si.sale_item_id = targets.sale_item_id
  AND si.prepaid_card_received IS DISTINCT FROM targets.prepaid_share;
