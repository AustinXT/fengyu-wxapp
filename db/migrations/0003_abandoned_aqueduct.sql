ALTER TYPE "public"."payment_method" ADD VALUE '无';--> statement-breakpoint
ALTER TABLE "prepaid_cards" DROP CONSTRAINT "prepaid_cards_store_id_stores_store_id_fk";
--> statement-breakpoint
DROP INDEX "uq_prepaid_cards_user_store";--> statement-breakpoint
DROP INDEX "idx_prepaid_cards_user_id";--> statement-breakpoint
DROP INDEX "idx_prepaid_cards_store_id";--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "prepaid_card_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "paid_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prepaid_cards_user" ON "prepaid_cards" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "prepaid_cards" DROP COLUMN "store_id";