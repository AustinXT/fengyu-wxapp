DROP VIEW "public"."sale_item_performance_events";--> statement-breakpoint
DROP VIEW "public"."sale_order_performance_events";--> statement-breakpoint

-- 同次混合支付只有一个归属事实：储值卡抵扣跟随首次支付/回款主流水。
WITH paired_cards AS (
  SELECT DISTINCT ON (card.id)
    card.id,
    CASE
      WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_date
      ELSE COALESCE(
        primary_payment.performance_attribution_date,
        (primary_payment.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
        (primary_payment.created_at AT TIME ZONE 'Asia/Shanghai')::date
      )
    END AS performance_attribution_date,
    CASE
      WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_adjusted_at
      ELSE primary_payment.performance_attribution_adjusted_at
    END AS performance_attribution_adjusted_at,
    CASE
      WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_adjusted_by
      ELSE primary_payment.performance_attribution_adjusted_by
    END AS performance_attribution_adjusted_by
  FROM sale_order_payments card
  JOIN sale_order_payments primary_payment
    ON primary_payment.sale_order_id = card.sale_order_id
   AND primary_payment.change_type IN ('首次支付', '回款')
   AND primary_payment.status = card.status
   AND primary_payment.paid_at IS NOT DISTINCT FROM card.paid_at
  JOIN sale_orders so ON so.sale_order_id = card.sale_order_id
  WHERE card.change_type = '储值卡抵扣'
  ORDER BY
    card.id,
    CASE WHEN primary_payment.change_type = '首次支付' THEN 0 ELSE 1 END,
    primary_payment.id
)
UPDATE sale_order_payments card
SET performance_attribution_date = paired.performance_attribution_date,
    performance_attribution_adjusted_at = paired.performance_attribution_adjusted_at,
    performance_attribution_adjusted_by = paired.performance_attribution_adjusted_by
FROM paired_cards paired
WHERE card.id = paired.id
  AND (
    card.performance_attribution_date,
    card.performance_attribution_adjusted_at,
    card.performance_attribution_adjusted_by
  ) IS DISTINCT FROM (
    paired.performance_attribution_date,
    paired.performance_attribution_adjusted_at,
    paired.performance_attribution_adjusted_by
  );--> statement-breakpoint

-- 新写入的混合支付卡流水优先继承同次主流水；纯储值卡支付仍按自身 paid_at 初始化。
CREATE OR REPLACE FUNCTION initialize_payment_performance_attribution_date()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.change_type <> '首次支付'
     AND NEW.status = '已支付'
     AND NEW.paid_at IS NOT NULL
     AND NEW.performance_attribution_date IS NULL THEN
    IF NEW.change_type = '储值卡抵扣' THEN
      SELECT
        CASE
          WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_date
          ELSE COALESCE(
            primary_payment.performance_attribution_date,
            (primary_payment.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
            (primary_payment.created_at AT TIME ZONE 'Asia/Shanghai')::date
          )
        END,
        CASE
          WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_adjusted_at
          ELSE primary_payment.performance_attribution_adjusted_at
        END,
        CASE
          WHEN primary_payment.change_type = '首次支付' THEN so.performance_attribution_adjusted_by
          ELSE primary_payment.performance_attribution_adjusted_by
        END
      INTO
        NEW.performance_attribution_date,
        NEW.performance_attribution_adjusted_at,
        NEW.performance_attribution_adjusted_by
      FROM sale_order_payments primary_payment
      JOIN sale_orders so ON so.sale_order_id = primary_payment.sale_order_id
      WHERE primary_payment.sale_order_id = NEW.sale_order_id
        AND primary_payment.change_type IN ('首次支付', '回款')
        AND primary_payment.status = NEW.status
        AND primary_payment.paid_at IS NOT DISTINCT FROM NEW.paid_at
      ORDER BY
        CASE WHEN primary_payment.change_type = '首次支付' THEN 0 ELSE 1 END,
        primary_payment.id
      LIMIT 1;
    END IF;

    IF NEW.performance_attribution_date IS NULL THEN
      NEW.performance_attribution_date := (NEW.paid_at AT TIME ZONE 'Asia/Shanghai')::date;
    END IF;
  END IF;

  -- staff 线下确认会先写卡流水、后写现付主流水；主流水后写时反向同步，保证写入顺序无关。
  IF NEW.change_type IN ('首次支付', '回款')
     AND NEW.status = '已支付'
     AND NEW.paid_at IS NOT NULL THEN
    UPDATE sale_order_payments card
    SET performance_attribution_date = CASE
          WHEN NEW.change_type = '首次支付' THEN (
            SELECT so.performance_attribution_date
            FROM sale_orders so
            WHERE so.sale_order_id = NEW.sale_order_id
          )
          ELSE COALESCE(
            NEW.performance_attribution_date,
            (NEW.paid_at AT TIME ZONE 'Asia/Shanghai')::date
          )
        END,
        performance_attribution_adjusted_at = CASE
          WHEN NEW.change_type = '首次支付' THEN (
            SELECT so.performance_attribution_adjusted_at
            FROM sale_orders so
            WHERE so.sale_order_id = NEW.sale_order_id
          )
          ELSE NEW.performance_attribution_adjusted_at
        END,
        performance_attribution_adjusted_by = CASE
          WHEN NEW.change_type = '首次支付' THEN (
            SELECT so.performance_attribution_adjusted_by
            FROM sale_orders so
            WHERE so.sale_order_id = NEW.sale_order_id
          )
          ELSE NEW.performance_attribution_adjusted_by
        END
    WHERE card.sale_order_id = NEW.sale_order_id
      AND card.change_type = '储值卡抵扣'
      AND card.status = NEW.status
      AND card.paid_at IS NOT DISTINCT FROM NEW.paid_at;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

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
      paired_payment.performance_date AS paired_payment_performance_date,
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
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN primary_payment.change_type = '首次支付'
            THEN so.performance_attribution_date
          ELSE COALESCE(
            primary_payment.performance_attribution_date,
            (primary_payment.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
            (primary_payment.created_at AT TIME ZONE 'Asia/Shanghai')::date
          )
        END AS performance_date
      FROM sale_order_payments primary_payment
      WHERE sop.change_type = '储值卡抵扣'
        AND primary_payment.sale_order_id = sop.sale_order_id
        AND primary_payment.change_type IN ('首次支付', '回款')
        AND primary_payment.status = sop.status
        AND primary_payment.paid_at IS NOT DISTINCT FROM sop.paid_at
      ORDER BY
        CASE WHEN primary_payment.change_type = '首次支付' THEN 0 ELSE 1 END,
        primary_payment.id
      LIMIT 1
    ) paired_payment ON true
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
      WHEN change_type = '储值卡抵扣' AND paired_payment_performance_date IS NOT NULL
        THEN paired_payment_performance_date
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
      paired_payment.performance_date AS paired_payment_performance_date,
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
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN primary_payment.change_type = '首次支付'
            THEN so.performance_attribution_date
          ELSE COALESCE(
            primary_payment.performance_attribution_date,
            (primary_payment.paid_at AT TIME ZONE 'Asia/Shanghai')::date,
            (primary_payment.created_at AT TIME ZONE 'Asia/Shanghai')::date
          )
        END AS performance_date
      FROM sale_order_payments primary_payment
      WHERE sop.change_type = '储值卡抵扣'
        AND primary_payment.sale_order_id = sop.sale_order_id
        AND primary_payment.change_type IN ('首次支付', '回款')
        AND primary_payment.status = sop.status
        AND primary_payment.paid_at IS NOT DISTINCT FROM sop.paid_at
      ORDER BY
        CASE WHEN primary_payment.change_type = '首次支付' THEN 0 ELSE 1 END,
        primary_payment.id
      LIMIT 1
    ) paired_payment ON true
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
      WHEN change_type = '储值卡抵扣' AND paired_payment_performance_date IS NOT NULL
        THEN paired_payment_performance_date
      ELSE COALESCE(
        payment_performance_attribution_date,
        (paid_at AT TIME ZONE 'Asia/Shanghai')::date,
        (created_at AT TIME ZONE 'Asia/Shanghai')::date
      )
    END AS performance_date,
    is_initial_event
  FROM classified
);
