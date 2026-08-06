DO $$
DECLARE
  order_rec RECORD;
  pay_rec RECORD;
  evt_cents INTEGER;
  pend_total_cents INTEGER;
  phase1_cents INTEGER;
  phase2_cents INTEGER;
  first_item_id VARCHAR(30);
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _0082_positive_receipt_rebuild_orders (
    sale_order_id VARCHAR(30) PRIMARY KEY
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _0082_positive_receipt_rebuild_items (
    sale_item_id VARCHAR(30) PRIMARY KEY,
    sale_amount_cents INTEGER NOT NULL,
    pending_cents INTEGER NOT NULL,
    prior_cents INTEGER NOT NULL DEFAULT 0,
    sales_category sales_category
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _0082_positive_receipt_rebuild_parts (
    sale_payment_id BIGINT NOT NULL,
    sale_item_id VARCHAR(30) NOT NULL,
    amount_cents INTEGER NOT NULL,
    PRIMARY KEY (sale_payment_id, sale_item_id)
  ) ON COMMIT DROP;

  TRUNCATE _0082_positive_receipt_rebuild_orders;

  INSERT INTO _0082_positive_receipt_rebuild_orders (sale_order_id)
  SELECT so.sale_order_id
    FROM sale_orders so
   WHERE so.sale_order_type IN ('销售单','转换单')
     AND so.legacy_source IS DISTINCT FROM 'workfine'
     AND EXISTS (
       SELECT 1
         FROM sale_items si
        WHERE si.sale_order_id = so.sale_order_id
          AND si.item_direction = '购买'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM sale_allocations sa
         JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
        WHERE si.sale_order_id = so.sale_order_id
          AND COALESCE(sa.is_void, false) = false
     )
     AND NOT EXISTS (
       SELECT 1
         FROM sale_payment_item_receipts spir
         JOIN sale_order_payments sop ON sop.id = spir.sale_payment_id
         JOIN sale_payment_item_allocations spia ON spia.sale_payment_item_receipt_id = spir.id
        WHERE sop.sale_order_id = so.sale_order_id
          AND sop.status = '已支付'
          AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
          AND spia.is_void = false
     )
     AND EXISTS (
       SELECT 1
         FROM sale_order_payments p
         LEFT JOIN sale_payment_item_receipts r ON r.sale_payment_id = p.id
        WHERE p.sale_order_id = so.sale_order_id
          AND p.status = '已支付'
          AND p.amount::numeric > 0
          AND p.change_type IN ('首次支付','回款','储值卡抵扣')
        GROUP BY p.id, p.amount
       HAVING ABS(p.amount::numeric - COALESCE(SUM(r.amount::numeric), 0)) > 0.01
     );

  FOR order_rec IN
    SELECT sale_order_id FROM _0082_positive_receipt_rebuild_orders ORDER BY sale_order_id
  LOOP
    TRUNCATE _0082_positive_receipt_rebuild_items;
    TRUNCATE _0082_positive_receipt_rebuild_parts;

    INSERT INTO _0082_positive_receipt_rebuild_items
      (sale_item_id, sale_amount_cents, pending_cents, prior_cents, sales_category)
    SELECT sale_item_id,
           ROUND(sale_amount::numeric * 100)::integer,
           ROUND(pending_received::numeric * 100)::integer,
           0,
           sales_category
      FROM sale_items
     WHERE sale_order_id = order_rec.sale_order_id
       AND item_direction = '购买'
     ORDER BY sale_item_id;

    DELETE FROM sale_payment_item_receipts spir
      USING sale_order_payments sop
     WHERE spir.sale_payment_id = sop.id
       AND sop.sale_order_id = order_rec.sale_order_id
       AND sop.status = '已支付'
       AND sop.change_type IN ('首次支付','回款','储值卡抵扣');

    FOR pay_rec IN
      SELECT id, amount, COALESCE(paid_at, created_at, NOW()) AS receipt_created_at
        FROM sale_order_payments
       WHERE sale_order_id = order_rec.sale_order_id
         AND status = '已支付'
         AND amount::numeric > 0
         AND change_type IN ('首次支付','回款','储值卡抵扣')
       ORDER BY paid_at NULLS LAST, id
    LOOP
      evt_cents := ROUND(pay_rec.amount::numeric * 100)::integer;
      SELECT COALESCE(SUM(GREATEST(0, pending_cents - prior_cents)), 0)
        INTO pend_total_cents
        FROM _0082_positive_receipt_rebuild_items;
      phase1_cents := LEAST(evt_cents, pend_total_cents);
      phase2_cents := evt_cents - phase1_cents;

      IF phase1_cents > 0 THEN
        INSERT INTO _0082_positive_receipt_rebuild_parts
          (sale_payment_id, sale_item_id, amount_cents)
        WITH caps AS (
          SELECT sale_item_id,
                 GREATEST(0, pending_cents - prior_cents) AS cap_cents
            FROM _0082_positive_receipt_rebuild_items
        ),
        weighted AS (
          SELECT sale_item_id,
                 FLOOR(phase1_cents::numeric * cap_cents::numeric / SUM(cap_cents) OVER ())::integer AS cents,
                 (phase1_cents::numeric * cap_cents::numeric / SUM(cap_cents) OVER ())
                   - FLOOR(phase1_cents::numeric * cap_cents::numeric / SUM(cap_cents) OVER ()) AS frac
            FROM caps
           WHERE cap_cents > 0
        ),
        ranked AS (
          SELECT *,
                 ROW_NUMBER() OVER (ORDER BY frac DESC, sale_item_id) AS rn,
                 phase1_cents - SUM(cents) OVER () AS rem_cents
            FROM weighted
        )
        SELECT pay_rec.id,
               sale_item_id,
               cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END
          FROM ranked
         WHERE cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END > 0
        ON CONFLICT (sale_payment_id, sale_item_id)
        DO UPDATE SET amount_cents = _0082_positive_receipt_rebuild_parts.amount_cents + EXCLUDED.amount_cents;
      END IF;

      IF phase2_cents > 0 THEN
        INSERT INTO _0082_positive_receipt_rebuild_parts
          (sale_payment_id, sale_item_id, amount_cents)
        WITH caps AS (
          SELECT sale_item_id,
                 GREATEST(0, sale_amount_cents - GREATEST(pending_cents, prior_cents)) AS cap_cents
            FROM _0082_positive_receipt_rebuild_items
        ),
        weighted AS (
          SELECT sale_item_id,
                 FLOOR(phase2_cents::numeric * cap_cents::numeric / SUM(cap_cents) OVER ())::integer AS cents,
                 (phase2_cents::numeric * cap_cents::numeric / SUM(cap_cents) OVER ())
                   - FLOOR(phase2_cents::numeric * cap_cents::numeric / SUM(cap_cents) OVER ()) AS frac
            FROM caps
           WHERE cap_cents > 0
        ),
        ranked AS (
          SELECT *,
                 ROW_NUMBER() OVER (ORDER BY frac DESC, sale_item_id) AS rn,
                 phase2_cents - SUM(cents) OVER () AS rem_cents
            FROM weighted
        )
        SELECT pay_rec.id,
               sale_item_id,
               cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END
          FROM ranked
         WHERE cents + CASE WHEN rn <= rem_cents THEN 1 ELSE 0 END > 0
        ON CONFLICT (sale_payment_id, sale_item_id)
        DO UPDATE SET amount_cents = _0082_positive_receipt_rebuild_parts.amount_cents + EXCLUDED.amount_cents;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM _0082_positive_receipt_rebuild_parts WHERE sale_payment_id = pay_rec.id
      ) THEN
        SELECT sale_item_id
          INTO first_item_id
          FROM _0082_positive_receipt_rebuild_items
         ORDER BY sale_item_id
         LIMIT 1;
        IF first_item_id IS NOT NULL AND evt_cents > 0 THEN
          INSERT INTO _0082_positive_receipt_rebuild_parts
            (sale_payment_id, sale_item_id, amount_cents)
          VALUES (pay_rec.id, first_item_id, evt_cents)
          ON CONFLICT (sale_payment_id, sale_item_id)
          DO UPDATE SET amount_cents = _0082_positive_receipt_rebuild_parts.amount_cents + EXCLUDED.amount_cents;
        END IF;
      END IF;

      INSERT INTO sale_payment_item_receipts
        (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
      SELECT p.sale_payment_id,
             order_rec.sale_order_id,
             p.sale_item_id,
             ROUND(p.amount_cents::numeric / 100, 2),
             i.sales_category,
             pay_rec.receipt_created_at
        FROM _0082_positive_receipt_rebuild_parts p
        JOIN _0082_positive_receipt_rebuild_items i ON i.sale_item_id = p.sale_item_id
       WHERE p.sale_payment_id = pay_rec.id
         AND p.amount_cents > 0
      ON CONFLICT (sale_payment_id, sale_item_id)
      DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category;

      UPDATE _0082_positive_receipt_rebuild_items i
         SET prior_cents = prior_cents + p.amount_cents
        FROM _0082_positive_receipt_rebuild_parts p
       WHERE p.sale_payment_id = pay_rec.id
         AND p.sale_item_id = i.sale_item_id;

      UPDATE sale_order_payments
         SET allocation_status = '待分配'
       WHERE id = pay_rec.id
         AND EXISTS (
           SELECT 1 FROM _0082_positive_receipt_rebuild_parts p WHERE p.sale_payment_id = pay_rec.id
         );
    END LOOP;

    UPDATE sale_orders
       SET allocation_status = CASE
             WHEN EXISTS (
               SELECT 1 FROM sale_order_payments
                WHERE sale_order_id = order_rec.sale_order_id AND allocation_status = '待分配'
             ) THEN '待分配'::allocation_status
             WHEN EXISTS (
               SELECT 1 FROM sale_order_payments
                WHERE sale_order_id = order_rec.sale_order_id AND allocation_status IS NOT NULL
             ) THEN '已分配'::allocation_status
             ELSE sale_orders.allocation_status END,
           updated_at = NOW()
     WHERE sale_order_id = order_rec.sale_order_id;
  END LOOP;
END $$;
--> statement-breakpoint
WITH stale_positive_payment_status AS (
  UPDATE sale_order_payments sop
     SET allocation_status = '待分配'
    FROM sale_orders so
   WHERE sop.sale_order_id = so.sale_order_id
     AND sop.status = '已支付'
     AND sop.amount::numeric > 0
     AND sop.change_type IN ('首次支付','回款','储值卡抵扣')
     AND sop.allocation_status = '已分配'
     AND so.sale_order_type IN ('销售单','转换单')
     AND so.legacy_source IS DISTINCT FROM 'workfine'
     AND GREATEST(COALESCE(so.received::numeric, 0) - COALESCE(so.refunded_amount::numeric, 0), 0) > 0.01
     AND NOT EXISTS (
       SELECT 1
         FROM sale_allocations sa
         JOIN sale_items si ON si.sale_item_id = sa.sale_item_id
        WHERE si.sale_order_id = so.sale_order_id
          AND COALESCE(sa.is_void, false) = false
     )
     AND EXISTS (
       SELECT 1
         FROM sale_payment_item_receipts spir
        WHERE spir.sale_payment_id = sop.id
          AND spir.amount::numeric <> 0
     )
     AND NOT EXISTS (
       SELECT 1
         FROM sale_payment_item_receipts spir
         JOIN sale_payment_item_allocations spia
           ON spia.sale_payment_item_receipt_id = spir.id
          AND spia.is_void = false
        WHERE spir.sale_payment_id = sop.id
     )
  RETURNING sop.sale_order_id
)
UPDATE sale_orders so
   SET allocation_status = '待分配',
       updated_at = NOW()
 WHERE so.sale_order_id IN (
   SELECT sale_order_id FROM stale_positive_payment_status
 );
