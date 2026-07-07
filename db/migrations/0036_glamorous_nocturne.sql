ALTER TABLE "products" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "deleted_by" text;--> statement-breakpoint
CREATE INDEX "idx_products_active" ON "products" USING btree ("product_id") WHERE deleted_at IS NULL;--> statement-breakpoint

UPDATE "products" SET "deleted_at" = now(), "deleted_by" = 'migration-0036' WHERE "is_enabled" = false;--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "is_enabled";