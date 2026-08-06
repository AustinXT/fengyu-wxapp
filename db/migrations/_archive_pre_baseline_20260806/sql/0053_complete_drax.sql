ALTER TYPE "public"."service_order_status" ADD VALUE '待客户确认' BEFORE '已完成';--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"phone" varchar(20) NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp,
	"last_failed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "uq_so_client_active";--> statement-breakpoint
ALTER TABLE "service_orders" ADD COLUMN "staff_completed_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_login_attempts_phone" ON "login_attempts" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_so_client_active" ON "service_orders" USING btree ("client_user_id") WHERE status NOT IN ('已完成','已取消');