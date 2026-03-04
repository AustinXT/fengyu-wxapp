CREATE TYPE "public"."sales_category" AS ENUM('自采自销', '他销自耗', '他销他耗', '生态合作');--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "sales_category" "sales_category";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "allocation_status" text;--> statement-breakpoint
ALTER TABLE "revenue_allocation_items" ADD COLUMN "item_flow_no" text;--> statement-breakpoint
ALTER TABLE "revenue_allocation_items" ADD COLUMN "commission_rate" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "revenue_allocations" ADD COLUMN "department" text;--> statement-breakpoint
ALTER TABLE "revenue_allocation_items" ADD CONSTRAINT "revenue_allocation_items_item_flow_no_order_items_item_flow_no_fk" FOREIGN KEY ("item_flow_no") REFERENCES "public"."order_items"("item_flow_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- 回填 allocation_status：已支付且有分配记录 → allocated
UPDATE orders SET allocation_status = 'allocated'
WHERE status = '已支付' AND order_no IN (
  SELECT DISTINCT order_no FROM revenue_allocations WHERE is_void = false
);--> statement-breakpoint
-- 回填 allocation_status：已支付但无分配记录 → pending
UPDATE orders SET allocation_status = 'pending'
WHERE status = '已支付' AND allocation_status IS NULL;