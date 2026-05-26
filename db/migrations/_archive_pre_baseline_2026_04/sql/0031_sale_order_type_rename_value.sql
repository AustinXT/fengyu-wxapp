-- sale_order_type 枚举值 '福利活动' → '组合套餐'，对齐 Drizzle schema
-- 撤销 migration 0002 中的 RENAME VALUE（当时从 '组合套餐' 改为 '福利活动'）

ALTER TYPE "sale_order_type" RENAME VALUE '福利活动' TO '组合套餐';
