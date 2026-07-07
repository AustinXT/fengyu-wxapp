ALTER TYPE "public"."payment_method" ADD VALUE '无';--> statement-breakpoint



ALTER TABLE "prepaid_cards" DROP CONSTRAINT IF EXISTS "prepaid_cards_store_id_stores_store_id_fk";--> statement-breakpoint
ALTER TABLE "prepaid_cards" DROP CONSTRAINT IF EXISTS "prepaid_cards_store_id_fkey";
--> statement-breakpoint
DROP INDEX "uq_prepaid_cards_user_store";--> statement-breakpoint
DROP INDEX "idx_prepaid_cards_user_id";--> statement-breakpoint
DROP INDEX "idx_prepaid_cards_store_id";--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "prepaid_card_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "paid_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint







UPDATE "card_transactions" SET "card_id" = m.canonical_card_id
FROM (
  SELECT pc.card_id AS old_card_id, c.canonical_card_id
  FROM "prepaid_cards" pc
  JOIN (
    SELECT DISTINCT ON (user_id) user_id, card_id AS canonical_card_id
    FROM "prepaid_cards"
    ORDER BY user_id, created_at ASC, card_id ASC
  ) c ON pc.user_id = c.user_id
  WHERE pc.card_id <> c.canonical_card_id
) m
WHERE "card_transactions"."card_id" = m.old_card_id;--> statement-breakpoint
UPDATE "prepaid_cards" SET "balance" = "prepaid_cards"."balance" + es.extra_balance, "updated_at" = NOW()
FROM (
  SELECT c.canonical_card_id, SUM(pc.balance) AS extra_balance
  FROM "prepaid_cards" pc
  JOIN (
    SELECT DISTINCT ON (user_id) user_id, card_id AS canonical_card_id
    FROM "prepaid_cards"
    ORDER BY user_id, created_at ASC, card_id ASC
  ) c ON pc.user_id = c.user_id
  WHERE pc.card_id <> c.canonical_card_id
  GROUP BY c.canonical_card_id
) es
WHERE "prepaid_cards"."card_id" = es.canonical_card_id;--> statement-breakpoint
DELETE FROM "prepaid_cards"
WHERE "card_id" NOT IN (
  SELECT DISTINCT ON (user_id) card_id
  FROM "prepaid_cards"
  ORDER BY user_id, created_at ASC, card_id ASC
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prepaid_cards_user" ON "prepaid_cards" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "prepaid_cards" DROP COLUMN "store_id";--> statement-breakpoint





UPDATE "sale_orders" SET "paid_amount" = "total_amount" WHERE "paid_amount" = 0;--> statement-breakpoint



ALTER TABLE "sale_orders" ADD CONSTRAINT "chk_prepaid_paid_sum" CHECK ("prepaid_card_amount" + "paid_amount" = "total_amount");