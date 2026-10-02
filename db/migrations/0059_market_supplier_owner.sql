DROP INDEX "uq_inventory_suppliers_name";--> statement-breakpoint
ALTER TABLE "inventory_suppliers" ADD COLUMN "owner_market_id" text;--> statement-breakpoint
ALTER TABLE "inventory_suppliers" ADD CONSTRAINT "inventory_suppliers_owner_market_id_org_nodes_id_fk" FOREIGN KEY ("owner_market_id") REFERENCES "public"."org_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_suppliers_shared_name" ON "inventory_suppliers" USING btree ("name") WHERE "inventory_suppliers"."owner_market_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_suppliers_market_name" ON "inventory_suppliers" USING btree ("owner_market_id","name") WHERE "inventory_suppliers"."owner_market_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_inventory_suppliers_owner_market" ON "inventory_suppliers" USING btree ("owner_market_id");