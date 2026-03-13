ALTER TYPE "public"."order_source" ADD VALUE 'admin';--> statement-breakpoint
CREATE TABLE "admin_passwords" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"password_hash" text NOT NULL,
	"must_change" boolean DEFAULT true NOT NULL,
	"last_changed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupon_templates" ADD COLUMN "total_count" integer;--> statement-breakpoint
ALTER TABLE "coupon_templates" ADD COLUMN "applicable_product_ids" text[];--> statement-breakpoint
ALTER TABLE "admin_passwords" ADD CONSTRAINT "admin_passwords_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_admin_passwords_employee" ON "admin_passwords" USING btree ("employee_id");