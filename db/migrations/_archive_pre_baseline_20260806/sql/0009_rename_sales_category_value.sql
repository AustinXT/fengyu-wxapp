-- Custom SQL migration file, put your code below! --
-- enum value rename：自采自销 → 自销自耗
-- 背景：notes/adapt-plans/00-decisions.md #2 于 2026-04-25 翻新
-- drizzle-kit 自动模式会生成 drop+recreate（在已有数据时 cast 失败），
-- 因此本 migration 用 --custom 模式，单条 ALTER TYPE ... RENAME VALUE 完成（PG 10+ 支持）。
-- 现行 4 值：[自采自销, 他销自耗, 他销他耗, 生态合作] → [自销自耗, 他销自耗, 他销他耗, 生态合作]

ALTER TYPE "public"."sales_category" RENAME VALUE '自采自销' TO '自销自耗';
