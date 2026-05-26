ALTER TABLE "products" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "deleted_by" text;--> statement-breakpoint
CREATE INDEX "idx_products_active" ON "products" USING btree ("product_id") WHERE deleted_at IS NULL;--> statement-breakpoint
-- 数据回填：原 is_enabled=false 的商品视作已软删（取消"停用"语义，改为"删除"）
UPDATE "products" SET "deleted_at" = now(), "deleted_by" = 'migration-0036' WHERE "is_enabled" = false;--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "is_enabled";