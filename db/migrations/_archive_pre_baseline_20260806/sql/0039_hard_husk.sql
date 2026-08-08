CREATE TABLE "legacy_product_mapping" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"legacy_product_name" text NOT NULL,
	"legacy_product_code" text DEFAULT '' NOT NULL,
	"target_category_id" text,
	"target_sku_id" text,
	"source" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_product_mapping" ADD CONSTRAINT "legacy_product_mapping_target_category_id_product_categories_category_id_fk" FOREIGN KEY ("target_category_id") REFERENCES "public"."product_categories"("category_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_product_mapping" ADD CONSTRAINT "legacy_product_mapping_target_sku_id_product_skus_sku_id_fk" FOREIGN KEY ("target_sku_id") REFERENCES "public"."product_skus"("sku_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_legacy_product_name_code" ON "legacy_product_mapping" USING btree ("legacy_product_name","legacy_product_code");--> statement-breakpoint
CREATE INDEX "idx_lpm_target_category" ON "legacy_product_mapping" USING btree ("target_category_id");--> statement-breakpoint
CREATE INDEX "idx_lpm_target_sku" ON "legacy_product_mapping" USING btree ("target_sku_id");--> statement-breakpoint
CREATE INDEX "idx_lpm_unmapped" ON "legacy_product_mapping" USING btree ("confirmed") WHERE confirmed = false;