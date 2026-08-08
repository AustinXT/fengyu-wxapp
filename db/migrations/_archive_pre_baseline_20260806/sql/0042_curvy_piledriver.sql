CREATE TYPE "public"."inventory_doc_status" AS ENUM('草稿', '已完成', '已取消');--> statement-breakpoint
CREATE TYPE "public"."inventory_procurement_subtype" AS ENUM('院报货', '院入库', '退货出库');--> statement-breakpoint
CREATE TYPE "public"."inventory_sale_subtype" AS ENUM('销售出库', '顾客退货');--> statement-breakpoint
CREATE TYPE "public"."inventory_transfer_subtype" AS ENUM('调拨出库', '调拨入库');--> statement-breakpoint
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
	"created_at" timestamp DEFAULT now() NOT NULL,
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
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"created_at" timestamp DEFAULT now() NOT NULL,
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
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"created_at" timestamp DEFAULT now() NOT NULL,
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
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"created_at" timestamp DEFAULT now() NOT NULL,
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
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inv_transfer_different_stores" CHECK ("inventory_transfer_orders"."store_id" <> "inventory_transfer_orders"."counterpart_store_id")
);
--> statement-breakpoint
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
CREATE INDEX "idx_inv_transfer_subtype" ON "inventory_transfer_orders" USING btree ("doc_subtype");