-- 统一 sale_order_type 枚举值
-- '正式' → '普通'（面向用户更直观）
-- '组合套餐' → '福利活动'（与 product_kind 枚举对齐）
-- 注：ALTER TYPE RENAME VALUE 自动更新所有使用该枚举的列值，无需 UPDATE 语句

ALTER TYPE "sale_order_type" RENAME VALUE '正式' TO '普通';
ALTER TYPE "sale_order_type" RENAME VALUE '组合套餐' TO '福利活动';
