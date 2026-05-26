ALTER TYPE "public"."payment_method" ADD VALUE '无';--> statement-breakpoint
-- 注：FK 命名双版本并存 —— drizzle-kit 当前生成 "..._stores_store_id_fk"（baseline 0000 用此命名），
-- 但 5434/5433 两真实库由于 baseline reset 前的遗留，FK 实际命名为 legacy 的 "..._fkey"。
-- 用 DROP CONSTRAINT IF EXISTS 兼容两种，保证空库 smoke 和真实库都能 apply。
ALTER TABLE "prepaid_cards" DROP CONSTRAINT IF EXISTS "prepaid_cards_store_id_stores_store_id_fk";--> statement-breakpoint
ALTER TABLE "prepaid_cards" DROP CONSTRAINT IF EXISTS "prepaid_cards_store_id_fkey";
--> statement-breakpoint
DROP INDEX "uq_prepaid_cards_user_store";--> statement-breakpoint
DROP INDEX "idx_prepaid_cards_user_id";--> statement-breakpoint
DROP INDEX "idx_prepaid_cards_store_id";--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "prepaid_card_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_orders" ADD COLUMN "paid_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- ============================================================================
-- 一次性合并：同 user_id 多张储值卡（baseline reset 前按 (user_id, store_id) 拆分）
--   每个 user_id 保留 MIN(created_at) 对应的 card_id 作为 canonical；
--   其余卡流水 card_id 重定向到 canonical；balance 累加到 canonical；
--   删除冗余行。
-- 空库（docker smoke）上这几条都是 no-op。
-- ============================================================================
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
-- ============================================================================
-- Data backfill + CHECK invariant (手工追加，drizzle-kit 不会生成)
-- 历史订单：paid_amount 设为 total_amount（保持"原通道实付 = 订单总额"的语义），
-- prepaid_card_amount 保持默认 0。同号（含负退款单）由应用层保证。
-- ============================================================================
UPDATE "sale_orders" SET "paid_amount" = "total_amount" WHERE "paid_amount" = 0;--> statement-breakpoint
-- 核心不变量：prepaid_card_amount + paid_amount = total_amount
-- 对销售/回款/转换/退款四种单据均成立（退款单三者同号负数，和式仍等）。
-- 非负性 / 与 total_amount 同号 由应用层保证，不写 DB 级 CHECK（避免误伤退款单）。
ALTER TABLE "sale_orders" ADD CONSTRAINT "chk_prepaid_paid_sum" CHECK ("prepaid_card_amount" + "paid_amount" = "total_amount");