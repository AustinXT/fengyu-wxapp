DO $$ BEGIN
  CREATE TYPE "public"."store_inventory_doc_type" AS ENUM (
    '院报货',
    '院入库',
    '院顾客退货',
    '院顾客产品出库',
    '院退货',
    '院产品报损',
    '分院调货出库',
    '分院调货入库',
    '期初库存'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."store_inventory_doc_status" AS ENUM (
    '草稿',
    '待审批',
    '待收货',
    '已完成',
    '已驳回',
    '已取消'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."store_inventory_movement_direction" AS ENUM (
    '入库',
    '出库',
    '调整'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "store_inventory_stocks" (
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

CREATE TABLE IF NOT EXISTS "store_inventory_docs" (
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

CREATE TABLE IF NOT EXISTS "store_inventory_doc_items" (
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

CREATE TABLE IF NOT EXISTS "store_inventory_movements" (
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

DO $$ BEGIN
  ALTER TABLE "store_inventory_stocks"
    ADD CONSTRAINT "store_inventory_stocks_store_id_stores_store_id_fk"
    FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_stocks"
    ADD CONSTRAINT "store_inventory_stocks_sku_id_product_skus_sku_id_fk"
    FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_docs"
    ADD CONSTRAINT "store_inventory_docs_store_id_stores_store_id_fk"
    FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_docs"
    ADD CONSTRAINT "store_inventory_docs_counterpart_store_id_stores_store_id_fk"
    FOREIGN KEY ("counterpart_store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_docs"
    ADD CONSTRAINT "store_inventory_docs_request_doc_id_store_inventory_docs_id_fk"
    FOREIGN KEY ("request_doc_id") REFERENCES "public"."store_inventory_docs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_docs"
    ADD CONSTRAINT "store_inventory_docs_related_sale_order_id_sale_orders_sale_order_id_fk"
    FOREIGN KEY ("related_sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_docs"
    ADD CONSTRAINT "store_inventory_docs_client_user_id_client_wechat_users_user_id_fk"
    FOREIGN KEY ("client_user_id") REFERENCES "public"."client_wechat_users"("user_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_docs"
    ADD CONSTRAINT "store_inventory_docs_created_by_staff_wechat_users_employee_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_docs"
    ADD CONSTRAINT "store_inventory_docs_confirmed_by_staff_wechat_users_employee_id_fk"
    FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_docs"
    ADD CONSTRAINT "store_inventory_docs_approved_by_staff_wechat_users_employee_id_fk"
    FOREIGN KEY ("approved_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_docs"
    ADD CONSTRAINT "store_inventory_docs_rejected_by_staff_wechat_users_employee_id_fk"
    FOREIGN KEY ("rejected_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_doc_items"
    ADD CONSTRAINT "store_inventory_doc_items_doc_id_store_inventory_docs_id_fk"
    FOREIGN KEY ("doc_id") REFERENCES "public"."store_inventory_docs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_doc_items"
    ADD CONSTRAINT "store_inventory_doc_items_stock_id_store_inventory_stocks_id_fk"
    FOREIGN KEY ("stock_id") REFERENCES "public"."store_inventory_stocks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_doc_items"
    ADD CONSTRAINT "store_inventory_doc_items_sku_id_product_skus_sku_id_fk"
    FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_doc_items"
    ADD CONSTRAINT "store_inventory_doc_items_sale_item_id_sale_items_sale_item_id_fk"
    FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_movements"
    ADD CONSTRAINT "store_inventory_movements_stock_id_store_inventory_stocks_id_fk"
    FOREIGN KEY ("stock_id") REFERENCES "public"."store_inventory_stocks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_movements"
    ADD CONSTRAINT "store_inventory_movements_store_id_stores_store_id_fk"
    FOREIGN KEY ("store_id") REFERENCES "public"."stores"("store_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_movements"
    ADD CONSTRAINT "store_inventory_movements_sku_id_product_skus_sku_id_fk"
    FOREIGN KEY ("sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_movements"
    ADD CONSTRAINT "store_inventory_movements_doc_id_store_inventory_docs_id_fk"
    FOREIGN KEY ("doc_id") REFERENCES "public"."store_inventory_docs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_movements"
    ADD CONSTRAINT "store_inventory_movements_doc_item_id_store_inventory_doc_items_id_fk"
    FOREIGN KEY ("doc_item_id") REFERENCES "public"."store_inventory_doc_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_movements"
    ADD CONSTRAINT "store_inventory_movements_sale_order_id_sale_orders_sale_order_id_fk"
    FOREIGN KEY ("sale_order_id") REFERENCES "public"."sale_orders"("sale_order_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_movements"
    ADD CONSTRAINT "store_inventory_movements_sale_item_id_sale_items_sale_item_id_fk"
    FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("sale_item_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "store_inventory_movements"
    ADD CONSTRAINT "store_inventory_movements_created_by_staff_wechat_users_employee_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "uq_store_inventory_stock"
  ON "store_inventory_stocks" USING btree ("store_id", "sku_id", "batch_no", "expiry_date_key");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_stock_store" ON "store_inventory_stocks" USING btree ("store_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_stock_sku" ON "store_inventory_stocks" USING btree ("sku_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_docs_store_date" ON "store_inventory_docs" USING btree ("store_id", "doc_date");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_docs_type" ON "store_inventory_docs" USING btree ("doc_type");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_docs_status" ON "store_inventory_docs" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_docs_request" ON "store_inventory_docs" USING btree ("request_doc_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_docs_sale_order" ON "store_inventory_docs" USING btree ("related_sale_order_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_docs_client" ON "store_inventory_docs" USING btree ("client_user_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_doc_items_doc" ON "store_inventory_doc_items" USING btree ("doc_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_doc_items_stock" ON "store_inventory_doc_items" USING btree ("stock_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_doc_items_sku" ON "store_inventory_doc_items" USING btree ("sku_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_doc_items_sale_item" ON "store_inventory_doc_items" USING btree ("sale_item_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_store_inventory_movement_key" ON "store_inventory_movements" USING btree ("movement_key");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_movements_stock" ON "store_inventory_movements" USING btree ("stock_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_movements_store_created" ON "store_inventory_movements" USING btree ("store_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_movements_doc" ON "store_inventory_movements" USING btree ("doc_id");
CREATE INDEX IF NOT EXISTS "idx_store_inventory_movements_sale_item" ON "store_inventory_movements" USING btree ("sale_item_id");
