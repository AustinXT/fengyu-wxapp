DROP VIEW "public"."sale_item_performance_events";--> statement-breakpoint
DROP VIEW "public"."sale_order_performance_events";--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "performance_attribution_date" date;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "performance_attribution_adjusted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD COLUMN "performance_attribution_adjusted_by" varchar(30);--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_performance_attribution_adjusted_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("performance_attribution_adjusted_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sop_paid_at_id" ON "sale_order_payments" USING btree ("paid_at","id") WHERE paid_at IS NOT NULL;--> statement-breakpoint
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
      sop.created_at,
      sop.performance_attribution_date AS payment_performance_attribution_date,
      so.performance_attribution_date AS order_performance_attribution_date,
      (
        sop.status = '已支付'
        AND sop.amount::numeric > 0
        AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
        AND NOT EXISTS (
          SELECT 1
          FROM sale_order_payments prior
          WHERE prior.sale_order_id = sop.sale_order_id
            AND prior.status = '已支付'
            AND prior.amount::numeric > 0
            AND prior.change_type IN ('首次支付', '回款', '储值卡抵扣')
            AND (
              COALESCE(prior.paid_at, prior.created_at),
              prior.id
            ) < (
              COALESCE(sop.paid_at, sop.created_at),
              sop.id
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
      WHEN change_type = '首次支付' THEN order_performance_attribution_date
      ELSE COALESCE(
        payment_performance_attribution_date,
        (paid_at AT TIME ZONE 'Asia/Shanghai')::date,
        (created_at AT TIME ZONE 'Asia/Shanghai')::date
      )
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
      sop.created_at,
      sop.performance_attribution_date AS payment_performance_attribution_date,
      so.performance_attribution_date AS order_performance_attribution_date,
      (
        sop.status = '已支付'
        AND sop.amount::numeric > 0
        AND sop.change_type IN ('首次支付', '回款', '储值卡抵扣')
        AND NOT EXISTS (
          SELECT 1
          FROM sale_order_payments prior
          WHERE prior.sale_order_id = sop.sale_order_id
            AND prior.status = '已支付'
            AND prior.amount::numeric > 0
            AND prior.change_type IN ('首次支付', '回款', '储值卡抵扣')
            AND (
              COALESCE(prior.paid_at, prior.created_at),
              prior.id
            ) < (
              COALESCE(sop.paid_at, sop.created_at),
              sop.id
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
      WHEN change_type = '首次支付' THEN order_performance_attribution_date
      ELSE COALESCE(
        payment_performance_attribution_date,
        (paid_at AT TIME ZONE 'Asia/Shanghai')::date,
        (created_at AT TIME ZONE 'Asia/Shanghai')::date
      )
    END AS performance_date,
    is_initial_event
  FROM classified
);--> statement-breakpoint

-- 首次支付继续跟随订单归属日；其余已有款项按真实 paid_at 上海自然日回填。
UPDATE sale_order_payments
SET performance_attribution_date = (paid_at AT TIME ZONE 'Asia/Shanghai')::date
WHERE change_type <> '首次支付'
  AND paid_at IS NOT NULL
  AND performance_attribution_date IS NULL;--> statement-breakpoint

-- 所有写入端共用数据库守卫：线上待支付流水在回调转为已支付时也能按最终 paid_at 初始化，
-- 避免 admin / clientApi / staffApi / payNotify 独立 SQL 副本发生口径漂移。
CREATE OR REPLACE FUNCTION initialize_payment_performance_attribution_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.change_type <> '首次支付'
     AND NEW.status = '已支付'
     AND NEW.paid_at IS NOT NULL
     AND NEW.performance_attribution_date IS NULL THEN
    NEW.performance_attribution_date := (NEW.paid_at AT TIME ZONE 'Asia/Shanghai')::date;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER trg_sale_order_payments_performance_attribution
BEFORE INSERT OR UPDATE OF status, paid_at, performance_attribution_date
ON sale_order_payments
FOR EACH ROW
EXECUTE FUNCTION initialize_payment_performance_attribution_date();
