-- Custom SQL migration file, put your code below! --
-- enum value rename：院装产品 → 家居产品
-- 背景：notes/tickets/2026-04-25-unify-yuanzhuang-to-jiaju-naming.md
-- drizzle-kit 自动模式会生成 drop+recreate（在已有数据时 cast 失败），
-- 因此本 migration 用 --custom 模式，单条 ALTER TYPE ... RENAME VALUE 完成（PG 10+ 支持）。
-- 现行 3 值：[疗程卡, 单品, 院装产品] → [疗程卡, 单品, 家居产品]
-- 与 product_categories.product_kind='家居产品' 字面相同但字段语义独立（前者核销逻辑/后者商品大类）。

ALTER TYPE "public"."product_type" RENAME VALUE '院装产品' TO '家居产品';
