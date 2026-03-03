ALTER TABLE "public"."product_spu" ALTER COLUMN "big_category" SET DATA TYPE text;--> statement-breakpoint
-- 数据迁移：将旧分类值映射到新分类值
UPDATE "public"."product_spu" SET "big_category" = '护理项目' WHERE "big_category" IN ('生美', '非生美');--> statement-breakpoint
UPDATE "public"."product_spu" SET "big_category" = '家居产品' WHERE "big_category" = '院装产品';--> statement-breakpoint
DROP TYPE "public"."big_category";--> statement-breakpoint
CREATE TYPE "public"."big_category" AS ENUM('促销方案', '护理项目', '家居产品', '充值卡');--> statement-breakpoint
ALTER TABLE "public"."product_spu" ALTER COLUMN "big_category" SET DATA TYPE "public"."big_category" USING "big_category"::"public"."big_category";
