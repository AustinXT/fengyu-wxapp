ALTER TABLE "sale_orders" DROP CONSTRAINT "sale_orders_approved_by_staff_wechat_users_employee_id_fk";
--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "refund_reason";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "handling_fee";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "approved_by";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "approved_at";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "rejected_reason";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "overdraft_deduction";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "overdraft_deduction_detail";