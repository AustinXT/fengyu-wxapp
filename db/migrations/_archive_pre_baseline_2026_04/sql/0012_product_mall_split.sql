-- 商品管理 + 商城管理 分离重构
-- SKU 独立化，products 改造为商城商品，新增 mall_categories / mall_product_skus

-- ============================================================
-- Step 1: 新建 mall_categories 和 mall_product_skus 表
-- ============================================================

CREATE TABLE "mall_categories" (
  "category_id" text PRIMARY KEY NOT NULL,
  "category_name" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "is_valid" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "mall_product_skus" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "product_id" text NOT NULL,
  "sku_id" text NOT NULL,
  "bundle_price" numeric(10, 2),
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "idx_mall_product_skus_product_id" ON "mall_product_skus" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mall_product_sku" ON "mall_product_skus" ("product_id", "sku_id");--> statement-breakpoint

-- ============================================================
-- Step 2: product_categories 新增 sales_category
-- ============================================================

ALTER TABLE "product_categories" ADD COLUMN "sales_category" "sales_category";--> statement-breakpoint

-- ============================================================
-- Step 3: product_skus 新增字段（先 nullable，回填后再加约束）
-- ============================================================

ALTER TABLE "product_skus" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "product_skus" ADD COLUMN "is_shengmei" boolean;--> statement-breakpoint
ALTER TABLE "product_skus" ADD COLUMN "market_scope" text;--> statement-breakpoint

-- products 新增 pick_count
ALTER TABLE "products" ADD COLUMN "pick_count" integer;--> statement-breakpoint

-- ============================================================
-- Step 4: 数据回填
-- ============================================================

-- 4a: SKU 从 products 继承 category_id, is_shengmei, market_scope
UPDATE "product_skus" sk SET
  "category_id" = p."category_id",
  "is_shengmei" = p."is_shengmei",
  "market_scope" = p."market_scope"
FROM "products" p
WHERE sk."product_id" = p."product_id";--> statement-breakpoint

-- 4b: product_categories.sales_category 从 products 聚合
UPDATE "product_categories" pc SET "sales_category" = sub."sales_category"
FROM (
  SELECT DISTINCT ON (p."category_id") p."category_id", p."sales_category"
  FROM "products" p
  WHERE p."sales_category" IS NOT NULL
) sub
WHERE pc."category_id" = sub."category_id";--> statement-breakpoint

-- 4c: mall_categories 从 product_categories 初始化（1:1 映射，含所有分类）
INSERT INTO "mall_categories" ("category_id", "category_name", "sort_order", "is_valid", "created_at", "updated_at")
SELECT 'mall-' || "category_id", "category_name", "sort_order", "is_valid", "created_at", "updated_at"
FROM "product_categories";--> statement-breakpoint

-- 4d: mall_product_skus 从现有 product_id 关系填充
INSERT INTO "mall_product_skus" ("product_id", "sku_id", "sort_order")
SELECT "product_id", "sku_id", "sort_order"
FROM "product_skus";--> statement-breakpoint

-- 4e: products.category_id 更新指向 mall_categories
-- 先去掉旧 FK
ALTER TABLE "products" DROP CONSTRAINT "products_category_id_product_categories_category_id_fk";--> statement-breakpoint
UPDATE "products" SET "category_id" = 'mall-' || "category_id";--> statement-breakpoint

-- 4f: spec_name 合并完整名称（product.name + spec_name）
UPDATE "product_skus" sk SET "spec_name" = p."name" || ' ' || sk."spec_name"
FROM "products" p
WHERE sk."product_id" = p."product_id";--> statement-breakpoint

-- ============================================================
-- Step 5: product_skus.category_id 改为 NOT NULL + FK
-- ============================================================

ALTER TABLE "product_skus" ALTER COLUMN "category_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_skus" ADD CONSTRAINT "product_skus_category_id_product_categories_category_id_fk"
  FOREIGN KEY ("category_id") REFERENCES "product_categories"("category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ============================================================
-- Step 6: 删除 product_skus 旧字段
-- ============================================================

-- 先删 FK 约束和索引
ALTER TABLE "product_skus" DROP CONSTRAINT "product_skus_product_id_products_product_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_product_skus_product_id";--> statement-breakpoint

ALTER TABLE "product_skus" DROP COLUMN "product_id";--> statement-breakpoint
ALTER TABLE "product_skus" DROP COLUMN "is_bundle_sku";--> statement-breakpoint

-- ============================================================
-- Step 7: 删除 products 旧字段
-- ============================================================

ALTER TABLE "products" DROP COLUMN "sales_category";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "is_shengmei";--> statement-breakpoint

-- ============================================================
-- Step 8: products.category_id FK 指向 mall_categories
-- ============================================================

ALTER TABLE "products" ADD CONSTRAINT "products_category_id_mall_categories_category_id_fk"
  FOREIGN KEY ("category_id") REFERENCES "mall_categories"("category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- mall_product_skus FK 约束
ALTER TABLE "mall_product_skus" ADD CONSTRAINT "mall_product_skus_product_id_products_product_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "products"("product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mall_product_skus" ADD CONSTRAINT "mall_product_skus_sku_id_product_skus_sku_id_fk"
  FOREIGN KEY ("sku_id") REFERENCES "product_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ============================================================
-- Step 9: 新建索引
-- ============================================================

CREATE INDEX "idx_product_skus_category_id" ON "product_skus" USING btree ("category_id");
