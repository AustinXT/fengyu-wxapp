





ALTER TABLE "sale_items" ADD COLUMN "store_id" text;--> statement-breakpoint
UPDATE "sale_items" si SET "store_id" = so."store_id" FROM "sale_orders" so WHERE si."sale_order_id" = so."sale_order_id";--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "store_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sale_items_store_order" ON "sale_items" USING btree ("store_id","sale_order_id");
