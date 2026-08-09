CREATE TABLE "inventory_doc_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"lot_id" bigint,
	"sku_id" text NOT NULL,
	"sale_item_id" varchar(30),
	"sku_name" text NOT NULL,
	"spec_name" text,
	"supplier" text,
	"product_series" text,
	"batch_no" text DEFAULT '' NOT NULL,
	"expiry_date" date,
	"is_gift" boolean DEFAULT false NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"stock_snapshot" numeric(12, 2),
	"request_quantity" numeric(12, 2),
	"fulfilled_quantity" numeric(12, 2),
	"standard_unit_price" numeric(12, 2),
	"unit_discount" numeric(12, 2),
	"actual_unit_price" numeric(12, 2),
	"amount" numeric(12, 2),
	"supply_chain_unit_cost" numeric(12, 2),
	"market_standard_unit_price" numeric(12, 2),
	"market_unit_discount" numeric(12, 2),
	"market_actual_unit_price" numeric(12, 2),
	"store_standard_unit_price" numeric(12, 2),
	"store_unit_discount" numeric(12, 2),
	"store_actual_unit_price" numeric(12, 2),
	"reason" text,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_doc_items_qty" CHECK ("inventory_doc_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_doc_links" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_doc_id" text NOT NULL,
	"to_doc_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"from_item_id" bigint,
	"to_item_id" bigint,
	"quantity" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_doc_links_distinct_docs" CHECK ("inventory_doc_links"."from_doc_id" <> "inventory_doc_links"."to_doc_id"),
	CONSTRAINT "chk_inventory_doc_links_quantity" CHECK ("inventory_doc_links"."quantity" IS NULL OR "inventory_doc_links"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_docs" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_type" text NOT NULL,
	"status" text DEFAULT '草稿' NOT NULL,
	"source_location_id" text,
	"target_location_id" text,
	"market_id" text,
	"supplier_id" text,
	"doc_date" date NOT NULL,
	"related_doc_id" text,
	"request_doc_id" text,
	"related_sale_order_id" varchar(30),
	"client_user_id" text,
	"customer_name" varchar(50),
	"employee_id" varchar(30),
	"employee_name" text,
	"supplier_name" text,
	"external_party_name" text,
	"logistics_company" text,
	"tracking_no" text,
	"receipt_attachment_url" text,
	"total_quantity" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_amount" numeric(12, 2),
	"remark" text,
	"audit_remark" text,
	"created_by" varchar(30) NOT NULL,
	"confirmed_by" varchar(30),
	"confirmed_at" timestamp with time zone,
	"approved_by" varchar(30),
	"approved_at" timestamp with time zone,
	"rejected_by" varchar(30),
	"rejected_at" timestamp with time zone,
	"cancellation_reason" text,
	"cancelled_by" varchar(30),
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_docs_status" CHECK ("inventory_docs"."status" IN ('草稿','待审批','待收货','已完成','已驳回','已取消')),
	CONSTRAINT "chk_inventory_docs_location_pair" CHECK ("inventory_docs"."source_location_id" IS NULL
        OR "inventory_docs"."target_location_id" IS NULL
        OR "inventory_docs"."source_location_id" <> "inventory_docs"."target_location_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_import_refs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"legacy_table" text NOT NULL,
	"legacy_rid" text NOT NULL,
	"legacy_obyid" text NOT NULL,
	"legacy_doc_no" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_import_refs_complete_identity" CHECK ("inventory_import_refs"."legacy_obyid" <> '')
);
--> statement-breakpoint
CREATE TABLE "inventory_locations" (
	"location_id" text PRIMARY KEY NOT NULL,
	"location_type" text NOT NULL,
	"name" text NOT NULL,
	"org_node_id" text,
	"store_id" text,
	"parent_location_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_locations_type" CHECK ("inventory_locations"."location_type" IN ('总部','市场','门店'))
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"movement_key" text NOT NULL,
	"lot_id" bigint NOT NULL,
	"location_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"doc_id" text,
	"doc_item_id" bigint,
	"direction" text NOT NULL,
	"quantity_delta" numeric(12, 2) NOT NULL,
	"quantity_before" numeric(12, 2) NOT NULL,
	"quantity_after" numeric(12, 2) NOT NULL,
	"created_by" varchar(30),
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_movements_direction" CHECK ("inventory_movements"."direction" IN ('入库','出库','调整')),
	CONSTRAINT "chk_inventory_movements_delta" CHECK ("inventory_movements"."quantity_delta" <> 0),
	CONSTRAINT "chk_inventory_movements_after" CHECK ("inventory_movements"."quantity_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_promotion_plan_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"market_base_price" numeric(12, 2),
	"market_unit_discount" numeric(12, 2),
	"market_actual_price" numeric(12, 2),
	"store_base_price" numeric(12, 2),
	"store_unit_discount" numeric(12, 2),
	"store_actual_price" numeric(12, 2),
	"report_min_quantity" numeric(12, 2),
	"report_max_quantity" numeric(12, 2),
	"is_tiered" boolean DEFAULT false NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_promotion_qty_range" CHECK ("inventory_promotion_plan_items"."report_max_quantity" IS NULL
        OR "inventory_promotion_plan_items"."report_min_quantity" IS NULL
        OR "inventory_promotion_plan_items"."report_max_quantity" >= "inventory_promotion_plan_items"."report_min_quantity")
);
--> statement-breakpoint
CREATE TABLE "inventory_promotion_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_no" text NOT NULL,
	"name" text NOT NULL,
	"starts_at" date NOT NULL,
	"ends_at" date NOT NULL,
	"scope_market_id" text,
	"scope_store_id" text,
	"status" text DEFAULT '启用' NOT NULL,
	"remark" text,
	"created_by" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_promotion_status" CHECK ("inventory_promotion_plans"."status" IN ('启用','停用')),
	CONSTRAINT "chk_inventory_promotion_date" CHECK ("inventory_promotion_plans"."ends_at" >= "inventory_promotion_plans"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "inventory_skus" (
	"sku_id" text PRIMARY KEY NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text NOT NULL,
	"spec_name" text,
	"supplier" text,
	"manufacturer" text,
	"brand" text,
	"product_series" text,
	"purchase_category" text,
	"source_type" text DEFAULT '供应链' NOT NULL,
	"owner_market_id" text,
	"retail_price" numeric(12, 2),
	"accounting_price" numeric(12, 2),
	"supply_chain_purchase_price" numeric(12, 2),
	"market_purchase_price" numeric(12, 2),
	"store_purchase_price" numeric(12, 2),
	"market_staff_purchase_price" numeric(12, 2),
	"market_purchase_discount" numeric(8, 4),
	"store_purchase_discount" numeric(8, 4),
	"staff_purchase_discount" numeric(8, 4),
	"item_company_purchase_price" numeric(12, 2),
	"is_reportable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_skus_source_type" CHECK ("inventory_skus"."source_type" IN ('供应链','市场自采','转让店')),
	CONSTRAINT "chk_inventory_skus_prices_nonnegative" CHECK (COALESCE("inventory_skus"."retail_price", 0) >= 0
       AND COALESCE("inventory_skus"."accounting_price", 0) >= 0
       AND COALESCE("inventory_skus"."supply_chain_purchase_price", 0) >= 0
       AND COALESCE("inventory_skus"."market_purchase_price", 0) >= 0
       AND COALESCE("inventory_skus"."store_purchase_price", 0) >= 0
       AND COALESCE("inventory_skus"."market_staff_purchase_price", 0) >= 0
       AND COALESCE("inventory_skus"."item_company_purchase_price", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_stock_lots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"lot_key" text NOT NULL,
	"sku_name" text NOT NULL,
	"spec_name" text,
	"supplier" text,
	"product_series" text,
	"batch_no" text DEFAULT '' NOT NULL,
	"expiry_date" date,
	"expiry_date_key" text DEFAULT '' NOT NULL,
	"is_gift" boolean DEFAULT false NOT NULL,
	"quantity_on_hand" numeric(12, 2) DEFAULT '0' NOT NULL,
	"supply_chain_unit_cost" numeric(12, 2),
	"market_standard_unit_price" numeric(12, 2),
	"market_unit_discount" numeric(12, 2),
	"market_actual_unit_price" numeric(12, 2),
	"store_standard_unit_price" numeric(12, 2),
	"store_unit_discount" numeric(12, 2),
	"store_actual_unit_price" numeric(12, 2),
	"source_doc_id" text,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_stock_lots_qty" CHECK ("inventory_stock_lots"."quantity_on_hand" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_stock_reservations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_doc_id" text NOT NULL,
	"request_item_id" bigint NOT NULL,
	"lot_id" bigint NOT NULL,
	"location_id" text NOT NULL,
	"sku_id" text NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"fulfilled_quantity" numeric(12, 2) DEFAULT '0' NOT NULL,
	"released_quantity" numeric(12, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT '已预留' NOT NULL,
	"created_by" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_inventory_stock_reservations_quantity" CHECK ("inventory_stock_reservations"."quantity" > 0),
	CONSTRAINT "chk_inventory_stock_reservations_progress" CHECK ("inventory_stock_reservations"."fulfilled_quantity" >= 0
        AND "inventory_stock_reservations"."released_quantity" >= 0
        AND "inventory_stock_reservations"."fulfilled_quantity" + "inventory_stock_reservations"."released_quantity" <= "inventory_stock_reservations"."quantity"),
	CONSTRAINT "chk_inventory_stock_reservations_status" CHECK ("inventory_stock_reservations"."status" IN ('已预留','已完成','已释放'))
);
--> statement-breakpoint
CREATE TABLE "inventory_suppliers" (
	"supplier_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"phone" varchar(30),
	"address" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "inventory_doc_items_doc_id_inventory_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."inventory_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "inventory_doc_items_lot_id_inventory_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "inventory_doc_items_sku_id_inventory_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."inventory_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_items" ADD CONSTRAINT "inventory_doc_items_sale_item_id_sale_items_sale_item_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_from_doc_id_inventory_docs_id_fk" FOREIGN KEY ("from_doc_id") REFERENCES "public"."inventory_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_to_doc_id_inventory_docs_id_fk" FOREIGN KEY ("to_doc_id") REFERENCES "public"."inventory_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_from_item_id_inventory_doc_items_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."inventory_doc_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_to_item_id_inventory_doc_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."inventory_doc_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_source_location_id_inventory_locations_location_id_fk" FOREIGN KEY ("source_location_id") REFERENCES "public"."inventory_locations"("location_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_target_location_id_inventory_locations_location_id_fk" FOREIGN KEY ("target_location_id") REFERENCES "public"."inventory_locations"("location_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_market_id_org_nodes_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_supplier_id_inventory_suppliers_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."inventory_suppliers"("supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_related_sale_order_id_sale_orders_sale_order_id_fk" FOREIGN KEY ("related_sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_client_user_id_client_wechat_users_user_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_confirmed_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_approved_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_rejected_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_cancelled_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_org_node_id_org_nodes_id_fk" FOREIGN KEY ("org_node_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_store_id_stores_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_lot_id_inventory_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_inventory_locations_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("location_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_sku_id_inventory_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."inventory_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_doc_id_inventory_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."inventory_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_doc_item_id_inventory_doc_items_id_fk" FOREIGN KEY ("doc_item_id") REFERENCES "public"."inventory_doc_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_promotion_plan_items" ADD CONSTRAINT "inventory_promotion_plan_items_plan_id_inventory_promotion_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."inventory_promotion_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_promotion_plan_items" ADD CONSTRAINT "inventory_promotion_plan_items_sku_id_inventory_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."inventory_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_promotion_plans" ADD CONSTRAINT "inventory_promotion_plans_scope_market_id_org_nodes_id_fk" FOREIGN KEY ("scope_market_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_promotion_plans" ADD CONSTRAINT "inventory_promotion_plans_scope_store_id_stores_store_id_fk" FOREIGN KEY ("scope_store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_promotion_plans" ADD CONSTRAINT "inventory_promotion_plans_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_skus" ADD CONSTRAINT "inventory_skus_owner_market_id_org_nodes_id_fk" FOREIGN KEY ("owner_market_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_lots" ADD CONSTRAINT "inventory_stock_lots_location_id_inventory_locations_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("location_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_lots" ADD CONSTRAINT "inventory_stock_lots_sku_id_inventory_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."inventory_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_request_doc_id_inventory_docs_id_fk" FOREIGN KEY ("request_doc_id") REFERENCES "public"."inventory_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_request_item_id_inventory_doc_items_id_fk" FOREIGN KEY ("request_item_id") REFERENCES "public"."inventory_doc_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_lot_id_inventory_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_location_id_inventory_locations_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("location_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_sku_id_inventory_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."inventory_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_items_doc" ON "inventory_doc_items" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_items_lot" ON "inventory_doc_items" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_items_sku" ON "inventory_doc_items" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_from" ON "inventory_doc_links" USING btree ("from_doc_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_to" ON "inventory_doc_links" USING btree ("to_doc_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_from_item" ON "inventory_doc_links" USING btree ("from_item_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_to_item" ON "inventory_doc_links" USING btree ("to_item_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_relation" ON "inventory_doc_links" USING btree ("relation_type");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_type" ON "inventory_docs" USING btree ("doc_type");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_status" ON "inventory_docs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_date" ON "inventory_docs" USING btree ("doc_date");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_source" ON "inventory_docs" USING btree ("source_location_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_target" ON "inventory_docs" USING btree ("target_location_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_market" ON "inventory_docs" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_supplier" ON "inventory_docs" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_related" ON "inventory_docs" USING btree ("related_doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_import_refs_legacy" ON "inventory_import_refs" USING btree ("entity_type","legacy_table","legacy_rid","legacy_obyid");--> statement-breakpoint
CREATE INDEX "idx_inventory_import_refs_entity" ON "inventory_import_refs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_import_refs_doc_no" ON "inventory_import_refs" USING btree ("legacy_doc_no");--> statement-breakpoint
CREATE INDEX "idx_inventory_locations_type" ON "inventory_locations" USING btree ("location_type");--> statement-breakpoint
CREATE INDEX "idx_inventory_locations_org" ON "inventory_locations" USING btree ("org_node_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_locations_store" ON "inventory_locations" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_movement_key" ON "inventory_movements" USING btree ("movement_key");--> statement-breakpoint
CREATE INDEX "idx_inventory_movements_lot" ON "inventory_movements" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_movements_location_created" ON "inventory_movements" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_inventory_movements_doc" ON "inventory_movements" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_promotion_items_plan" ON "inventory_promotion_plan_items" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_promotion_items_sku" ON "inventory_promotion_plan_items" USING btree ("sku_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_promotion_plan_no" ON "inventory_promotion_plans" USING btree ("plan_no");--> statement-breakpoint
CREATE INDEX "idx_inventory_promotion_scope_market" ON "inventory_promotion_plans" USING btree ("scope_market_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_promotion_scope_store" ON "inventory_promotion_plans" USING btree ("scope_store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_skus_product_code" ON "inventory_skus" USING btree ("product_code");--> statement-breakpoint
CREATE INDEX "idx_inventory_skus_name" ON "inventory_skus" USING btree ("product_name");--> statement-breakpoint
CREATE INDEX "idx_inventory_skus_series" ON "inventory_skus" USING btree ("product_series");--> statement-breakpoint
CREATE INDEX "idx_inventory_skus_source" ON "inventory_skus" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "idx_inventory_skus_owner_market" ON "inventory_skus" USING btree ("owner_market_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_stock_lot" ON "inventory_stock_lots" USING btree ("location_id","lot_key");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_lots_location" ON "inventory_stock_lots" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_lots_sku" ON "inventory_stock_lots" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_lots_batch" ON "inventory_stock_lots" USING btree ("batch_no");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_reservations_lot" ON "inventory_stock_reservations" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_reservations_request" ON "inventory_stock_reservations" USING btree ("request_doc_id","request_item_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_reservations_location_sku" ON "inventory_stock_reservations" USING btree ("location_id","sku_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_reservations_status" ON "inventory_stock_reservations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_suppliers_name" ON "inventory_suppliers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_inventory_suppliers_active" ON "inventory_suppliers" USING btree ("is_active");--> statement-breakpoint
INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, parent_location_id, is_active)
SELECT id, type, name, id, parent_id, is_active
  FROM org_nodes
 WHERE type IN ('总部', '市场')
ON CONFLICT (location_id) DO UPDATE
  SET location_type = EXCLUDED.location_type,
      name = EXCLUDED.name,
      org_node_id = EXCLUDED.org_node_id,
      parent_location_id = EXCLUDED.parent_location_id,
      is_active = EXCLUDED.is_active,
      updated_at = now();--> statement-breakpoint
INSERT INTO inventory_locations (location_id, location_type, name, org_node_id, store_id, parent_location_id, is_active)
SELECT s.store_id, '门店', s.store_name, s.org_node_id, s.store_id, o.parent_id,
       COALESCE(o.is_active, false) AND NOT s.is_closed
  FROM stores s
  LEFT JOIN org_nodes o ON o.id = s.org_node_id
ON CONFLICT (location_id) DO UPDATE
  SET location_type = EXCLUDED.location_type,
      name = EXCLUDED.name,
      org_node_id = EXCLUDED.org_node_id,
      store_id = EXCLUDED.store_id,
      parent_location_id = EXCLUDED.parent_location_id,
      is_active = EXCLUDED.is_active,
      updated_at = now();
