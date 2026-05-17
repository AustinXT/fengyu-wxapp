ALTER TABLE "product_skus" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "product_skus" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_by" text;--> statement-breakpoint
CREATE INDEX "idx_product_skus_active" ON "product_skus" USING btree ("sku_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_active" ON "messages" USING btree ("created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;