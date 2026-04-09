ALTER TABLE "service_items" ADD COLUMN "is_presale" boolean NOT NULL DEFAULT false;

-- Backfill: 根据关联订单类型设置 is_presale
UPDATE service_items si
SET is_presale = true
FROM sale_items sli
JOIN sale_orders so ON so.sale_order_id = sli.sale_order_id
WHERE si.sale_item_id = sli.sale_item_id
  AND so.sale_order_type = '体验';
