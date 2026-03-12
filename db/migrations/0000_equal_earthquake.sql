CREATE TYPE "public"."appointment_status" AS ENUM('待确认', '已确认', '已完成', '已取消', '已关闭');--> statement-breakpoint
CREATE TYPE "public"."big_category" AS ENUM('生美', '非生美', '院装产品');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('client', 'staff');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('待支付', '待确认收款', '已支付', '已完成', '支付失败', '已关闭');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('正式', '体验');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('wechat', 'offline');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('疗程卡', '单品', '院装产品');--> statement-breakpoint
CREATE TYPE "public"."service_order_status" AS ENUM('待服务', '服务中', '已完成');--> statement-breakpoint
CREATE TYPE "public"."workfine_source" AS ENUM('UDT_M_1281', 'UDT_M_1383', 'UDT_M_1460', 'UDT_M_341');--> statement-breakpoint
CREATE TABLE "product_spu" (
	"spu_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"big_category" "big_category" NOT NULL,
	"cover_image" text,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_spu_sku_map" (
	"sku_id" text PRIMARY KEY NOT NULL,
	"spu_id" text NOT NULL,
	"workfine_item_id" text NOT NULL,
	"workfine_source" "workfine_source" NOT NULL,
	"product_type" "product_type" NOT NULL,
	"sku_display_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "uq_spu_workfine" UNIQUE("spu_id","workfine_item_id","workfine_source")
);
--> statement-breakpoint
CREATE TABLE "client_wechat_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"openid" text NOT NULL,
	"session_key" text,
	"phone" text,
	"bound_store_name" text,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "client_wechat_users_openid_unique" UNIQUE("openid"),
	CONSTRAINT "client_wechat_users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "staff_wechat_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"openid" text NOT NULL,
	"session_key" text,
	"phone" text,
	"employee_id" text,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "staff_wechat_users_openid_unique" UNIQUE("openid"),
	CONSTRAINT "staff_wechat_users_employee_id_unique" UNIQUE("employee_id")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"item_flow_no" text PRIMARY KEY NOT NULL,
	"order_no" text NOT NULL,
	"sku_id" text,
	"session_count" integer,
	"remaining_sessions" integer,
	"unit_price" numeric(12, 2) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"sale_amount" numeric(12, 2) NOT NULL,
	"receivable" numeric(12, 2) NOT NULL,
	"received" numeric(12, 2) NOT NULL,
	"expire_date" date,
	"remark" text
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"order_no" text PRIMARY KEY NOT NULL,
	"status" "order_status" DEFAULT '待支付' NOT NULL,
	"order_type" "order_type" DEFAULT '正式' NOT NULL,
	"market_name" text NOT NULL,
	"store_name" text NOT NULL,
	"order_datetime" timestamp NOT NULL,
	"client_user_id" text,
	"client_phone" text,
	"customer_name" text,
	"payment_method" "payment_method" NOT NULL,
	"order_source" "order_source" NOT NULL,
	"opened_by" text,
	"preferred_employee_id" text,
	"paid_at" timestamp,
	"wechat_transaction_id" text,
	"offline_confirmed_by" text,
	"offline_confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "orders_wechat_transaction_id_unique" UNIQUE("wechat_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "revenue_allocation_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"allocation_id" bigint NOT NULL,
	"performance_category" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_allocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_no" text NOT NULL,
	"employee_id" text NOT NULL,
	"allocation_ratio" numeric(5, 2) NOT NULL,
	"total_amount" numeric(12, 2) NOT NULL,
	"is_void" boolean DEFAULT false NOT NULL,
	"voided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_rev_alloc_order_emp" UNIQUE("order_no","employee_id")
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"appointment_id" text PRIMARY KEY NOT NULL,
	"status" "appointment_status" DEFAULT '待确认' NOT NULL,
	"market_name" text NOT NULL,
	"store_name" text NOT NULL,
	"client_user_id" text NOT NULL,
	"customer_name" text NOT NULL,
	"employee_id" text NOT NULL,
	"staff_name" text NOT NULL,
	"appointment_time" timestamp NOT NULL,
	"notes" text,
	"cancelled_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_items" (
	"service_item_id" text PRIMARY KEY NOT NULL,
	"item_flow_no" text NOT NULL,
	"service_order_no" text NOT NULL,
	"sku_id" text,
	"session_used" integer NOT NULL,
	"employee_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_orders" (
	"service_order_no" text PRIMARY KEY NOT NULL,
	"status" "service_order_status" DEFAULT '待服务' NOT NULL,
	"market_name" text NOT NULL,
	"store_name" text NOT NULL,
	"service_date" date NOT NULL,
	"service_duration" integer,
	"assigned_employee_id" text NOT NULL,
	"remark" text,
	"client_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_spu_sku_map" ADD CONSTRAINT "product_spu_sku_map_spu_id_product_spu_spu_id_fk" FOREIGN KEY ("spu_id") REFERENCES "public"."product_spu"("spu_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_no_orders_order_no_fk" FOREIGN KEY ("order_no") REFERENCES "public"."orders"("order_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_id_product_spu_sku_map_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_spu_sku_map"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_allocation_items" ADD CONSTRAINT "revenue_allocation_items_allocation_id_revenue_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."revenue_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_allocations" ADD CONSTRAINT "revenue_allocations_order_no_orders_order_no_fk" FOREIGN KEY ("order_no") REFERENCES "public"."orders"("order_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_item_flow_no_order_items_item_flow_no_fk" FOREIGN KEY ("item_flow_no") REFERENCES "public"."order_items"("item_flow_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_service_order_no_service_orders_service_order_no_fk" FOREIGN KEY ("service_order_no") REFERENCES "public"."service_orders"("service_order_no") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_sku_id_product_spu_sku_map_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_spu_sku_map"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_order_items_order_no" ON "order_items" USING btree ("order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_orders_client_pending" ON "orders" USING btree ("client_user_id") WHERE status = '待支付' AND client_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_orders_phone_pending" ON "orders" USING btree ("client_phone","store_name") WHERE status = '待支付' AND client_user_id IS NULL;--> statement-breakpoint
CREATE INDEX "idx_orders_client_user_id" ON "orders" USING btree ("client_user_id");--> statement-breakpoint
CREATE INDEX "idx_orders_store_status" ON "orders" USING btree ("store_name","status");--> statement-breakpoint
CREATE INDEX "idx_rev_alloc_order_no" ON "revenue_allocations" USING btree ("order_no");--> statement-breakpoint
CREATE INDEX "idx_appts_client_user_id" ON "appointments" USING btree ("client_user_id");--> statement-breakpoint
CREATE INDEX "idx_appts_staff_time" ON "appointments" USING btree ("employee_id","appointment_time");--> statement-breakpoint
CREATE INDEX "idx_svc_orders_store_date" ON "service_orders" USING btree ("store_name","service_date");--> statement-breakpoint
CREATE INDEX "idx_svc_orders_assigned_staff" ON "service_orders" USING btree ("assigned_employee_id");