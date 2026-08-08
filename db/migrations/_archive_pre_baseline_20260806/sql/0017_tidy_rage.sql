ALTER TABLE "product_skus" ADD COLUMN "is_experience" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "is_experience" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_product_skus_is_experience" ON "product_skus" USING btree ("is_experience") WHERE "product_skus"."is_experience" = true;--> statement-breakpoint

-- 数据回填（一次性）：从 product_categories.product_kind='体验卡' 推导现有 SKU 的 is_experience
-- 来源：notes/tickets/2026-04-26-experience-card-as-sku-flag.md §2.1 L0-2
UPDATE "product_skus" ps
SET "is_experience" = true
WHERE EXISTS (
  SELECT 1 FROM "product_categories" pc
  WHERE pc."category_id" = ps."category_id"
    AND pc."product_kind" = '体验卡'
);--> statement-breakpoint

-- 历史订单快照回填（一次性）：从 product_skus.is_experience 反向回填历史 sale_items
-- 来源：notes/tickets/2026-04-26-experience-card-as-sku-flag.md §2.1 L0-4
UPDATE "sale_items" si
SET "is_experience" = true
WHERE EXISTS (
  SELECT 1 FROM "product_skus" ps
  WHERE ps."sku_id" = si."sku_id"
    AND ps."is_experience" = true
);