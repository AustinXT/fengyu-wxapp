-- 数据合并（在旧枚举仍允许 '单品'/'疗程卡' 时执行；必须先于下方枚举重建的 cast-back）
-- 单品 = session_count=1 的疗程卡，并入疗程卡；session_count 为空者补 1。
-- 注：历史数据上线前会清空（project_pre_launch_data_wipe），此步仅为开发库/测试一致性。
UPDATE "public"."product_skus" SET "session_count" = 1 WHERE "product_type" = '单品' AND "session_count" IS NULL;--> statement-breakpoint
UPDATE "public"."product_skus" SET "product_type" = '疗程卡' WHERE "product_type" = '单品';--> statement-breakpoint
UPDATE "public"."sale_items" SET "session_count" = 1 WHERE "product_type" = '单品' AND "session_count" IS NULL;--> statement-breakpoint
UPDATE "public"."sale_items" SET "product_type" = '疗程卡' WHERE "product_type" = '单品';--> statement-breakpoint
ALTER TABLE "public"."product_skus" ALTER COLUMN "product_type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "public"."sale_items" ALTER COLUMN "product_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."product_type";--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('疗程卡', '家居产品');--> statement-breakpoint
ALTER TABLE "public"."product_skus" ALTER COLUMN "product_type" SET DATA TYPE "public"."product_type" USING "product_type"::"public"."product_type";--> statement-breakpoint
ALTER TABLE "public"."sale_items" ALTER COLUMN "product_type" SET DATA TYPE "public"."product_type" USING "product_type"::"public"."product_type";