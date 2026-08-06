ALTER TABLE "service_items" ADD COLUMN "reserved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_svc_items_sale_item_reserved" ON "service_items" USING btree ("sale_item_id") WHERE "service_items"."reserved_at" IS NOT NULL;--> statement-breakpoint
UPDATE service_items AS sit
SET reserved_at = COALESCE(so.started_at, so.created_at)
FROM service_orders AS so
WHERE sit.service_order_id = so.service_order_id
  AND so.status IN ('服务中', '待客户确认')
  AND sit.reserved_at IS NULL;
