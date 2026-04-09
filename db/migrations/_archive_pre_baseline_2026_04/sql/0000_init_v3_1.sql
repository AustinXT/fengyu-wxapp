CREATE TYPE "public"."allocation_status" AS ENUM('pending', 'allocated');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('待确认', '已确认', '已完成', '已取消', '已关闭');--> statement-breakpoint
CREATE TYPE "public"."item_direction" AS ENUM('purchase', 'convert_out', 'convert_in', 'refund_out');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('client', 'staff');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('待支付', '待确认收款', '已支付', '已完成', '支付失败', '已关闭', '待审批');--> statement-breakpoint
CREATE TYPE "public"."org_node_type" AS ENUM('headquarters', 'market', 'store', 'department');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('wechat', 'alipay', 'offline');--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('福利活动', '护理项目', '家居产品', '充值卡');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('疗程卡', '单品', '院装产品');--> statement-breakpoint
CREATE TYPE "public"."sale_order_type" AS ENUM('正式', '体验', '内部', '组合套餐', '回款', '转换', '退款');--> statement-breakpoint
CREATE TYPE "public"."sales_category" AS ENUM('自采自销', '他销自耗', '他销他耗', '生态合作');--> statement-breakpoint
CREATE TYPE "public"."service_order_status" AS ENUM('待服务', '服务中', '已完成', '已取消');--> statement-breakpoint
CREATE TYPE "public"."store_unbind_request_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "org_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "org_node_type" NOT NULL,
	"parent_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_org_nodes_parent_name" UNIQUE("parent_id","name")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"store_id" text PRIMARY KEY NOT NULL,
	"store_name" text NOT NULL,
	"org_node_id" text,
	"opening_date" date,
	"bed_count" integer,
	"is_closed" boolean DEFAULT false NOT NULL,
	"cover_image" text,
	"images" text[],
	"district" text,
	"street_address" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"phone" text,
	"business_hours" text,
	"description" text,
	"announcement" text,
	"parking_info" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stores_store_name_unique" UNIQUE("store_name")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"employee_id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"gender" varchar(20),
	"phone" varchar(20),
	"id_card" varchar(200),
	"store_id" text,
	"org_node_id" text,
	"position_name" varchar(50),
	"birthday" date,
	"skills" text[],
	"is_resigned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"category_id" text PRIMARY KEY NOT NULL,
	"category_name" text NOT NULL,
	"product_kind" "product_kind" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_skus" (
	"sku_id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"product_type" "product_type" NOT NULL,
	"spec_name" text NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"special_price" numeric(10, 2),
	"session_count" integer,
	"is_bundle_sku" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"service_fee" numeric(10, 2) DEFAULT '0' NOT NULL,
	"valid_start" date,
	"valid_end" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_sku_price" CHECK ("product_skus"."price" >= 0),
	CONSTRAINT "chk_sku_service_fee" CHECK ("product_skus"."service_fee" >= 0),
	CONSTRAINT "chk_sku_session_count" CHECK ("product_skus"."session_count" IS NULL OR "product_skus"."session_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"product_id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"cover_image" text,
	"detail_images" text[],
	"description" text,
	"is_shengmei" boolean,
	"is_bundle" boolean DEFAULT false NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"special_price" numeric(10, 2),
	"sales_category" "sales_category",
	"manage_scope" text,
	"market_scope" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"valid_start" date,
	"valid_end" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_wechat_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"openid" varchar(64),
	"session_key" varchar(128),
	"phone" varchar(20),
	"name" varchar(50),
	"registered_at" date,
	"store_id" text,
	"bound_store_id" text,
	"primary_beautician" varchar(50),
	"member_level" varchar(20),
	"customer_source" varchar(50),
	"category" varchar(50),
	"birthday" date,
	"occupation" varchar(50),
	"is_married" boolean,
	"wechat_name" varchar(50),
	"skin_type" varchar(50),
	"improvement_focus" varchar(200),
	"skin_issue" varchar(200),
	"wellness_preference" varchar(200),
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_wechat_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"openid" varchar(64) NOT NULL,
	"session_key" varchar(128),
	"phone" varchar(20),
	"employee_id" varchar(30),
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "staff_wechat_users_openid_unique" UNIQUE("openid")
);
--> statement-breakpoint
CREATE TABLE "sale_allocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_item_id" varchar(30) NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"allocation_ratio" numeric(5, 2) NOT NULL,
	"total_amount" numeric(10, 2) NOT NULL,
	"is_void" boolean DEFAULT false NOT NULL,
	"voided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_items" (
	"sale_item_id" varchar(30) PRIMARY KEY NOT NULL,
	"sale_order_id" varchar(30) NOT NULL,
	"item_direction" "item_direction" DEFAULT 'purchase' NOT NULL,
	"ref_sale_item_id" varchar(30),
	"sku_id" text,
	"session_count" integer,
	"remaining_sessions" integer,
	"unit_price" numeric(10, 2) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_real_price" numeric(10, 2) NOT NULL,
	"sale_amount" numeric(10, 2) NOT NULL,
	"received" numeric(10, 2) NOT NULL,
	"expire_date" date,
	"remark" text,
	"sales_category" "sales_category",
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_item_unit_price" CHECK ("sale_items"."unit_price" >= 0),
	CONSTRAINT "chk_item_unit_real_price" CHECK ("sale_items"."unit_real_price" >= 0),
	CONSTRAINT "chk_item_remaining" CHECK ("sale_items"."remaining_sessions" IS NULL OR "sale_items"."remaining_sessions" >= 0),
	CONSTRAINT "chk_item_quantity" CHECK ("sale_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "sale_orders" (
	"sale_order_id" varchar(30) PRIMARY KEY NOT NULL,
	"status" "order_status" DEFAULT '待支付' NOT NULL,
	"sale_order_type" "sale_order_type" DEFAULT '正式' NOT NULL,
	"ref_sale_order_id" varchar(30),
	"market_name" varchar(100) NOT NULL,
	"store_id" text NOT NULL,
	"sale_order_datetime" timestamp NOT NULL,
	"client_user_id" text,
	"client_phone" varchar(20),
	"customer_name" varchar(50),
	"total_amount" numeric(10, 2) NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"sale_order_source" "order_source" NOT NULL,
	"opened_by" varchar(30),
	"preferred_employee_id" varchar(30),
	"paid_at" timestamp,
	"wechat_transaction_id" varchar(64),
	"alipay_transaction_id" varchar(64),
	"offline_confirmed_by" varchar(30),
	"offline_confirmed_at" timestamp,
	"allocation_status" "allocation_status",
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sale_orders_wechat_transaction_id_unique" UNIQUE("wechat_transaction_id"),
	CONSTRAINT "sale_orders_alipay_transaction_id_unique" UNIQUE("alipay_transaction_id")
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"appointment_id" text PRIMARY KEY NOT NULL,
	"status" "appointment_status" DEFAULT '待确认' NOT NULL,
	"market_name" varchar(100) NOT NULL,
	"store_id" text NOT NULL,
	"client_user_id" text NOT NULL,
	"customer_name" varchar(50) NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"employee_name" varchar(50) NOT NULL,
	"sale_item_id" varchar(30),
	"appointment_time" timestamp NOT NULL,
	"checkin_at" timestamp,
	"notes" text,
	"cancelled_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_items" (
	"service_item_id" text PRIMARY KEY NOT NULL,
	"sale_item_id" varchar(30) NOT NULL,
	"unit_real_price" numeric(10, 2),
	"service_order_id" varchar(30) NOT NULL,
	"session_used" integer NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"service_duration" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_orders" (
	"service_order_id" varchar(30) PRIMARY KEY NOT NULL,
	"status" "service_order_status" DEFAULT '待服务' NOT NULL,
	"market_name" varchar(100) NOT NULL,
	"store_id" text NOT NULL,
	"service_date" date NOT NULL,
	"assigned_employee_id" varchar(30) NOT NULL,
	"remark" text,
	"appointment_id" text,
	"client_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_roles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"role" text NOT NULL,
	"scope_id" text NOT NULL,
	"is_void" boolean DEFAULT false NOT NULL,
	"voided_at" timestamp,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_rate_matrix" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"order_type" varchar(20) NOT NULL,
	"role_type" varchar(20) NOT NULL,
	"sales_category" varchar(20) NOT NULL,
	"amount_tier_min" numeric(10, 2) NOT NULL,
	"amount_tier_max" numeric(10, 2),
	"commission_rate" numeric(5, 4) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_commission_matrix" UNIQUE("org_id","order_type","role_type","sales_category","amount_tier_min")
);
--> statement-breakpoint
CREATE TABLE "store_unbind_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_store_id" text NOT NULL,
	"status" "store_unbind_request_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"reviewed_by" varchar(30),
	"reviewed_at" timestamp,
	"reject_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operator_user_id" text NOT NULL,
	"operator_name" text NOT NULL,
	"operator_role" text,
	"org_node_id" text,
	"org_node_name" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"detail" jsonb,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_parent_id_org_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_skus" ADD CONSTRAINT "product_skus_product_id_products_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD CONSTRAINT "client_wechat_users_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD CONSTRAINT "client_wechat_users_bound_store_id_stores_store_id_fk" FOREIGN KEY ("bound_store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD CONSTRAINT "staff_wechat_users_employee_id_employees_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD CONSTRAINT "sale_allocations_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD CONSTRAINT "sale_allocations_employee_id_employees_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_ref_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("ref_sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sku_id_product_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_ref_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("ref_sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_opened_by_employees_employee_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_preferred_employee_id_employees_employee_id_fk" FOREIGN KEY ("preferred_employee_id") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_offline_confirmed_by_employees_employee_id_fk" FOREIGN KEY ("offline_confirmed_by") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_employee_id_employees_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_service_order_id_service_orders_service_order_id_fk" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("service_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_employee_id_employees_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_assigned_employee_id_employees_employee_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_appointment_id_appointments_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("appointment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_roles" ADD CONSTRAINT "permission_roles_employee_id_employees_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_roles" ADD CONSTRAINT "permission_roles_scope_id_org_nodes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rate_matrix" ADD CONSTRAINT "commission_rate_matrix_org_id_org_nodes_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_unbind_requests" ADD CONSTRAINT "store_unbind_requests_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_unbind_requests" ADD CONSTRAINT "store_unbind_requests_from_store_id_stores_store_id_fk" FOREIGN KEY ("from_store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_unbind_requests" ADD CONSTRAINT "store_unbind_requests_reviewed_by_employees_employee_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."employees"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_operator_user_id_staff_wechat_users_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."staff_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_nodes_type" ON "org_nodes" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_parent_id" ON "org_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_stores_org_node_id" ON "stores" USING btree ("org_node_id");--> statement-breakpoint
CREATE INDEX "idx_employees_store_resigned" ON "employees" USING btree ("store_id","is_resigned");--> statement-breakpoint
CREATE INDEX "idx_employees_phone" ON "employees" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_product_skus_product_id" ON "product_skus" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_users_openid" ON "client_wechat_users" USING btree ("openid") WHERE openid IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_users_phone" ON "client_wechat_users" USING btree ("phone") WHERE phone IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_client_users_store_id" ON "client_wechat_users" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "idx_client_users_bound_store_id" ON "client_wechat_users" USING btree ("bound_store_id");--> statement-breakpoint
CREATE INDEX "idx_staff_users_phone" ON "staff_wechat_users" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_staff_users_employee_id" ON "staff_wechat_users" USING btree ("employee_id") WHERE employee_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_alloc_item_emp" ON "sale_allocations" USING btree ("sale_item_id","employee_id") WHERE is_void = false;--> statement-breakpoint
CREATE INDEX "idx_sale_alloc_employee_id" ON "sale_allocations" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_sale_items_order_id" ON "sale_items" USING btree ("sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_sale_items_sku_id" ON "sale_items" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "idx_sale_items_ref" ON "sale_items" USING btree ("ref_sale_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_orders_client_pending" ON "sale_orders" USING btree ("client_user_id") WHERE status = '待支付' AND client_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_orders_phone_pending" ON "sale_orders" USING btree ("client_phone","store_id") WHERE status = '待支付' AND client_user_id IS NULL;--> statement-breakpoint
CREATE INDEX "idx_sale_orders_store_status" ON "sale_orders" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "idx_sale_orders_ref" ON "sale_orders" USING btree ("ref_sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_appts_store_id" ON "appointments" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "idx_appts_client_user_id" ON "appointments" USING btree ("client_user_id");--> statement-breakpoint
CREATE INDEX "idx_appts_employee_time" ON "appointments" USING btree ("employee_id","appointment_time");--> statement-breakpoint
CREATE INDEX "idx_svc_items_order_id" ON "service_items" USING btree ("service_order_id");--> statement-breakpoint
CREATE INDEX "idx_svc_orders_store_date" ON "service_orders" USING btree ("store_id","service_date");--> statement-breakpoint
CREATE INDEX "idx_svc_orders_assigned_employee" ON "service_orders" USING btree ("assigned_employee_id");--> statement-breakpoint
CREATE INDEX "idx_svc_orders_client_user_id" ON "service_orders" USING btree ("client_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_perm_roles_emp_role_scope" ON "permission_roles" USING btree ("employee_id","role","scope_id") WHERE is_void = false;--> statement-breakpoint
CREATE INDEX "idx_op_logs_operator" ON "operation_logs" USING btree ("operator_user_id");--> statement-breakpoint
CREATE INDEX "idx_op_logs_target" ON "operation_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "idx_op_logs_action" ON "operation_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_op_logs_created_at" ON "operation_logs" USING btree ("created_at");