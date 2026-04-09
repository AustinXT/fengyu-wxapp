-- mall_categories 不需要 is_valid，直接删除即可（无软删除）
ALTER TABLE mall_categories DROP COLUMN is_valid;
