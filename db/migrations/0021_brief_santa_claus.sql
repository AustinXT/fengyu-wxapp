ALTER TABLE "sale_order_payments" DROP CONSTRAINT "sale_order_payments_operator_employee_id_staff_wechat_users_employee_id_fk";
--> statement-breakpoint
ALTER TABLE "sale_order_payments" DROP COLUMN "operator_employee_id";--> statement-breakpoint
ALTER TABLE "sale_order_payments" DROP COLUMN "note";--> statement-breakpoint
-- drizzle-kit 不会自动 DROP DEFAULT，但 column default 引用 enum type 会阻止 DROP TYPE
ALTER TABLE "sale_orders" ALTER COLUMN "sale_order_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."sale_order_type";--> statement-breakpoint
CREATE TYPE "public"."sale_order_type" AS ENUM('销售单', '内部单', '转换单');--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DATA TYPE "public"."sale_order_type" USING "sale_order_type"::"public"."sale_order_type";--> statement-breakpoint
ALTER TABLE "sale_orders" ALTER COLUMN "sale_order_type" SET DEFAULT '销售单';