DROP INDEX "idx_inventory_docs_related";--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP COLUMN "related_doc_id";--> statement-breakpoint
ALTER TABLE "inventory_docs" DROP COLUMN "request_doc_id";--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "chk_inventory_movements_doc_item_pair" CHECK (("inventory_movements"."doc_item_id" IS NULL) = ("inventory_movements"."doc_id" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" VALIDATE CONSTRAINT "chk_inventory_movements_doc_item_pair";
