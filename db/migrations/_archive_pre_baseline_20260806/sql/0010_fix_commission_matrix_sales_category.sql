-- Custom SQL migration file, put your code below! --
-- 数据回填：commission_rate_matrix.sales_category 是 varchar(20) 不是 enum，
-- migration 0009 的 ALTER TYPE RENAME VALUE 不触达本表数据。
-- 0009 已 apply 后发现 5434 仍有 12 行 '自采自销'，需此 UPDATE 收尾。
-- 关联：notes/adapt-plans/00-decisions.md #2（2026-04-25 enum 翻新）

UPDATE commission_rate_matrix SET sales_category = '自销自耗' WHERE sales_category = '自采自销';
