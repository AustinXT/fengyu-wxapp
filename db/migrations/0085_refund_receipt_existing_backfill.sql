WITH note_refund_items AS (
  SELECT sop.id AS sale_payment_id,
         sop.sale_order_id,
         elem ->> 'refSaleItemId' AS sale_item_id,
         SUM(COALESCE((elem ->> 'refundAmount')::numeric, 0)) AS refund_amount,
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
     AND elem ->> 'refSaleItemId' IS NOT NULL
     AND elem ->> 'refSaleItemId' <> 'OVERPAY'
     AND COALESCE(elem ->> 'kind', '') <> 'OVERPAY'
   GROUP BY sop.id, sop.sale_order_id, elem ->> 'refSaleItemId'
),
legacy_single_refund_items AS (
  SELECT sop.id AS sale_payment_id,
         sop.sale_order_id,
         sop.ref_sale_item_id AS sale_item_id,
         ABS(sop.amount::numeric) AS refund_amount,
         COALESCE(sop.paid_at, sop.created_at, NOW()) AS created_at
    FROM sale_order_payments sop
    JOIN sale_orders so ON so.sale_order_id = sop.sale_order_id
   WHERE sop.change_type = '退款'
     AND sop.status = '已支付'
     AND sop.amount::numeric < 0
     AND so.sale_order_type IN ('销售单','转换单')
     AND so.legacy_source IS DISTINCT FROM 'workfine'
     AND sop.ref_sale_item_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM note_refund_items nri WHERE nri.sale_payment_id = sop.id
     )
),
refund_receipts AS (
  SELECT ri.sale_payment_id,
         ri.sale_order_id,
         ri.sale_item_id,
         -ABS(SUM(ri.refund_amount)) AS amount,
         si.sales_category,
         MIN(ri.created_at) AS created_at
    FROM (
      SELECT * FROM note_refund_items
      UNION ALL
      SELECT * FROM legacy_single_refund_items
    ) ri
    JOIN sale_items si
      ON si.sale_order_id = ri.sale_order_id
     AND si.sale_item_id = ri.sale_item_id
     AND si.item_direction = '购买'
   WHERE ri.refund_amount > 0
   GROUP BY ri.sale_payment_id, ri.sale_order_id, ri.sale_item_id, si.sales_category
)
INSERT INTO sale_payment_item_receipts
  (sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at)
SELECT sale_payment_id, sale_order_id, sale_item_id, amount, sales_category, created_at
  FROM refund_receipts
 WHERE amount IS NOT NULL
ON CONFLICT (sale_payment_id, sale_item_id)
DO UPDATE SET amount = EXCLUDED.amount, sales_category = EXCLUDED.sales_category;
--> statement-breakpoint
WITH full_refund_without_alloc AS (
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
     AND NOT EXISTS (
       SELECT 1
         FROM sale_payment_item_receipts spir
         JOIN sale_payment_item_allocations spia
           ON spia.sale_payment_item_receipt_id = spir.id
          AND spia.is_void = false
        WHERE spir.sale_order_id = so.sale_order_id
     )
),
cleared_payments AS (
  UPDATE sale_order_payments sop
     SET allocation_status = NULL
    FROM full_refund_without_alloc f
   WHERE sop.sale_order_id = f.sale_order_id
     AND sop.allocation_status IS NOT NULL
  RETURNING sop.sale_order_id
)
UPDATE sale_orders so
   SET allocation_status = NULL,
       updated_at = NOW()
 WHERE so.sale_order_id IN (
   SELECT sale_order_id FROM full_refund_without_alloc
   UNION
   SELECT sale_order_id FROM cleared_payments
 );
