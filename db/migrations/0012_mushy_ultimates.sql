CREATE TABLE "inventory_sku_product_sku_mappings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_sku_id" text NOT NULL,
	"inventory_sku_id" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pickup_records" ADD COLUMN "inventory_sku_id" text;--> statement-breakpoint
ALTER TABLE "inventory_sku_product_sku_mappings" ADD CONSTRAINT "inventory_sku_product_sku_mappings_product_sku_id_product_skus_sku_id_fk" FOREIGN KEY ("product_sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sku_product_sku_mappings" ADD CONSTRAINT "inventory_sku_product_sku_mappings_inventory_sku_id_inventory_skus_sku_id_fk" FOREIGN KEY ("inventory_sku_id") REFERENCES "public"."inventory_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sku_product_sku_mappings" ADD CONSTRAINT "inventory_sku_product_sku_mappings_created_by_staff_wechat_users_employee_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_wechat_users"("employee_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_product_sku_mapping" ON "inventory_sku_product_sku_mappings" USING btree ("product_sku_id","inventory_sku_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_product_sku_mappings_product" ON "inventory_sku_product_sku_mappings" USING btree ("product_sku_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_product_sku_mappings_inventory" ON "inventory_sku_product_sku_mappings" USING btree ("inventory_sku_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_product_sku_mappings_active" ON "inventory_sku_product_sku_mappings" USING btree ("product_sku_id") WHERE "inventory_sku_product_sku_mappings"."is_active" = true;--> statement-breakpoint
ALTER TABLE "pickup_records" ADD CONSTRAINT "pickup_records_inventory_sku_id_inventory_skus_sku_id_fk" FOREIGN KEY ("inventory_sku_id") REFERENCES "public"."inventory_skus"("sku_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pickup_records_inventory_sku" ON "pickup_records" USING btree ("inventory_sku_id");