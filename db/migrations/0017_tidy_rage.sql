ALTER TABLE "product_skus" ADD COLUMN "is_experience" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "is_experience" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_product_skus_is_experience" ON "product_skus" USING btree ("is_experience") WHERE "product_skus"."is_experience" = true;--> statement-breakpoint



UPDATE "product_skus" ps
SET "is_experience" = true
WHERE EXISTS (
  SELECT 1 FROM "product_categories" pc
  WHERE pc."category_id" = ps."category_id"
    AND pc."product_kind" = '体验卡'
);--> statement-breakpoint



UPDATE "sale_items" si
SET "is_experience" = true
WHERE EXISTS (
  SELECT 1 FROM "product_skus" ps
  WHERE ps."sku_id" = si."sku_id"
    AND ps."is_experience" = true
);