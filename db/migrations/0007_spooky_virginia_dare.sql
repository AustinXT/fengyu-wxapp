ALTER TABLE "sale_items" ADD COLUMN "sale_item_group_id" varchar(30);--> statement-breakpoint
CREATE INDEX "idx_sale_items_group_id" ON "sale_items" USING btree ("sale_item_group_id");