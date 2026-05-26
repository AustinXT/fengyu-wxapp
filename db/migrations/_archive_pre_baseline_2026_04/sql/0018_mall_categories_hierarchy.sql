-- 商城分类分组层级：category_group nullable text，NULL 表示一级分组（Tab）

ALTER TABLE mall_categories ADD COLUMN category_group TEXT;
