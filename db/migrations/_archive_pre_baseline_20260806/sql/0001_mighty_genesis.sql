ALTER TABLE "prepaid_cards" ALTER COLUMN "store_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prepaid_cards_user_store" ON "prepaid_cards" USING btree ("user_id","store_id");--> statement-breakpoint
CREATE INDEX "idx_prepaid_cards_store_id" ON "prepaid_cards" USING btree ("store_id");