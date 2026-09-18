ALTER TABLE "sale_items" DROP CONSTRAINT "chk_item_quantity";--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "waived_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "chk_item_waived_amount" CHECK ("sale_items"."waived_amount" >= 0);--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "chk_item_quantity" CHECK ("sale_items"."quantity" > 0 OR ("sale_items"."item_direction" = '转出' AND "sale_items"."quantity" = 0));