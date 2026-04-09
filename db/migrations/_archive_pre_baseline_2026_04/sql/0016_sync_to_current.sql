CREATE TYPE "public"."customer_source" AS ENUM('美团', '抖音', '小程序', '推带新', '地推卡', '拓客卡', '老带新', '转让店', '自进店', '内部员工或家属');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('保有会员-稳定', '保有会员-有效', '预警沉睡', '冰冻', '休眠');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('流量客', '体验客', '小美客', '会员客');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('售前', '售后');--> statement-breakpoint
CREATE TYPE "public"."member_level" AS ENUM('初钻', '星钻', '粉钻', '金钻', '黑钻');--> statement-breakpoint
CREATE TYPE "public"."monthly_activity" AS ENUM('二次客活', '一次客活', '0次客活');--> statement-breakpoint
CREATE TYPE "public"."spending_tier" AS ENUM('10W+', '6-10W', '3-6W', '1-3W', '1990-1W', '<1990');--> statement-breakpoint
CREATE TABLE "mall_bundle_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"group_name" text NOT NULL,
	"pick_count" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mall_categories" (
	"category_id" text PRIMARY KEY NOT NULL,
	"category_name" text NOT NULL,
	"category_group" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mall_product_skus" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"bundle_group_id" bigint,
	"bundle_price" numeric(10, 2),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_points" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member_levels" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "customer_points" CASCADE;--> statement-breakpoint
DROP TABLE "member_levels" CASCADE;--> statement-breakpoint
ALTER TABLE "product_skus" DROP CONSTRAINT "product_skus_product_id_products_product_id_fk";
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_category_id_product_categories_category_id_fk";
--> statement-breakpoint
DROP INDEX "idx_product_skus_product_id";--> statement-breakpoint
DROP INDEX "uq_sale_alloc_item_emp";--> statement-breakpoint
DROP INDEX "uq_svc_comm_item_emp";--> statement-breakpoint
DROP INDEX "uq_perm_roles_emp_role_scope";--> statement-breakpoint
ALTER TABLE "product_categories" ALTER COLUMN "product_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ALTER COLUMN "member_level" SET DATA TYPE member_level;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ALTER COLUMN "customer_source" SET DATA TYPE customer_source;--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "item_direction" SET DEFAULT '购买';--> statement-breakpoint
ALTER TABLE "sale_orders" ALTER COLUMN "sale_order_type" SET DEFAULT '销售单';--> statement-breakpoint
ALTER TABLE "service_orders" ALTER COLUMN "service_order_type" SET DEFAULT '售前';--> statement-breakpoint
ALTER TABLE "store_unbind_requests" ALTER COLUMN "status" SET DEFAULT '待处理';--> statement-breakpoint
ALTER TABLE "operation_logs" ALTER COLUMN "operator_employee_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operation_logs" ALTER COLUMN "operator_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "point_transactions" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "point_transactions" ALTER COLUMN "type" SET DEFAULT '获取';--> statement-breakpoint
ALTER TABLE "product_categories" ADD COLUMN "sales_category" "sales_category";--> statement-breakpoint
ALTER TABLE "product_skus" ADD COLUMN "category_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "product_skus" ADD COLUMN "is_shengmei" boolean;--> statement-breakpoint
ALTER TABLE "product_skus" ADD COLUMN "market_scope" text;--> statement-breakpoint
ALTER TABLE "product_skus" ADD COLUMN "is_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN "bound_employee_name" varchar(50);--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN "customer_type" "customer_type" DEFAULT '流量客' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN "spending_tier" "spending_tier" DEFAULT '<1990' NOT NULL;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN "monthly_activity" "monthly_activity";--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN "customer_status" "customer_status";--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN "points_balance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD COLUMN "points_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD COLUMN "role_type" varchar(20);--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "document_type" "document_type";--> statement-breakpoint
ALTER TABLE "service_items" ADD COLUMN "is_presale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service_commissions" ADD COLUMN "role_type" varchar(20);--> statement-breakpoint
ALTER TABLE "service_commissions" ADD COLUMN "allocation_ratio" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "mall_bundle_groups" ADD CONSTRAINT "mall_bundle_groups_product_id_products_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mall_product_skus" ADD CONSTRAINT "mall_product_skus_product_id_products_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mall_product_skus" ADD CONSTRAINT "mall_product_skus_sku_id_product_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mall_product_skus" ADD CONSTRAINT "mall_product_skus_bundle_group_id_mall_bundle_groups_id_fk" FOREIGN KEY ("bundle_group_id") REFERENCES "public"."mall_bundle_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bundle_group" ON "mall_bundle_groups" USING btree ("product_id","group_name");--> statement-breakpoint
CREATE INDEX "idx_mall_product_skus_product_id" ON "mall_product_skus" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mall_product_sku" ON "mall_product_skus" USING btree ("product_id","sku_id");--> statement-breakpoint
ALTER TABLE "product_skus" ADD CONSTRAINT "product_skus_category_id_product_categories_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_mall_categories_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."mall_categories"("category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_product_skus_category_id" ON "product_skus" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_alloc_item_emp_role" ON "sale_allocations" USING btree ("sale_item_id","employee_id","role_type") WHERE is_void = false;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_svc_comm_item_emp_role" ON "service_commissions" USING btree ("service_item_id","employee_id","role_type") WHERE is_void = false;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_perm_roles_emp_role_scope" ON "permission_roles" USING btree ("employee_id","role","scope_id");--> statement-breakpoint
ALTER TABLE "product_skus" DROP COLUMN "product_id";--> statement-breakpoint
ALTER TABLE "product_skus" DROP COLUMN "is_bundle_sku";--> statement-breakpoint
ALTER TABLE "product_skus" DROP COLUMN "valid_start";--> statement-breakpoint
ALTER TABLE "product_skus" DROP COLUMN "valid_end";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "is_shengmei";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "sales_category";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "valid_start";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "valid_end";--> statement-breakpoint
ALTER TABLE "client_wechat_users" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "sale_orders" DROP COLUMN "sale_order_source";--> statement-breakpoint
ALTER TABLE "permission_roles" DROP COLUMN "is_void";--> statement-breakpoint
ALTER TABLE "permission_roles" DROP COLUMN "voided_at";--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "allocation_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "public"."service_orders" ALTER COLUMN "commission_status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."allocation_status";--> statement-breakpoint
CREATE TYPE "public"."allocation_status" AS ENUM('待分配', '已分配');--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "allocation_status" SET DATA TYPE "public"."allocation_status" USING "allocation_status"::"public"."allocation_status";--> statement-breakpoint
ALTER TABLE "public"."service_orders" ALTER COLUMN "commission_status" SET DATA TYPE "public"."allocation_status" USING "commission_status"::"public"."allocation_status";--> statement-breakpoint
ALTER TABLE "public"."card_transactions" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."card_transaction_type";--> statement-breakpoint
CREATE TYPE "public"."card_transaction_type" AS ENUM('充值', '扣款');--> statement-breakpoint
ALTER TABLE "public"."card_transactions" ALTER COLUMN "type" SET DATA TYPE "public"."card_transaction_type" USING "type"::"public"."card_transaction_type";--> statement-breakpoint
ALTER TABLE "public"."coupon_templates" ALTER COLUMN "coupon_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."coupon_type";--> statement-breakpoint
CREATE TYPE "public"."coupon_type" AS ENUM('现金券', '品项券', '折扣券');--> statement-breakpoint
ALTER TABLE "public"."coupon_templates" ALTER COLUMN "coupon_type" SET DATA TYPE "public"."coupon_type" USING "coupon_type"::"public"."coupon_type";--> statement-breakpoint
ALTER TABLE "public"."sale_items" ALTER COLUMN "item_direction" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."item_direction";--> statement-breakpoint
CREATE TYPE "public"."item_direction" AS ENUM('购买', '转出', '转入', '退出');--> statement-breakpoint
ALTER TABLE "public"."sale_items" ALTER COLUMN "item_direction" SET DATA TYPE "public"."item_direction" USING "item_direction"::"public"."item_direction";--> statement-breakpoint
ALTER TABLE "public"."messages" ALTER COLUMN "recipient_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."message_recipient_type";--> statement-breakpoint
CREATE TYPE "public"."message_recipient_type" AS ENUM('客户', '员工');--> statement-breakpoint
ALTER TABLE "public"."messages" ALTER COLUMN "recipient_type" SET DATA TYPE "public"."message_recipient_type" USING "recipient_type"::"public"."message_recipient_type";--> statement-breakpoint
ALTER TABLE "public"."org_nodes" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."org_node_type";--> statement-breakpoint
CREATE TYPE "public"."org_node_type" AS ENUM('总部', '市场', '门店', '部门');--> statement-breakpoint
ALTER TABLE "public"."org_nodes" ALTER COLUMN "type" SET DATA TYPE "public"."org_node_type" USING "type"::"public"."org_node_type";--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "payment_method" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."payment_method";--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('微信', '支付宝', '线下');--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "payment_method" SET DATA TYPE "public"."payment_method" USING "payment_method"::"public"."payment_method";--> statement-breakpoint
ALTER TABLE "public"."positions" ALTER COLUMN "scope" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."position_scope";--> statement-breakpoint
CREATE TYPE "public"."position_scope" AS ENUM('总部', '市场', '门店');--> statement-breakpoint
ALTER TABLE "public"."positions" ALTER COLUMN "scope" SET DATA TYPE "public"."position_scope" USING "scope"::"public"."position_scope";--> statement-breakpoint
ALTER TABLE "public"."product_categories" ALTER COLUMN "product_kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."product_kind";--> statement-breakpoint
CREATE TYPE "public"."product_kind" AS ENUM('组合套餐', '护理项目', '家居产品', '充值卡', '体验卡');--> statement-breakpoint
ALTER TABLE "public"."product_categories" ALTER COLUMN "product_kind" SET DATA TYPE "public"."product_kind" USING "product_kind"::"public"."product_kind";--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."sale_order_type";--> statement-breakpoint
CREATE TYPE "public"."sale_order_type" AS ENUM('销售单', '内部单', '回款单', '转换单', '退款单');--> statement-breakpoint
ALTER TABLE "public"."sale_orders" ALTER COLUMN "sale_order_type" SET DATA TYPE "public"."sale_order_type" USING "sale_order_type"::"public"."sale_order_type";--> statement-breakpoint
ALTER TABLE "public"."service_orders" ALTER COLUMN "service_order_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."service_order_type";--> statement-breakpoint
CREATE TYPE "public"."service_order_type" AS ENUM('售前', '售后');--> statement-breakpoint
ALTER TABLE "public"."service_orders" ALTER COLUMN "service_order_type" SET DATA TYPE "public"."service_order_type" USING "service_order_type"::"public"."service_order_type";--> statement-breakpoint
ALTER TABLE "public"."store_unbind_requests" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."store_unbind_request_status";--> statement-breakpoint
CREATE TYPE "public"."store_unbind_request_status" AS ENUM('待处理', '已通过', '已拒绝', '已取消');--> statement-breakpoint
ALTER TABLE "public"."store_unbind_requests" ALTER COLUMN "status" SET DATA TYPE "public"."store_unbind_request_status" USING "status"::"public"."store_unbind_request_status";--> statement-breakpoint
DROP TYPE "public"."order_source";--> statement-breakpoint
DROP TYPE "public"."point_transaction_type";