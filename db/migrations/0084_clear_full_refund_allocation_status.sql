WITH full_refund_without_alloc AS (
  SELECT so.sale_order_id
    FROM sale_orders so
   WHERE so.sale_order_type IN ('销售单','转换单')
     AND so.legacy_source IS DISTINCT FROM 'workfine'
     AND GREATEST(COALESCE(so.received::numeric, 0) - COALESCE(so.refunded_amount::numeric, 0), 0) <= 0.01
     AND EXISTS (
       SELECT 1
         FROM sale_order_payments sop
        WHERE sop.sale_order_id = so.sale_order_id
          AND sop.allocation_status IS NOT NULL
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
