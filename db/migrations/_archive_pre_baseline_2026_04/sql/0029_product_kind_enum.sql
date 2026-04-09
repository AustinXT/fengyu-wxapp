-- product_kind: TEXT → enum，福利活动 → 组合套餐，新增体验卡

-- 1. 更新现有数据：福利活动 → 组合套餐
UPDATE product_categories SET product_kind = '组合套餐' WHERE product_kind = '福利活动';

-- 2. 更新一级分类行的 category_name
UPDATE product_categories SET category_name = '组合套餐' WHERE category_name = '福利活动' AND product_kind IS NULL;

-- 3. 创建枚举类型
CREATE TYPE "public"."product_kind" AS ENUM('组合套餐', '护理项目', '家居产品', '充值卡', '体验卡');

-- 4. TEXT → enum（NULL 保留）
ALTER TABLE product_categories ALTER COLUMN product_kind TYPE "public"."product_kind" USING product_kind::"public"."product_kind";

-- 5. 插入体验卡一级分类行
INSERT INTO product_categories (category_id, category_name, product_kind, sort_order, is_valid)
VALUES (gen_random_uuid()::text, '体验卡', NULL, 5, true);
