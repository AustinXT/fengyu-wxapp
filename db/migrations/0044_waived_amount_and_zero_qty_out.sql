-- #182：sale_items 加 waived_amount（转换单折抵豁免掉的该行欠款）+ 放宽 chk_item_quantity
-- 让转出行允许 quantity = 0（纯余数折抵：次数/件数已用完、只剩不足一整次的已付余数）。
--
-- ⚠ 本文件**刻意写成幂等**（IF NOT EXISTS / IF EXISTS），原因不是洁癖：
--   本迁移最初以 0041 号、when=1789713204941 生成并**已在 dev 库应用**；#154 的 0043
--   （when=1789786018613）合入 test 后本条改号为 0044 并把 when 抬到 0043 之后。
--   drizzle migrator 判「已应用」只比 when（`lastDbMigration.created_at < migration.folderMillis`，
--   见 drizzle-orm/pg-core/dialect.cjs），**不比 hash** —— 不抬 when 的话，任何「先应用 0043、
--   再应用本条」的环境都会永久跳过本条；抬了 when，dev 库就会重跑本条。
--   幂等是同时满足这两边的唯一写法。仓内 0007 / 0029 / 0034 有同类先例。
--
-- ⚠ 与 0043 的顺序：0043 先加 refunded_quantity / converted_quantity 并建
--   chk_sale_item_settled_le_quantity；本条只动 waived_amount 与 chk_item_quantity，两者不相交。

ALTER TABLE "sale_items" ADD COLUMN IF NOT EXISTS "waived_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" DROP CONSTRAINT IF EXISTS "chk_item_waived_amount";--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "chk_item_waived_amount" CHECK ("sale_items"."waived_amount" >= 0);--> statement-breakpoint
ALTER TABLE "sale_items" DROP CONSTRAINT IF EXISTS "chk_item_quantity";--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "chk_item_quantity" CHECK ("sale_items"."quantity" > 0 OR ("sale_items"."item_direction" = '转出' AND "sale_items"."quantity" = 0));
