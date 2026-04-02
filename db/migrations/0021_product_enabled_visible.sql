-- products: 有效期 → 启用/展示开关
ALTER TABLE products ADD COLUMN is_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN is_visible boolean NOT NULL DEFAULT true;
UPDATE products SET is_enabled = false
  WHERE (valid_start IS NOT NULL AND valid_start > CURRENT_DATE)
     OR (valid_end IS NOT NULL AND valid_end < CURRENT_DATE);
ALTER TABLE products DROP COLUMN valid_start;
ALTER TABLE products DROP COLUMN valid_end;

-- product_skus: 有效期 → 启用开关
ALTER TABLE product_skus ADD COLUMN is_enabled boolean NOT NULL DEFAULT true;
UPDATE product_skus SET is_enabled = false
  WHERE (valid_start IS NOT NULL AND valid_start > CURRENT_DATE)
     OR (valid_end IS NOT NULL AND valid_end < CURRENT_DATE);
ALTER TABLE product_skus DROP COLUMN valid_start;
ALTER TABLE product_skus DROP COLUMN valid_end;
