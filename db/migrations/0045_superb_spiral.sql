-- 手工追加：drop 引用 status enum 的 partial unique indexes 与 default，type swap 后重建
DROP INDEX IF EXISTS "uq_sale_orders_client_pending";--> statement-breakpoint
DROP INDEX IF EXISTS "uq_sale_orders_phone_pending";--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."order_status";--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('待支付', '已支付', '已完成', '支付失败', '已关闭', '待审批', '部分支付', '未审核', '已作废');--> statement-breakpoint
-- 手工追加：枚举收敛前 backfill 历史 '待确认收款' 行（开发库可能有，生产库 pre-launch-data-wipe 后为空）
UPDATE "public"."sale_orders" SET "status" = '待支付' WHERE "status" = '待确认收款';--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "status" SET DATA TYPE "public"."order_status" USING "status"::"public"."order_status";--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "status" SET DEFAULT '待支付';--> statement-breakpoint
-- 手工追加：重建 partial unique indexes
CREATE UNIQUE INDEX "uq_sale_orders_client_pending" ON "public"."sale_orders" ("client_user_id") WHERE status = '待支付' AND client_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_orders_phone_pending" ON "public"."sale_orders" ("client_phone", "store_id") WHERE status = '待支付' AND client_user_id IS NULL;