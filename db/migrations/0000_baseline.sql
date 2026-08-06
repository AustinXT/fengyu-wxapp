CREATE TYPE "public"."allocation_status" AS ENUM('待分配', '已分配');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('待确认', '已确认', '已完成', '已取消', '已关闭');--> statement-breakpoint
CREATE TYPE "public"."card_transaction_type" AS ENUM('充值', '扣款');--> statement-breakpoint
CREATE TYPE "public"."coupon_status" AS ENUM('未使用', '已使用', '已过期');--> statement-breakpoint
CREATE TYPE "public"."coupon_type" AS ENUM('现金券', '品项券', '折扣券');--> statement-breakpoint
CREATE TYPE "public"."customer_source" AS ENUM('美团', '抖音', '小程序', '推带新', '地推卡', '拓客卡', '老带新', '转让店', '自进店', '内部员工或家属');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('保有会员-稳定', '保有会员-有效', '沉睡', '冰冻', '休眠');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('流量客', '体验客', '小美客', '会员客');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('售前', '售后');--> statement-breakpoint
CREATE TYPE "public"."inventory_doc_status" AS ENUM('草稿', '已完成', '已取消');--> statement-breakpoint
CREATE TYPE "public"."inventory_procurement_subtype" AS ENUM('院报货', '院入库', '退货出库');--> statement-breakpoint
CREATE TYPE "public"."inventory_sale_subtype" AS ENUM('销售出库', '顾客退货');--> statement-breakpoint
CREATE TYPE "public"."inventory_transfer_subtype" AS ENUM('调拨出库', '调拨入库');--> statement-breakpoint
CREATE TYPE "public"."item_direction" AS ENUM('购买', '转出', '转入', '退出');--> statement-breakpoint
CREATE TYPE "public"."member_level" AS ENUM('初钻', '星钻', '粉钻', '金钻', '黑钻');--> statement-breakpoint
CREATE TYPE "public"."message_recipient_type" AS ENUM('客户', '员工');--> statement-breakpoint
CREATE TYPE "public"."monthly_activity" AS ENUM('二次客活', '一次客活', '0次客活');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('待支付', '已支付', '已完成', '已退款', '支付失败', '已关闭', '待审批', '部分支付', '未审核', '已作废');--> statement-breakpoint
CREATE TYPE "public"."org_node_type" AS ENUM('总部', '市场', '门店', '部门');--> statement-breakpoint
CREATE TYPE "public"."payment_change_type" AS ENUM('首次支付', '回款', '退款', '储值卡抵扣');--> statement-breakpoint
CREATE TYPE "public"."payment_flow_status" AS ENUM('待支付', '待审批', '已支付', '已作废', '已退款');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('微信', '支付宝', '线下', '无', '储值卡');--> statement-breakpoint
CREATE TYPE "public"."payment_source_end" AS ENUM('client', 'staff', 'admin', 'notify');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('疗程卡', '家居产品');--> statement-breakpoint
CREATE TYPE "public"."sale_order_type" AS ENUM('销售单', '内部单', '转换单', '寄存单', '充值单');--> statement-breakpoint
CREATE TYPE "public"."sales_category" AS ENUM('自销自耗', '他销自耗', '他销他耗', '生态合作');--> statement-breakpoint
CREATE TYPE "public"."service_order_status" AS ENUM('待服务', '服务中', '待客户确认', '已完成', '已取消');--> statement-breakpoint
CREATE TYPE "public"."service_order_type" AS ENUM('售前', '售后');--> statement-breakpoint
CREATE TYPE "public"."spending_tier" AS ENUM('10W+', '6-10W', '3-6W', '1-3W', '1990-1W', '<1990');--> statement-breakpoint
CREATE TYPE "public"."store_inventory_doc_status" AS ENUM('草稿', '待审批', '待收货', '已完成', '已驳回', '已取消');--> statement-breakpoint
CREATE TYPE "public"."store_inventory_doc_type" AS ENUM('院报货', '院入库', '院顾客退货', '院顾客产品出库', '院退货', '院产品报损', '分院调货出库', '分院调货入库', '期初库存');--> statement-breakpoint
CREATE TYPE "public"."store_inventory_movement_direction" AS ENUM('入库', '出库', '调整');--> statement-breakpoint
CREATE TYPE "public"."store_unbind_request_status" AS ENUM('待处理', '已通过', '已拒绝', '已取消');--> statement-breakpoint
CREATE TABLE "org_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "org_node_type" NOT NULL,
	"parent_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
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
	"closed_at" date,
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
	"lakala_merchant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_store_name_unique" UNIQUE("store_name"),
	CONSTRAINT "stores_org_node_id_unique" UNIQUE("org_node_id")
);
--> statement-breakpoint
CREATE TABLE "mall_bundle_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"group_name" text NOT NULL,
	"pick_count" integer,
	"unit_list_price" numeric(10, 2),
	"unit_member_price" numeric(10, 2),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_bundle_group_member_le_list" CHECK ("mall_bundle_groups"."unit_member_price" IS NULL OR "mall_bundle_groups"."unit_list_price" IS NULL OR "mall_bundle_groups"."unit_member_price" <= "mall_bundle_groups"."unit_list_price"),
	CONSTRAINT "chk_bundle_group_list_nonneg" CHECK ("mall_bundle_groups"."unit_list_price" IS NULL OR "mall_bundle_groups"."unit_list_price" >= 0),
	CONSTRAINT "chk_bundle_group_member_nonneg" CHECK ("mall_bundle_groups"."unit_member_price" IS NULL OR "mall_bundle_groups"."unit_member_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mall_categories" (
	"category_id" text PRIMARY KEY NOT NULL,
	"category_name" text NOT NULL,
	"category_group" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mall_product_skus" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"bundle_group_id" bigint,
	"bundle_price" numeric(10, 2),
	"bundle_list_price" numeric(10, 2),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"category_id" text PRIMARY KEY NOT NULL,
	"category_name" text NOT NULL,
	"product_kind" text,
	"sales_category" "sales_category",
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"display_color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_skus" (
	"sku_id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"product_type" "product_type" NOT NULL,
	"spec_name" text NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"special_price" numeric(10, 2),
	"session_count" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"service_fee" numeric(10, 2) DEFAULT '0' NOT NULL,
	"is_shengmei" boolean,
	"is_experience" boolean DEFAULT false NOT NULL,
	"is_manager_special" boolean DEFAULT false NOT NULL,
	"purchase_limit" integer,
	"project_series_id" bigint,
	"market_scope" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	CONSTRAINT "chk_sku_price" CHECK ("product_skus"."price" >= 0),
	CONSTRAINT "chk_sku_service_fee" CHECK ("product_skus"."service_fee" >= 0),
	CONSTRAINT "chk_sku_session_count" CHECK ("product_skus"."session_count" IS NULL OR "product_skus"."session_count" >= 1),
	CONSTRAINT "chk_sku_purchase_limit" CHECK ("product_skus"."purchase_limit" IS NULL OR "product_skus"."purchase_limit" >= 1)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"product_id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"cover_image" text,
	"detail_images" text[],
	"description" text,
	"is_bundle" boolean DEFAULT false NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"special_price" numeric(10, 2),
	"manage_scope" text,
	"market_scope" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "client_wechat_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"openid" varchar(64),
	"session_key" varchar(128),
	"phone" varchar(30),
	"customer_id" varchar(30),
	"name" varchar(50),
	"gender" varchar(10),
	"avatar_url" text,
	"bound_store_id" text,
	"bound_employee_id" varchar(50),
	"bound_employee_name" varchar(50),
	"is_cross_store_temp" boolean DEFAULT false NOT NULL,
	"member_level" "member_level",
	"member_level_locked_until" timestamp with time zone,
	"member_level_upgraded_at" timestamp with time zone,
	"old_member_level" "member_level",
	"customer_source" "customer_source",
	"promoter_employee_id" varchar(30),
	"inviter_user_id" text,
	"invited_at" timestamp with time zone,
	"customer_type" "customer_type" DEFAULT '流量客' NOT NULL,
	"became_member_at" timestamp with time zone,
	"spending_tier" "spending_tier" DEFAULT '<1990' NOT NULL,
	"monthly_activity" "monthly_activity",
	"customer_status" "customer_status",
	"birthday" date,
	"occupation" varchar(50),
	"is_married" boolean,
	"wechat_name" varchar(50),
	"skin_type" varchar(50),
	"improvement_focus" varchar(200),
	"skin_issue" varchar(200),
	"wellness_preference" varchar(200),
	"notes" text,
	"points_balance" bigint DEFAULT 0 NOT NULL,
	"points_updated_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inviter_not_self" CHECK ("client_wechat_users"."inviter_user_id" IS NULL OR "client_wechat_users"."inviter_user_id" <> "client_wechat_users"."user_id"),
	CONSTRAINT "chk_cwu_phone_format" CHECK ("client_wechat_users"."phone" IS NULL OR "client_wechat_users"."phone" ~ '^1[3-9][0-9]{9}$')
);
--> statement-breakpoint
CREATE TABLE "staff_wechat_users" (
	"employee_id" varchar(30) PRIMARY KEY NOT NULL,
	"openid" varchar(64),
	"session_key" varchar(128),
	"phone" varchar(30),
	"name" varchar(50),
	"gender" varchar(20),
	"id_card" varchar(200),
	"store_id" text,
	"org_node_id" text,
	"position_name" varchar(50),
	"avatar_url" text,
	"birthday" date,
	"leave_start" timestamp with time zone,
	"leave_end" timestamp with time zone,
	"is_on_business_trip" boolean DEFAULT false NOT NULL,
	"skills" text[],
	"social_insurance" boolean DEFAULT false NOT NULL,
	"is_resigned" boolean DEFAULT false NOT NULL,
	"hired_at" date,
	"resigned_at" date,
	"resignation_reason" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_swu_phone_format" CHECK ("staff_wechat_users"."phone" IS NULL OR "staff_wechat_users"."phone" ~ '^1[3-9][0-9]{9}$'),
	CONSTRAINT "chk_swu_leave_range" CHECK ("staff_wechat_users"."leave_start" IS NULL OR "staff_wechat_users"."leave_end" IS NULL OR "staff_wechat_users"."leave_end" > "staff_wechat_users"."leave_start")
);
--> statement-breakpoint
CREATE TABLE "sale_allocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_item_id" varchar(30) NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"allocation_ratio" numeric(5, 3) NOT NULL,
	"role_type" varchar(20) NOT NULL,
	"department_name" varchar(100),
	"total_amount" numeric(10, 2) NOT NULL,
	"commission_rate" numeric(5, 4),
	"commission_amount" numeric(10, 2),
	"sale_payment_id" bigint,
	"is_void" boolean DEFAULT false NOT NULL,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_sale_alloc_ratio" CHECK ("sale_allocations"."allocation_ratio" >= 0 AND "sale_allocations"."allocation_ratio" <= 1)
);
--> statement-breakpoint
CREATE TABLE "sale_items" (
	"sale_item_id" varchar(30) PRIMARY KEY NOT NULL,
	"sale_order_id" varchar(30) NOT NULL,
	"store_id" text NOT NULL,
	"item_direction" "item_direction" DEFAULT '购买' NOT NULL,
	"ref_sale_item_id" varchar(30),
	"sku_id" text,
	"product_name" text,
	"product_type" "product_type",
	"session_count" integer,
	"remaining_sessions" integer,
	"paid_sessions" integer,
	"unit_price" numeric(10, 2) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_real_price" numeric(10, 2) NOT NULL,
	"sale_amount" numeric(10, 2) NOT NULL,
	"received" numeric(10, 2) NOT NULL,
	"pending_received" numeric(10, 2) DEFAULT '0' NOT NULL,
	"expire_date" date,
	"picked_up_quantity" integer DEFAULT 0,
	"remark" text,
	"sales_category" "sales_category",
	"service_fee" numeric(10, 2) DEFAULT '0' NOT NULL,
	"is_shengmei" boolean,
	"is_experience" boolean DEFAULT false NOT NULL,
	"is_manager_special" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_item_unit_price" CHECK ("sale_items"."unit_price" >= 0),
	CONSTRAINT "chk_item_unit_real_price" CHECK ("sale_items"."unit_real_price" >= 0),
	CONSTRAINT "chk_item_remaining" CHECK ("sale_items"."remaining_sessions" IS NULL OR "sale_items"."remaining_sessions" >= 0),
	CONSTRAINT "chk_item_paid_sessions" CHECK ("sale_items"."paid_sessions" IS NULL OR ("sale_items"."paid_sessions" >= 0 AND "sale_items"."paid_sessions" <= "sale_items"."session_count")),
	CONSTRAINT "chk_item_quantity" CHECK ("sale_items"."quantity" > 0),
	CONSTRAINT "chk_item_service_fee" CHECK ("sale_items"."service_fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sale_order_payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_order_id" varchar(30) NOT NULL,
	"change_type" "payment_change_type" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"external_txn_id" text,
	"external_trade_info" jsonb,
	"status" "payment_flow_status" NOT NULL,
	"source_end" "payment_source_end" NOT NULL,
	"operator_employee_id" varchar(30),
	"note" text,
	"refund_reason" text,
	"ref_sale_item_id" varchar(30),
	"session_count" integer,
	"audit_employee_id" varchar(30),
	"audit_at" timestamp with time zone,
	"audit_remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"allocation_status" "allocation_status",
	CONSTRAINT "chk_sop_amount_sign" CHECK (("sale_order_payments"."change_type" IN ('首次支付','回款','储值卡抵扣') AND "sale_order_payments"."amount" > 0)
          OR ("sale_order_payments"."change_type" = '退款' AND "sale_order_payments"."amount" <= 0)),
	CONSTRAINT "chk_sop_method_txn" CHECK ("sale_order_payments"."payment_method" NOT IN ('微信','支付宝') OR "sale_order_payments"."external_txn_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sale_orders" (
	"sale_order_id" varchar(30) PRIMARY KEY NOT NULL,
	"status" "order_status" DEFAULT '待支付' NOT NULL,
	"sale_order_type" "sale_order_type" DEFAULT '销售单' NOT NULL,
	"document_type" "document_type",
	"ref_sale_order_id" varchar(30),
	"market_name" varchar(100) NOT NULL,
	"store_id" text NOT NULL,
	"store_name" varchar(100),
	"sale_order_datetime" timestamp with time zone NOT NULL,
	"client_user_id" text,
	"client_phone" varchar(30),
	"customer_name" varchar(50),
	"total_amount" numeric(10, 2) NOT NULL,
	"prepaid_card_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"payable_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"received" numeric(10, 2) DEFAULT '0' NOT NULL,
	"refunded_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"first_payment_amount" numeric(10, 2),
	"payment_method" "payment_method" NOT NULL,
	"opened_by" varchar(30),
	"preferred_employee_id" varchar(30),
	"paid_at" timestamp with time zone,
	"offline_confirmed_by" varchar(30),
	"offline_confirmed_at" timestamp with time zone,
	"lakala_out_order_no" text,
	"allocation_status" "allocation_status",
	"coupon_id" text,
	"coupon_discount" numeric(10, 2) DEFAULT '0',
	"remark" text,
	"is_activity" boolean DEFAULT false NOT NULL,
	"is_membership_upgrade" boolean DEFAULT false NOT NULL,
	"legacy_source" text,
	"legacy_customer_id" text,
	"legacy_raw_snapshot" jsonb,
	"audited_at" timestamp with time zone,
	"audited_by" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_first_payment_amount" CHECK ("sale_orders"."first_payment_amount" IS NULL OR ("sale_orders"."first_payment_amount" > 0 AND "sale_orders"."first_payment_amount" <= "sale_orders"."payable_amount"))
);
--> statement-breakpoint
CREATE TABLE "sale_payment_allocatable_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_payment_id" bigint NOT NULL,
	"sale_order_id" varchar(30) NOT NULL,
	"sale_item_id" varchar(30) NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"sales_category" "sales_category",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_payment_item_allocations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_payment_item_receipt_id" bigint NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"role_type" varchar(20) NOT NULL,
	"department_name" varchar(100),
	"allocation_ratio" numeric(5, 3) NOT NULL,
	"allocated_amount" numeric(10, 2) NOT NULL,
	"commission_rate" numeric(5, 4),
	"commission_amount" numeric(10, 2),
	"is_void" boolean DEFAULT false NOT NULL,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_spia_ratio" CHECK ("sale_payment_item_allocations"."allocation_ratio" > 0 AND "sale_payment_item_allocations"."allocation_ratio" <= 1)
);
--> statement-breakpoint
CREATE TABLE "sale_payment_item_receipts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_payment_id" bigint NOT NULL,
	"sale_order_id" varchar(30) NOT NULL,
	"sale_item_id" varchar(30) NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"sales_category" "sales_category",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"appointment_id" text PRIMARY KEY NOT NULL,
	"status" "appointment_status" DEFAULT '待确认' NOT NULL,
	"store_id" text NOT NULL,
	"client_user_id" text NOT NULL,
	"client_name" varchar(50) NOT NULL,
	"employee_id" varchar(30),
	"employee_name" varchar(50),
	"sale_item_id" varchar(30),
	"appointment_time" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"checkin_at" timestamp with time zone,
	"notes" text,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_items" (
	"service_item_id" text PRIMARY KEY NOT NULL,
	"sale_item_id" varchar(30) NOT NULL,
	"unit_real_price" numeric(10, 2),
	"is_shengmei" boolean,
	"sales_category" "sales_category",
	"service_order_id" varchar(30) NOT NULL,
	"session_used" integer NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"service_duration" integer,
	"reserved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_orders" (
	"service_order_id" varchar(30) PRIMARY KEY NOT NULL,
	"status" "service_order_status" DEFAULT '待服务' NOT NULL,
	"service_order_type" "service_order_type" DEFAULT '售前' NOT NULL,
	"market_name" varchar(100) NOT NULL,
	"store_id" text NOT NULL,
	"service_date" date NOT NULL,
	"assigned_employee_id" varchar(30) NOT NULL,
	"remark" text,
	"appointment_id" text,
	"client_user_id" text,
	"started_at" timestamp with time zone,
	"staff_completed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"commission_status" "allocation_status",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_reviews" (
	"service_order_id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"client_user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_roles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"role" text NOT NULL,
	"scope_id" text NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_commission_matrix" UNIQUE("org_id","order_type","role_type","sales_category","amount_tier_min")
);
--> statement-breakpoint
CREATE TABLE "store_unbind_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_store_id" text NOT NULL,
	"to_store_id" text,
	"status" "store_unbind_request_status" DEFAULT '待处理' NOT NULL,
	"note" text,
	"reviewed_by" varchar(30),
	"reviewed_at" timestamp with time zone,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"operator_employee_id" varchar(30),
	"operator_name" text,
	"operator_role" text,
	"org_node_id" text,
	"org_node_name" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"detail" jsonb,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_templates" (
	"template_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"coupon_type" "coupon_type" NOT NULL,
	"discount_value" numeric(10, 2) NOT NULL,
	"min_spend" numeric(10, 2) DEFAULT '0',
	"max_discount" numeric(10, 2),
	"total_count" integer,
	"applicable_product_ids" text[],
	"applicable_category_ids" text[],
	"applicable_store_ids" text[],
	"applicable_market_ids" text[],
	"validity_mode" text DEFAULT 'fixed',
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"valid_days" integer,
	"description" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_coupons" (
	"coupon_id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" "coupon_status" DEFAULT '未使用' NOT NULL,
	"expire_at" timestamp with time zone NOT NULL,
	"face_value_override" numeric(10, 2),
	"external_ref" text,
	"used_sale_order_id" varchar(30),
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_passwords" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"password_hash" text NOT NULL,
	"must_change" boolean DEFAULT true NOT NULL,
	"last_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"phone" varchar(20) NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "point_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text DEFAULT '获取' NOT NULL,
	"amount" bigint NOT NULL,
	"ref_order_id" varchar(30),
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_pt_amount_sign" CHECK (("point_transactions"."amount" < 0 AND "point_transactions"."type" = '消费冲销') OR "point_transactions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recipient_type" "message_recipient_type" NOT NULL,
	"recipient_id" text NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text,
	"message_type" varchar(50),
	"is_read" boolean DEFAULT false NOT NULL,
	"ref_entity_type" varchar(50),
	"ref_entity_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" text
);
--> statement-breakpoint
CREATE TABLE "card_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"type" "card_transaction_type" NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"ref_order_id" varchar(30),
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_card_tx_amount_sign" CHECK (("card_transactions"."type" = '充值' AND "card_transactions"."amount" > 0) OR ("card_transactions"."type" = '扣款' AND "card_transactions"."amount" < 0))
);
--> statement-breakpoint
CREATE TABLE "prepaid_cards" (
	"card_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"balance" numeric(10, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_prepaid_balance_nonneg" CHECK ("prepaid_cards"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "service_commissions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"service_item_id" text NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"role_type" varchar(20) NOT NULL,
	"allocation_ratio" numeric(5, 3),
	"commission_rate" numeric(5, 4) NOT NULL,
	"fixed_fee" numeric(10, 2) DEFAULT '0' NOT NULL,
	"consume_amount" numeric(10, 2) DEFAULT '0' NOT NULL,
	"commission_amount" numeric(10, 2) NOT NULL,
	"is_void" boolean DEFAULT false NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_svc_comm_fixed_fee" CHECK ("service_commissions"."fixed_fee" >= 0),
	CONSTRAINT "chk_svc_comm_consume_amount" CHECK ("service_commissions"."consume_amount" >= 0),
	CONSTRAINT "chk_svc_comm_commission_amount" CHECK ("service_commissions"."commission_amount" >= 0),
	CONSTRAINT "chk_svc_comm_commission_rate" CHECK ("service_commissions"."commission_rate" >= 0 AND "service_commissions"."commission_rate" <= 1),
	CONSTRAINT "chk_svc_comm_alloc_ratio" CHECK ("service_commissions"."allocation_ratio" IS NULL OR ("service_commissions"."allocation_ratio" >= 0 AND "service_commissions"."allocation_ratio" <= 1))
);
--> statement-breakpoint
CREATE TABLE "pickup_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"sale_item_id" varchar(30) NOT NULL,
	"pickup_quantity" integer NOT NULL,
	"store_id" text NOT NULL,
	"client_user_id" text,
	"confirmed_by" varchar(30) NOT NULL,
	"remark" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_pickup_quantity" CHECK ("pickup_records"."pickup_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_procurement_order_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"spec_name" text,
	"manufacturer" text,
	"product_series" text,
	"batch_no" text,
	"expiry_date" date,
	"is_gift" boolean DEFAULT false NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"stock_on_hand" numeric(12, 2),
	"unit_price" numeric(12, 2),
	"amount" numeric(12, 2),
	"request_quantity" numeric(12, 2),
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inv_proc_items_quantity" CHECK ("inventory_procurement_order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_procurement_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_subtype" "inventory_procurement_subtype" NOT NULL,
	"status" "inventory_doc_status" DEFAULT '已完成' NOT NULL,
	"store_id" text NOT NULL,
	"doc_date" date NOT NULL,
	"total_quantity" numeric(12, 2),
	"is_completed" boolean DEFAULT false NOT NULL,
	"source_date" date,
	"source_quantity" numeric(12, 2),
	"signature_url" text,
	"related_doc_no" text,
	"remark" text,
	"created_by" varchar(30) NOT NULL,
	"confirmed_by" varchar(30),
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_sale_order_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"spec_name" text,
	"manufacturer" text,
	"product_series" text,
	"batch_no" text,
	"expiry_date" date,
	"is_gift" boolean DEFAULT false NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"stock_on_hand" numeric(12, 2),
	"unit_price" numeric(12, 2),
	"amount" numeric(12, 2),
	"sale_flow_no" text,
	"customer_remaining" numeric(12, 2),
	"verification_name" text,
	"verification_code" text,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inv_sale_items_quantity" CHECK ("inventory_sale_order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_sale_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_subtype" "inventory_sale_subtype" NOT NULL,
	"status" "inventory_doc_status" DEFAULT '已完成' NOT NULL,
	"store_id" text NOT NULL,
	"doc_date" date NOT NULL,
	"total_quantity" numeric(12, 2),
	"client_user_id" text,
	"customer_name" varchar(50),
	"related_sale_order_id" varchar(30),
	"remark" text,
	"created_by" varchar(30) NOT NULL,
	"confirmed_by" varchar(30),
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_scrap_order_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"spec_name" text,
	"manufacturer" text,
	"product_series" text,
	"batch_no" text,
	"expiry_date" date,
	"is_gift" boolean DEFAULT false NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"stock_on_hand" numeric(12, 2),
	"unit_price" numeric(12, 2),
	"amount" numeric(12, 2),
	"scrap_reason" text NOT NULL,
	"item_usage" text,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inv_scrap_items_quantity" CHECK ("inventory_scrap_order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_scrap_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "inventory_doc_status" DEFAULT '已完成' NOT NULL,
	"store_id" text NOT NULL,
	"doc_date" date NOT NULL,
	"total_quantity" numeric(12, 2),
	"remark" text,
	"created_by" varchar(30) NOT NULL,
	"confirmed_by" varchar(30),
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_transfer_order_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"spec_name" text,
	"manufacturer" text,
	"product_series" text,
	"batch_no" text,
	"expiry_date" date,
	"is_gift" boolean DEFAULT false NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"stock_on_hand" numeric(12, 2),
	"unit_price" numeric(12, 2),
	"amount" numeric(12, 2),
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inv_transfer_items_quantity" CHECK ("inventory_transfer_order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_transfer_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_subtype" "inventory_transfer_subtype" NOT NULL,
	"status" "inventory_doc_status" DEFAULT '已完成' NOT NULL,
	"store_id" text NOT NULL,
	"counterpart_store_id" text NOT NULL,
	"is_dispatcher" boolean DEFAULT true NOT NULL,
	"doc_date" date NOT NULL,
	"total_quantity" numeric(12, 2),
	"receive_quantity" numeric(12, 2),
	"remark" text,
	"created_by" varchar(30) NOT NULL,
	"confirmed_by" varchar(30),
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inv_transfer_different_stores" CHECK ("inventory_transfer_orders"."store_id" <> "inventory_transfer_orders"."counterpart_store_id")
);
--> statement-breakpoint
CREATE TABLE "store_inventory_doc_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"stock_id" bigint,
	"sku_id" text NOT NULL,
	"sale_item_id" varchar(30),
	"sku_name" text NOT NULL,
	"batch_no" text DEFAULT '' NOT NULL,
	"expiry_date" date,
	"quantity" numeric(12, 2) NOT NULL,
	"stock_snapshot" numeric(12, 2),
	"unit_price" numeric(12, 2),
	"amount" numeric(12, 2),
	"request_quantity" numeric(12, 2),
	"fulfilled_quantity" numeric(12, 2),
	"scrap_reason" text,
	"item_usage" text,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_store_inventory_doc_items_qty" CHECK ("store_inventory_doc_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "store_inventory_docs" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_type" "store_inventory_doc_type" NOT NULL,
	"status" "store_inventory_doc_status" DEFAULT '草稿' NOT NULL,
	"store_id" text NOT NULL,
	"counterpart_store_id" text,
	"doc_date" date NOT NULL,
	"total_quantity" numeric(12, 2) DEFAULT '0' NOT NULL,
	"request_doc_id" text,
	"related_sale_order_id" varchar(30),
	"client_user_id" text,
	"customer_name" varchar(50),
	"receipt_attachment_url" text,
	"remark" text,
	"created_by" varchar(30) NOT NULL,
	"confirmed_by" varchar(30),
	"confirmed_at" timestamp with time zone,
	"approved_by" varchar(30),
	"approved_at" timestamp with time zone,
	"rejected_by" varchar(30),
	"rejected_at" timestamp with time zone,
	"audit_remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_store_inventory_docs_transfer_store" CHECK ("store_inventory_docs"."counterpart_store_id" IS NULL OR "store_inventory_docs"."store_id" <> "store_inventory_docs"."counterpart_store_id")
);
--> statement-breakpoint
CREATE TABLE "store_inventory_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"movement_key" text NOT NULL,
	"stock_id" bigint NOT NULL,
	"store_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"doc_id" text,
	"doc_item_id" bigint,
	"sale_order_id" varchar(30),
	"sale_item_id" varchar(30),
	"direction" "store_inventory_movement_direction" NOT NULL,
	"quantity_delta" numeric(12, 2) NOT NULL,
	"quantity_before" numeric(12, 2) NOT NULL,
	"quantity_after" numeric(12, 2) NOT NULL,
	"created_by" varchar(30),
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_store_inventory_movement_delta" CHECK ("store_inventory_movements"."quantity_delta" <> 0),
	CONSTRAINT "chk_store_inventory_movement_after" CHECK ("store_inventory_movements"."quantity_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "store_inventory_stocks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"sku_name" text NOT NULL,
	"product_type" "product_type" DEFAULT '家居产品' NOT NULL,
	"batch_no" text DEFAULT '' NOT NULL,
	"expiry_date" date,
	"expiry_date_key" text DEFAULT '' NOT NULL,
	"quantity_on_hand" numeric(12, 2) DEFAULT '0' NOT NULL,
	"last_unit_price" numeric(12, 2),
	"last_amount" numeric(12, 2),
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_store_inventory_stock_qty" CHECK ("store_inventory_stocks"."quantity_on_hand" >= 0)
);
--> statement-breakpoint
CREATE TABLE "system_configs" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_series_lookup" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_series_lookup_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "skill_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "lakala_merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_name" text NOT NULL,
	"merchant_no" text,
	"term_no" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"market_org_node_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_parent_id_org_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_lakala_merchant_id_lakala_merchants_id_fk" FOREIGN KEY ("lakala_merchant_id") REFERENCES "public"."lakala_merchants"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "mall_bundle_groups" ADD CONSTRAINT "mall_bundle_groups_product_id_products_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mall_product_skus" ADD CONSTRAINT "mall_product_skus_product_id_products_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mall_product_skus" ADD CONSTRAINT "mall_product_skus_sku_id_product_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mall_product_skus" ADD CONSTRAINT "mall_product_skus_bundle_group_id_mall_bundle_groups_id_fk" FOREIGN KEY ("bundle_group_id") REFERENCES "public"."mall_bundle_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_skus" ADD CONSTRAINT "product_skus_category_id_product_categories_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_skus" ADD CONSTRAINT "product_skus_project_series_id_project_series_lookup_id_fk" FOREIGN KEY ("project_series_id") REFERENCES "public"."project_series_lookup"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_mall_categories_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."mall_categories"("category_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD CONSTRAINT "client_wechat_users_bound_store_id_stores_store_id_fk" FOREIGN KEY ("bound_store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD CONSTRAINT "client_wechat_users_promoter_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("promoter_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_wechat_users" ADD CONSTRAINT "client_wechat_users_inviter_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD CONSTRAINT "staff_wechat_users_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_wechat_users" ADD CONSTRAINT "staff_wechat_users_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD CONSTRAINT "sale_allocations_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD CONSTRAINT "sale_allocations_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_allocations" ADD CONSTRAINT "sale_allocations_sale_payment_id_sale_order_payments_id_fk" FOREIGN KEY ("sale_payment_id") REFERENCES "public"."sale_order_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_ref_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("ref_sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sku_id_product_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_operator_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("operator_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_ref_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("ref_sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_order_payments" ADD CONSTRAINT "sale_order_payments_audit_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("audit_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_ref_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("ref_sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_opened_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_preferred_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("preferred_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_offline_confirmed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("offline_confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD CONSTRAINT "sale_orders_audited_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("audited_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_allocatable_items" ADD CONSTRAINT "sale_payment_allocatable_items_sale_payment_id_sale_order_payments_id_fk" FOREIGN KEY ("sale_payment_id") REFERENCES "public"."sale_order_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_allocatable_items" ADD CONSTRAINT "sale_payment_allocatable_items_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_allocatable_items" ADD CONSTRAINT "sale_payment_allocatable_items_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_item_allocations" ADD CONSTRAINT "sale_payment_item_allocations_sale_payment_item_receipt_id_sale_payment_item_receipts_id_fk" FOREIGN KEY ("sale_payment_item_receipt_id") REFERENCES "public"."sale_payment_item_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_item_allocations" ADD CONSTRAINT "sale_payment_item_allocations_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_item_receipts" ADD CONSTRAINT "sale_payment_item_receipts_sale_payment_id_sale_order_payments_id_fk" FOREIGN KEY ("sale_payment_id") REFERENCES "public"."sale_order_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_item_receipts" ADD CONSTRAINT "sale_payment_item_receipts_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payment_item_receipts" ADD CONSTRAINT "sale_payment_item_receipts_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_service_order_id_service_orders_service_order_id_fk" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("service_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_items" ADD CONSTRAINT "service_items_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_assigned_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_appointment_id_appointments_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("appointment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reviews" ADD CONSTRAINT "service_reviews_service_order_id_service_orders_service_order_id_fk" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("service_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reviews" ADD CONSTRAINT "service_reviews_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reviews" ADD CONSTRAINT "service_reviews_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_roles" ADD CONSTRAINT "permission_roles_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_roles" ADD CONSTRAINT "permission_roles_scope_id_org_nodes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rate_matrix" ADD CONSTRAINT "commission_rate_matrix_org_id_org_nodes_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_unbind_requests" ADD CONSTRAINT "store_unbind_requests_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_unbind_requests" ADD CONSTRAINT "store_unbind_requests_from_store_id_stores_store_id_fk" FOREIGN KEY ("from_store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_unbind_requests" ADD CONSTRAINT "store_unbind_requests_to_store_id_stores_store_id_fk" FOREIGN KEY ("to_store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_unbind_requests" ADD CONSTRAINT "store_unbind_requests_reviewed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_operator_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("operator_employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_logs" ADD CONSTRAINT "operation_logs_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_template_id_coupon_templates_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."coupon_templates"("template_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_used_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("used_sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_passwords" ADD CONSTRAINT "admin_passwords_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "point_transactions" ADD CONSTRAINT "point_transactions_ref_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("ref_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_card_id_prepaid_cards_card_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."prepaid_cards"("card_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_ref_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("ref_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepaid_cards" ADD CONSTRAINT "prepaid_cards_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_commissions" ADD CONSTRAINT "service_commissions_service_item_id_service_items_service_item_id_fk" FOREIGN KEY ("service_item_id") REFERENCES "public"."service_items"("service_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_commissions" ADD CONSTRAINT "service_commissions_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_records" ADD CONSTRAINT "pickup_records_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_records" ADD CONSTRAINT "pickup_records_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_records" ADD CONSTRAINT "pickup_records_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_records" ADD CONSTRAINT "pickup_records_confirmed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_order_items" ADD CONSTRAINT "inventory_procurement_order_items_order_id_inventory_procurement_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."inventory_procurement_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_orders" ADD CONSTRAINT "inventory_procurement_orders_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_orders" ADD CONSTRAINT "inventory_procurement_orders_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_procurement_orders" ADD CONSTRAINT "inventory_procurement_orders_confirmed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sale_order_items" ADD CONSTRAINT "inventory_sale_order_items_order_id_inventory_sale_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."inventory_sale_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sale_orders" ADD CONSTRAINT "inventory_sale_orders_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sale_orders" ADD CONSTRAINT "inventory_sale_orders_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sale_orders" ADD CONSTRAINT "inventory_sale_orders_related_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("related_sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sale_orders" ADD CONSTRAINT "inventory_sale_orders_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sale_orders" ADD CONSTRAINT "inventory_sale_orders_confirmed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scrap_order_items" ADD CONSTRAINT "inventory_scrap_order_items_order_id_inventory_scrap_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."inventory_scrap_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scrap_orders" ADD CONSTRAINT "inventory_scrap_orders_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scrap_orders" ADD CONSTRAINT "inventory_scrap_orders_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_scrap_orders" ADD CONSTRAINT "inventory_scrap_orders_confirmed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_order_items" ADD CONSTRAINT "inventory_transfer_order_items_order_id_inventory_transfer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."inventory_transfer_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_orders" ADD CONSTRAINT "inventory_transfer_orders_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_orders" ADD CONSTRAINT "inventory_transfer_orders_counterpart_store_id_stores_store_id_fk" FOREIGN KEY ("counterpart_store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_orders" ADD CONSTRAINT "inventory_transfer_orders_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transfer_orders" ADD CONSTRAINT "inventory_transfer_orders_confirmed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_doc_items" ADD CONSTRAINT "store_inventory_doc_items_doc_id_store_inventory_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."store_inventory_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_doc_items" ADD CONSTRAINT "store_inventory_doc_items_stock_id_store_inventory_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."store_inventory_stocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_doc_items" ADD CONSTRAINT "store_inventory_doc_items_sku_id_product_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_doc_items" ADD CONSTRAINT "store_inventory_doc_items_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_docs" ADD CONSTRAINT "store_inventory_docs_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_docs" ADD CONSTRAINT "store_inventory_docs_counterpart_store_id_stores_store_id_fk" FOREIGN KEY ("counterpart_store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_docs" ADD CONSTRAINT "store_inventory_docs_request_doc_id_store_inventory_docs_id_fk" FOREIGN KEY ("request_doc_id") REFERENCES "public"."store_inventory_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_docs" ADD CONSTRAINT "store_inventory_docs_related_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("related_sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_docs" ADD CONSTRAINT "store_inventory_docs_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_docs" ADD CONSTRAINT "store_inventory_docs_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_docs" ADD CONSTRAINT "store_inventory_docs_confirmed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_docs" ADD CONSTRAINT "store_inventory_docs_approved_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_docs" ADD CONSTRAINT "store_inventory_docs_rejected_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_movements" ADD CONSTRAINT "store_inventory_movements_stock_id_store_inventory_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "public"."store_inventory_stocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_movements" ADD CONSTRAINT "store_inventory_movements_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_movements" ADD CONSTRAINT "store_inventory_movements_sku_id_product_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_movements" ADD CONSTRAINT "store_inventory_movements_doc_id_store_inventory_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."store_inventory_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_movements" ADD CONSTRAINT "store_inventory_movements_doc_item_id_store_inventory_doc_items_id_fk" FOREIGN KEY ("doc_item_id") REFERENCES "public"."store_inventory_doc_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_movements" ADD CONSTRAINT "store_inventory_movements_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_movements" ADD CONSTRAINT "store_inventory_movements_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_movements" ADD CONSTRAINT "store_inventory_movements_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_stocks" ADD CONSTRAINT "store_inventory_stocks_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_inventory_stocks" ADD CONSTRAINT "store_inventory_stocks_sku_id_product_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lakala_merchants" ADD CONSTRAINT "lakala_merchants_market_org_node_id_org_nodes_id_fk" FOREIGN KEY ("market_org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_org_nodes_type" ON "org_nodes" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_parent_id" ON "org_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_stores_org_node_id" ON "stores" USING btree ("org_node_id");--> statement-breakpoint
CREATE INDEX "idx_stores_lakala_merchant_id" ON "stores" USING btree ("lakala_merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bundle_group" ON "mall_bundle_groups" USING btree ("product_id","group_name");--> statement-breakpoint
CREATE INDEX "idx_mall_product_skus_product_id" ON "mall_product_skus" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mall_product_sku" ON "mall_product_skus" USING btree ("product_id","sku_id");--> statement-breakpoint
CREATE INDEX "idx_product_skus_category_id" ON "product_skus" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_product_skus_is_experience" ON "product_skus" USING btree ("is_experience") WHERE "product_skus"."is_experience" = true;--> statement-breakpoint
CREATE INDEX "idx_product_skus_active" ON "product_skus" USING btree ("sku_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_products_active" ON "products" USING btree ("product_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_users_openid" ON "client_wechat_users" USING btree ("openid") WHERE openid IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_users_phone" ON "client_wechat_users" USING btree ("phone") WHERE phone IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_users_customer_id" ON "client_wechat_users" USING btree ("customer_id") WHERE customer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_client_users_bound_store_id" ON "client_wechat_users" USING btree ("bound_store_id");--> statement-breakpoint
CREATE INDEX "idx_client_users_inviter" ON "client_wechat_users" USING btree ("inviter_user_id") WHERE inviter_user_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_staff_users_openid" ON "staff_wechat_users" USING btree ("openid") WHERE openid IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_staff_users_phone" ON "staff_wechat_users" USING btree ("phone") WHERE phone IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_staff_users_store_resigned" ON "staff_wechat_users" USING btree ("store_id","is_resigned");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_alloc_item_emp_role_payment" ON "sale_allocations" USING btree ("sale_item_id","employee_id","role_type","sale_payment_id") WHERE is_void = false;--> statement-breakpoint
CREATE INDEX "idx_sale_alloc_employee_id" ON "sale_allocations" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_sale_alloc_payment" ON "sale_allocations" USING btree ("sale_payment_id");--> statement-breakpoint
CREATE INDEX "idx_sale_items_order_id" ON "sale_items" USING btree ("sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_sale_items_sku_id" ON "sale_items" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "idx_sale_items_ref" ON "sale_items" USING btree ("ref_sale_item_id");--> statement-breakpoint
CREATE INDEX "idx_sale_items_store_order" ON "sale_items" USING btree ("store_id","sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_sop_order" ON "sale_order_payments" USING btree ("sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_sop_alloc_status" ON "sale_order_payments" USING btree ("allocation_status") WHERE allocation_status IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sop_status_created" ON "sale_order_payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sop_txn" ON "sale_order_payments" USING btree ("sale_order_id","payment_method","external_txn_id") WHERE external_txn_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sop_status_audit" ON "sale_order_payments" USING btree ("sale_order_id","change_type") WHERE change_type = '退款' AND status = '待审批';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sop_first_payment" ON "sale_order_payments" USING btree ("sale_order_id") WHERE change_type = '首次支付' AND status = '已支付';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_orders_client_pending" ON "sale_orders" USING btree ("client_user_id") WHERE status = '待支付' AND client_user_id IS NOT NULL AND opened_by IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sale_orders_phone_pending" ON "sale_orders" USING btree ("client_phone","store_id") WHERE status = '待支付' AND client_user_id IS NULL;--> statement-breakpoint
CREATE INDEX "idx_sale_orders_store_status" ON "sale_orders" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "idx_sale_orders_ref" ON "sale_orders" USING btree ("ref_sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_sale_orders_client_user_id" ON "sale_orders" USING btree ("client_user_id") WHERE client_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_legacy_source_phone" ON "sale_orders" USING btree ("legacy_source","client_phone") WHERE legacy_source IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_legacy_source_status" ON "sale_orders" USING btree ("legacy_source","status") WHERE legacy_source IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spai_payment_item" ON "sale_payment_allocatable_items" USING btree ("sale_payment_id","sale_item_id");--> statement-breakpoint
CREATE INDEX "idx_spai_order" ON "sale_payment_allocatable_items" USING btree ("sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_spai_order_item" ON "sale_payment_allocatable_items" USING btree ("sale_order_id","sale_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spia_receipt_emp_role" ON "sale_payment_item_allocations" USING btree ("sale_payment_item_receipt_id","employee_id","role_type") WHERE is_void = false;--> statement-breakpoint
CREATE INDEX "idx_spia_receipt" ON "sale_payment_item_allocations" USING btree ("sale_payment_item_receipt_id");--> statement-breakpoint
CREATE INDEX "idx_spia_employee" ON "sale_payment_item_allocations" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spir_payment_item" ON "sale_payment_item_receipts" USING btree ("sale_payment_id","sale_item_id");--> statement-breakpoint
CREATE INDEX "idx_spir_payment" ON "sale_payment_item_receipts" USING btree ("sale_payment_id");--> statement-breakpoint
CREATE INDEX "idx_spir_order" ON "sale_payment_item_receipts" USING btree ("sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_spir_order_item" ON "sale_payment_item_receipts" USING btree ("sale_order_id","sale_item_id");--> statement-breakpoint
CREATE INDEX "idx_appts_store_id" ON "appointments" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "idx_appts_client_user_id" ON "appointments" USING btree ("client_user_id");--> statement-breakpoint
CREATE INDEX "idx_appts_employee_time" ON "appointments" USING btree ("employee_id","appointment_time");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_appt_sale_item_active" ON "appointments" USING btree ("sale_item_id") WHERE sale_item_id IS NOT NULL AND status IN ('待确认','已确认');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_appt_employee_time_active" ON "appointments" USING btree ("employee_id","appointment_time") WHERE employee_id IS NOT NULL AND status IN ('待确认','已确认');--> statement-breakpoint
CREATE INDEX "idx_svc_items_order_id" ON "service_items" USING btree ("service_order_id");--> statement-breakpoint
CREATE INDEX "idx_svc_items_sale_item_reserved" ON "service_items" USING btree ("sale_item_id") WHERE "service_items"."reserved_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_svc_orders_store_date" ON "service_orders" USING btree ("store_id","service_date");--> statement-breakpoint
CREATE INDEX "idx_svc_orders_assigned_employee" ON "service_orders" USING btree ("assigned_employee_id");--> statement-breakpoint
CREATE INDEX "idx_svc_orders_client_user_id" ON "service_orders" USING btree ("client_user_id");--> statement-breakpoint
CREATE INDEX "idx_svc_orders_status_updated" ON "service_orders" USING btree ("status","updated_at" DESC NULLS FIRST,"created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_so_appointment" ON "service_orders" USING btree ("appointment_id") WHERE appointment_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_so_client_active" ON "service_orders" USING btree ("client_user_id") WHERE status NOT IN ('已完成','已取消');--> statement-breakpoint
CREATE INDEX "idx_svc_reviews_employee" ON "service_reviews" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_perm_roles_emp_role_scope" ON "permission_roles" USING btree ("employee_id","role","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_store_unbind_pending" ON "store_unbind_requests" USING btree ("user_id") WHERE status = '待处理';--> statement-breakpoint
CREATE INDEX "idx_op_logs_operator" ON "operation_logs" USING btree ("operator_employee_id");--> statement-breakpoint
CREATE INDEX "idx_op_logs_target" ON "operation_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "idx_op_logs_action" ON "operation_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_op_logs_created_at" ON "operation_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_user_coupons_user_status" ON "user_coupons" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_user_coupons_used_order" ON "user_coupons" USING btree ("used_sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_user_coupons_expire" ON "user_coupons" USING btree ("expire_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_coupons_external_ref" ON "user_coupons" USING btree ("external_ref") WHERE external_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_admin_passwords_employee" ON "admin_passwords" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_login_attempts_phone" ON "login_attempts" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_point_txns_user_id" ON "point_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_point_txns_external_ref" ON "point_transactions" USING btree ("external_ref") WHERE external_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_point_txn_order_user_type" ON "point_transactions" USING btree ("user_id","ref_order_id","type") WHERE ref_order_id IS NOT NULL AND type IN ('消费赠送','消费冲销');--> statement-breakpoint
CREATE INDEX "idx_messages_recipient" ON "messages" USING btree ("recipient_type","recipient_id","is_read");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_idempotency_key" ON "messages" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_messages_active" ON "messages" USING btree ("created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_card_txns_card_id" ON "card_transactions" USING btree ("card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_card_txn_external_ref" ON "card_transactions" USING btree ("external_ref") WHERE external_ref IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prepaid_cards_user" ON "prepaid_cards" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_svc_comm_item_emp_role" ON "service_commissions" USING btree ("service_item_id","employee_id","role_type") WHERE is_void = false;--> statement-breakpoint
CREATE INDEX "idx_svc_comm_employee_id" ON "service_commissions" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_sc_voided_at" ON "service_commissions" USING btree ("voided_at") WHERE voided_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_pickup_records_sale_item" ON "pickup_records" USING btree ("sale_item_id");--> statement-breakpoint
CREATE INDEX "idx_pickup_records_client" ON "pickup_records" USING btree ("client_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pickup_idempotency" ON "pickup_records" USING btree ("sale_item_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_inv_proc_items_order" ON "inventory_procurement_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_inv_proc_items_product" ON "inventory_procurement_order_items" USING btree ("product_code");--> statement-breakpoint
CREATE INDEX "idx_inv_proc_items_batch" ON "inventory_procurement_order_items" USING btree ("batch_no");--> statement-breakpoint
CREATE INDEX "idx_inv_proc_store_date" ON "inventory_procurement_orders" USING btree ("store_id","doc_date");--> statement-breakpoint
CREATE INDEX "idx_inv_proc_subtype" ON "inventory_procurement_orders" USING btree ("doc_subtype");--> statement-breakpoint
CREATE INDEX "idx_inv_sale_items_order" ON "inventory_sale_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_inv_sale_items_product" ON "inventory_sale_order_items" USING btree ("product_code");--> statement-breakpoint
CREATE INDEX "idx_inv_sale_items_batch" ON "inventory_sale_order_items" USING btree ("batch_no");--> statement-breakpoint
CREATE INDEX "idx_inv_sale_store_date" ON "inventory_sale_orders" USING btree ("store_id","doc_date");--> statement-breakpoint
CREATE INDEX "idx_inv_sale_subtype" ON "inventory_sale_orders" USING btree ("doc_subtype");--> statement-breakpoint
CREATE INDEX "idx_inv_sale_client" ON "inventory_sale_orders" USING btree ("client_user_id");--> statement-breakpoint
CREATE INDEX "idx_inv_scrap_items_order" ON "inventory_scrap_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_inv_scrap_items_product" ON "inventory_scrap_order_items" USING btree ("product_code");--> statement-breakpoint
CREATE INDEX "idx_inv_scrap_items_batch" ON "inventory_scrap_order_items" USING btree ("batch_no");--> statement-breakpoint
CREATE INDEX "idx_inv_scrap_store_date" ON "inventory_scrap_orders" USING btree ("store_id","doc_date");--> statement-breakpoint
CREATE INDEX "idx_inv_transfer_items_order" ON "inventory_transfer_order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_inv_transfer_items_product" ON "inventory_transfer_order_items" USING btree ("product_code");--> statement-breakpoint
CREATE INDEX "idx_inv_transfer_items_batch" ON "inventory_transfer_order_items" USING btree ("batch_no");--> statement-breakpoint
CREATE INDEX "idx_inv_transfer_store_date" ON "inventory_transfer_orders" USING btree ("store_id","doc_date");--> statement-breakpoint
CREATE INDEX "idx_inv_transfer_counterpart" ON "inventory_transfer_orders" USING btree ("counterpart_store_id");--> statement-breakpoint
CREATE INDEX "idx_inv_transfer_subtype" ON "inventory_transfer_orders" USING btree ("doc_subtype");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_doc_items_doc" ON "store_inventory_doc_items" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_doc_items_stock" ON "store_inventory_doc_items" USING btree ("stock_id");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_doc_items_sku" ON "store_inventory_doc_items" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_doc_items_sale_item" ON "store_inventory_doc_items" USING btree ("sale_item_id");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_docs_store_date" ON "store_inventory_docs" USING btree ("store_id","doc_date");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_docs_type" ON "store_inventory_docs" USING btree ("doc_type");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_docs_status" ON "store_inventory_docs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_docs_request" ON "store_inventory_docs" USING btree ("request_doc_id");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_docs_sale_order" ON "store_inventory_docs" USING btree ("related_sale_order_id");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_docs_client" ON "store_inventory_docs" USING btree ("client_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_store_inventory_movement_key" ON "store_inventory_movements" USING btree ("movement_key");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_movements_stock" ON "store_inventory_movements" USING btree ("stock_id");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_movements_store_created" ON "store_inventory_movements" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_movements_doc" ON "store_inventory_movements" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_movements_sale_item" ON "store_inventory_movements" USING btree ("sale_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_store_inventory_stock" ON "store_inventory_stocks" USING btree ("store_id","sku_id","batch_no","expiry_date_key");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_stock_store" ON "store_inventory_stocks" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "idx_store_inventory_stock_sku" ON "store_inventory_stocks" USING btree ("sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lakala_merchants_merchant_no" ON "lakala_merchants" USING btree ("merchant_no") WHERE "lakala_merchants"."merchant_no" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_lakala_merchants_market_org_node_id" ON "lakala_merchants" USING btree ("market_org_node_id");