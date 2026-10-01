ALTER TABLE "sale_items" ADD COLUMN "product_kind_at_sale" text;--> statement-breakpoint
-- 历史订单只能按迁移时的 SKU 分类补一次快照；之后商品改类不重算已售订单。
UPDATE sale_items si
SET product_kind_at_sale = pc.product_kind
FROM product_skus sk
JOIN product_categories pc ON pc.category_id = sk.category_id
WHERE si.sku_id = sk.sku_id;--> statement-breakpoint
CREATE OR REPLACE FUNCTION snapshot_sale_item_product_kind() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.sku_id IS NOT DISTINCT FROM OLD.sku_id THEN
    NEW.product_kind_at_sale := OLD.product_kind_at_sale;
    RETURN NEW;
  END IF;
  SELECT pc.product_kind INTO NEW.product_kind_at_sale
  FROM product_skus sk
  JOIN product_categories pc ON pc.category_id = sk.category_id
  WHERE sk.sku_id = NEW.sku_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER trg_sale_item_product_kind_snapshot
BEFORE INSERT OR UPDATE OF sku_id ON sale_items
FOR EACH ROW EXECUTE FUNCTION snapshot_sale_item_product_kind();--> statement-breakpoint
CREATE VIEW "public"."sale_reportable_payment_events" AS (
  WITH receipt_summary AS (
    SELECT spir.sale_payment_id,
           COUNT(*) AS receipt_count,
           SUM(spir.amount::numeric) AS receipt_amount,
           COALESCE(SUM(spir.amount::numeric) FILTER (
             WHERE si.product_kind_at_sale IS DISTINCT FROM '拓客引流卡'
           ), 0) AS regular_amount,
           COUNT(*) FILTER (WHERE si.product_kind_at_sale IS NULL) AS unknown_count
    FROM sale_payment_item_receipts spir
    LEFT JOIN sale_items si ON si.sale_item_id = spir.sale_item_id
    GROUP BY spir.sale_payment_id
  )
  SELECT spe.sale_payment_id, spe.sale_order_id, spe.store_id,
         spe.sale_order_type, spe.legacy_source, spe.change_type,
         spe.payment_method, spe.status, spe.amount,
         CASE
           WHEN spe.status <> '已支付'
             OR spe.change_type NOT IN ('首次支付', '回款', '退款') THEN 0::numeric(10, 2)
           WHEN spe.sale_order_type = '充值单'
             OR rs.receipt_count IS NULL
             OR rs.receipt_amount = 0 THEN spe.amount
           ELSE ROUND(
             spe.amount::numeric * LEAST(1::numeric, GREATEST(0::numeric,
               rs.regular_amount / rs.receipt_amount)), 2
           )::numeric(10, 2)
         END AS performance_amount,
         spe.paid_at, spe.performance_date, spe.is_initial_event,
         CASE
           WHEN spe.sale_order_type = '充值单' THEN 'recharge'
           WHEN rs.receipt_count IS NULL THEN 'no_receipt'
           WHEN rs.receipt_amount = 0 THEN 'zero_denominator'
           WHEN rs.unknown_count > 0 THEN 'missing_category'
           ELSE 'classified'
         END AS attribution_mode
  FROM sale_order_performance_events spe
  LEFT JOIN receipt_summary rs ON rs.sale_payment_id = spe.sale_payment_id
);
--> statement-breakpoint
CREATE VIEW "public"."sale_reportable_item_events" AS (
  WITH receipt_base AS (
    SELECT sipe.receipt_id, sipe.sale_payment_id, sipe.amount::numeric AS amount,
           si.product_kind_at_sale,
           spe.amount::numeric AS payment_amount,
           spe.change_type AS payment_change_type,
           spe.performance_amount::numeric AS cash_performance_amount,
           SUM(sipe.amount::numeric)
             OVER (PARTITION BY sipe.sale_payment_id) AS receipt_total,
           SUM(CASE WHEN si.product_kind_at_sale IS DISTINCT FROM '拓客引流卡'
               THEN sipe.amount::numeric ELSE 0 END)
             OVER (PARTITION BY sipe.sale_payment_id) AS eligible_total,
           MAX(CASE WHEN si.product_kind_at_sale IS DISTINCT FROM '拓客引流卡'
               THEN sipe.receipt_id END)
             OVER (PARTITION BY sipe.sale_payment_id) AS last_eligible_receipt_id
    FROM sale_item_performance_events sipe
    JOIN sale_reportable_payment_events spe ON spe.sale_payment_id = sipe.sale_payment_id
    JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
    WHERE sipe.receipt_id IS NOT NULL
  ),
  receipt_scaled AS (
    SELECT rb.*,
           CASE WHEN rb.payment_change_type = '储值卡抵扣'
                THEN CASE WHEN rb.receipt_total = 0 THEN rb.payment_amount
                          ELSE ROUND(rb.payment_amount * LEAST(1::numeric, GREATEST(0::numeric,
                            rb.eligible_total / rb.receipt_total)), 2)
                     END
                ELSE rb.cash_performance_amount
           END AS payment_performance_amount
    FROM receipt_base rb
  ),
  receipt_bounded AS (
    SELECT rb.*,
           CASE WHEN rb.payment_performance_amount > 0 AND rb.eligible_total > 0
                  THEN LEAST(rb.payment_performance_amount, rb.eligible_total)
                WHEN rb.payment_performance_amount < 0 AND rb.eligible_total < 0
                  THEN GREATEST(rb.payment_performance_amount, rb.eligible_total)
                ELSE 0::numeric
           END AS allocatable_amount
    FROM receipt_scaled rb
  ),
  receipt_rounded AS (
    SELECT rb.*,
           CASE WHEN rb.product_kind_at_sale = '拓客引流卡' OR rb.eligible_total = 0
                THEN 0::numeric
                ELSE ROUND(rb.allocatable_amount * rb.amount / rb.eligible_total, 2)
           END AS rounded_amount
    FROM receipt_bounded rb
  ),
  receipt_final AS (
    SELECT rr.receipt_id,
           CASE WHEN rr.eligible_total <> 0 AND rr.receipt_id = rr.last_eligible_receipt_id
                THEN rr.allocatable_amount
                   - SUM(rr.rounded_amount) OVER (PARTITION BY rr.sale_payment_id)
                   + rr.rounded_amount
                ELSE rr.rounded_amount
           END::numeric(10, 2) AS performance_amount
    FROM receipt_rounded rr
  )
  SELECT sipe.event_key, sipe.receipt_id, sipe.sale_payment_id,
         sipe.sale_order_id, sipe.sale_item_id, sipe.store_id, sipe.amount,
         CASE WHEN sipe.is_legacy_residual
              THEN CASE WHEN si.product_kind_at_sale = '拓客引流卡'
                        THEN 0::numeric(10, 2) ELSE sipe.amount END
              ELSE COALESCE(rf.performance_amount, 0::numeric(10, 2))
         END AS performance_amount,
         si.product_kind_at_sale, sipe.sales_category, sipe.change_type,
         sipe.performance_date, sipe.is_initial_event, sipe.is_legacy_residual
  FROM sale_item_performance_events sipe
  JOIN sale_items si ON si.sale_item_id = sipe.sale_item_id
  LEFT JOIN receipt_final rf ON rf.receipt_id = sipe.receipt_id
);--> statement-breakpoint
