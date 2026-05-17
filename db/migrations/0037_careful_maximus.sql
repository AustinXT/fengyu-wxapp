ALTER TYPE "public"."order_status" ADD VALUE '未审核';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE '已作废';--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "legacy_source" text;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "legacy_customer_id" text;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "legacy_raw_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "audited_at" timestamp;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "audited_by" varchar(30);--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_audited_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("audited_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_legacy_source_phone" ON "sale_orders" USING btree ("legacy_source","client_phone") WHERE legacy_source IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_legacy_source_status" ON "sale_orders" USING btree ("legacy_source","status") WHERE legacy_source IS NOT NULL;