-- 品项分类一级可编辑：product_kind enum → nullable text，种子 4 行一级分类

-- 1. product_kind: enum → nullable text
ALTER TABLE product_categories ALTER COLUMN product_kind DROP NOT NULL;
ALTER TABLE product_categories ALTER COLUMN product_kind TYPE TEXT USING product_kind::TEXT;

-- 2. 插入 4 个一级分类行（product_kind = NULL 标识为一级）
INSERT INTO product_categories (category_id, category_name, product_kind, sort_order, is_valid)
VALUES
  (gen_random_uuid()::text, '福利活动', NULL, 1, true),
  (gen_random_uuid()::text, '护理项目', NULL, 2, true),
  (gen_random_uuid()::text, '家居产品', NULL, 3, true),
  (gen_random_uuid()::text, '充值卡',   NULL, 4, true);

-- 3. 删除旧 enum 类型（仅 product_categories 使用过）
DROP TYPE IF EXISTS "product_kind";
