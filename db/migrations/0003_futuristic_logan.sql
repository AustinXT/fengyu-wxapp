ALTER TABLE "client_wechat_users" RENAME COLUMN "primary_beautician" TO "bound_employee_id";--> statement-breakpoint
ALTER TABLE "client_wechat_users" DROP CONSTRAINT "client_wechat_users_store_id_stores_store_id_fk";
--> statement-breakpoint
DROP INDEX "idx_client_users_store_id";--> statement-breakpoint
ALTER TABLE "client_wechat_users" ALTER COLUMN "phone" SET DATA TYPE varchar(30);--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ALTER COLUMN "phone" SET DATA TYPE varchar(30);--> statement-breakpoint
ALTER TABLE "sale_orders" ALTER COLUMN "sale_order_type" SET DEFAULT '普通';--> statement-breakpoint
ALTER TABLE "sale_orders" ALTER COLUMN "client_phone" SET DATA TYPE varchar(30);--> statement-breakpoint
ALTER TABLE "client_wechat_users" DROP COLUMN "registered_at";--> statement-breakpoint
UPDATE "client_wechat_users" SET "bound_store_id" = "store_id" WHERE "bound_store_id" IS NULL AND "store_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "client_wechat_users" DROP COLUMN "store_id";--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."sale_order_type";--> statement-breakpoint
CREATE TYPE "public"."sale_order_type" AS ENUM('普通', '体验', '内部', '福利活动', '回款', '转换', '退款');--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DATA TYPE "public"."sale_order_type" USING "sale_order_type"::"public"."sale_order_type";