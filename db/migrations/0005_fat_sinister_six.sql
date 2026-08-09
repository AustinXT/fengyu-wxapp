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
CREATE TABLE "inventory_import_refs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"legacy_table" text NOT NULL,
	"legacy_rid" text NOT NULL,
	"legacy_obyid" text DEFAULT '' NOT NULL,
	"legacy_doc_no" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
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
ALTER TABLE "inventory_docs" ADD COLUMN "market_id" text;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD COLUMN "supplier_id" text;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD COLUMN "external_party_name" text;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD COLUMN "cancelled_by" varchar(30);--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_from_doc_id_inventory_docs_id_fk" FOREIGN KEY ("from_doc_id") REFERENCES "public"."inventory_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_to_doc_id_inventory_docs_id_fk" FOREIGN KEY ("to_doc_id") REFERENCES "public"."inventory_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_from_item_id_inventory_doc_items_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."inventory_doc_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_doc_links" ADD CONSTRAINT "inventory_doc_links_to_item_id_inventory_doc_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."inventory_doc_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_request_doc_id_inventory_docs_id_fk" FOREIGN KEY ("request_doc_id") REFERENCES "public"."inventory_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_request_item_id_inventory_doc_items_id_fk" FOREIGN KEY ("request_item_id") REFERENCES "public"."inventory_doc_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_lot_id_inventory_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_location_id_inventory_locations_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("location_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_sku_id_inventory_skus_sku_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."inventory_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_stock_reservations" ADD CONSTRAINT "inventory_stock_reservations_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_from" ON "inventory_doc_links" USING btree ("from_doc_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_to" ON "inventory_doc_links" USING btree ("to_doc_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_from_item" ON "inventory_doc_links" USING btree ("from_item_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_to_item" ON "inventory_doc_links" USING btree ("to_item_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_doc_links_relation" ON "inventory_doc_links" USING btree ("relation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_import_refs_legacy" ON "inventory_import_refs" USING btree ("entity_type","legacy_table","legacy_rid","legacy_obyid");--> statement-breakpoint
CREATE INDEX "idx_inventory_import_refs_entity" ON "inventory_import_refs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_import_refs_doc_no" ON "inventory_import_refs" USING btree ("legacy_doc_no");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_reservations_lot" ON "inventory_stock_reservations" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_reservations_request" ON "inventory_stock_reservations" USING btree ("request_doc_id","request_item_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_reservations_location_sku" ON "inventory_stock_reservations" USING btree ("location_id","sku_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_stock_reservations_status" ON "inventory_stock_reservations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_suppliers_name" ON "inventory_suppliers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_inventory_suppliers_active" ON "inventory_suppliers" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_market_id_org_nodes_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_supplier_id_inventory_suppliers_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."inventory_suppliers"("supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_employee_id_staff_wechat_users_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "inventory_docs_cancelled_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_market" ON "inventory_docs" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_supplier" ON "inventory_docs" USING btree ("supplier_id");