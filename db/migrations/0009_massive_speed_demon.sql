ALTER TABLE "sale_orders" ADD COLUMN "performance_attribution_date" date DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "performance_attribution_adjusted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "performance_attribution_adjusted_by" varchar(30);--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_performance_attribution_adjusted_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("performance_attribution_adjusted_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sale_orders_performance_date_store" ON "sale_orders" USING btree ("performance_attribution_date","store_id");--> statement-breakpoint
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
CREATE VIEW "public"."sale_order_performance_events" AS (
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
);--> statement-breakpoint

-- 历史订单必须按真实订单上海自然日回填，不能保留 ADD COLUMN 时的迁移执行日默认值。
UPDATE sale_orders
SET performance_attribution_date = (sale_order_datetime AT TIME ZONE 'Asia/Shanghai')::date;--> statement-breakpoint

-- 新动作仅默认授予系统管理员、店长和内置财务；自定义普通角色不自动扩权。
UPDATE permission_role_definitions
SET actions = array_append(actions, 'sale_order:performance_attribution_update'),
    updated_at = NOW(),
    updated_by = 'migration:0009_performance_attribution'
WHERE (is_super_admin = true OR is_store_manager = true OR role_key = 'finance')
  AND NOT ('sale_order:performance_attribution_update' = ANY(actions));
