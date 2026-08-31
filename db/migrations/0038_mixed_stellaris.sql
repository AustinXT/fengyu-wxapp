ALTER TABLE "inventory_docs" RENAME COLUMN "source_location_id" TO "source_org_node_id";--> statement-breakpoint
ALTER TABLE "inventory_docs" RENAME COLUMN "target_location_id" TO "target_org_node_id";--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP CONSTRAINT "chk_inventory_docs_location_pair";--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP CONSTRAINT "inventory_docs_source_location_id_inventory_locations_location_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP CONSTRAINT "inventory_docs_target_location_id_inventory_locations_location_id_fk";
--> statement-breakpoint
DROP INDEX "idx_inventory_docs_source";--> statement-breakpoint
DROP INDEX "idx_inventory_docs_target";--> statement-breakpoint
DROP INDEX "idx_inventory_locations_org";--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_source_org_node" ON "inventory_docs" USING btree ("source_org_node_id");--> statement-breakpoint
CREATE INDEX "idx_inventory_docs_target_org_node" ON "inventory_docs" USING btree ("target_org_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inventory_locations_org" ON "inventory_locations" USING btree ("org_node_id");--> statement-breakpoint
ALTER TABLE "inventory_docs" ADD CONSTRAINT "chk_inventory_docs_org_endpoint" CHECK ("inventory_docs"."source_org_node_id" IS NOT NULL OR "inventory_docs"."target_org_node_id" IS NOT NULL);
--> statement-breakpoint
UPDATE "inventory_docs" AS d
   SET "source_org_node_id" = l."org_node_id"
  FROM "inventory_locations" AS l
 WHERE d."source_org_node_id" = l."location_id"
   AND l."org_node_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "inventory_docs" AS d
   SET "target_org_node_id" = l."org_node_id"
  FROM "inventory_locations" AS l
 WHERE d."target_org_node_id" = l."location_id"
   AND l."org_node_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "inventory_docs"
   SET "target_org_node_id" = "source_org_node_id"
 WHERE "doc_type" IN (
   '员工购出库', '供应链员工购出库', '内部领用',
   '市场产品报损', '院产品报损', '库存转换出库'
 )
   AND "source_org_node_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "inventory_docs"
   SET "source_org_node_id" = "target_org_node_id"
 WHERE "doc_type" IN ('市场产品盘溢', '库存转换入库', '期初库存')
   AND "target_org_node_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "inventory_docs"
   SET "source_org_node_id" = COALESCE("source_org_node_id", "target_org_node_id"),
       "target_org_node_id" = COALESCE("source_org_node_id", "target_org_node_id")
 WHERE "doc_type" IN ('品项公司报货需求', '市场库存盘点', '分院库存盘点');
