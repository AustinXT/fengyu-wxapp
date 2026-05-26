CREATE TYPE "public"."coupon_status" AS ENUM('未使用', '已使用', '已过期');--> statement-breakpoint
CREATE TYPE "public"."coupon_type" AS ENUM('现金券', '项目券', '折扣券');--> statement-breakpoint
CREATE TABLE "coupon_templates" (
	"template_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"coupon_type" "coupon_type" NOT NULL,
	"discount_value" numeric(10, 2) NOT NULL,
	"min_spend" numeric(10, 2) DEFAULT '0',
	"max_discount" numeric(10, 2),
	"applicable_category_ids" text[],
	"applicable_store_ids" text[],
	"validity_mode" text DEFAULT 'fixed',
	"valid_from" timestamp,
	"valid_to" timestamp,
	"valid_days" integer,
	"description" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_coupons" (
	"coupon_id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" "coupon_status" DEFAULT '未使用' NOT NULL,
	"expire_at" timestamp NOT NULL,
	"used_sale_order_id" varchar(30),
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN IF NOT EXISTS "customer_id" varchar(30);--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "coupon_id" text;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "coupon_discount" numeric(10, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_template_id_coupon_templates_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."coupon_templates"("template_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_used_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("used_sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_coupons_user_status" ON "user_coupons" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_user_coupons_used_order" ON "user_coupons" USING btree ("used_sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_user_coupons_expire" ON "user_coupons" USING btree ("expire_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_client_users_customer_id" ON "client_wechat_users" USING btree ("customer_id") WHERE customer_id IS NOT NULL;