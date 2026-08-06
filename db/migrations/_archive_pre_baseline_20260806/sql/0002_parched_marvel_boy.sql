-- Add sale_items.store_id (NOT NULL FK to stores, with backfill for existing rows).
-- The drizzle-kit default `ADD COLUMN ... NOT NULL` is split here into add-nullable
-- → backfill from sale_orders.store_id → SET NOT NULL → add FK, so the migration
-- works on populated tables. Backfill safety verified: 0 orphan items, 0 NULL
-- store_id in sale_orders, 0 invalid stores FK (checked 2026-04-16 on both
-- 5434/fengyu and 5433/fengyu_wxapp).
ALTER TABLE "sale_items" ADD COLUMN "store_id" text;--> statement-breakpoint
UPDATE "sale_items" si SET "store_id" = so."store_id" FROM "sale_orders" so WHERE si."sale_order_id" = so."sale_order_id";--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "store_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sale_items_store_order" ON "sale_items" USING btree ("store_id","sale_order_id");
