-- 套餐分组：products.pick_count → mall_bundle_groups 表，支持分组 M选N

-- 1. 新增套餐分组表
CREATE TABLE mall_bundle_groups (
  id BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(product_id),
  group_name TEXT NOT NULL,
  pick_count INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_bundle_group ON mall_bundle_groups(product_id, group_name);

-- 2. mall_product_skus 增加分组关联列
ALTER TABLE mall_product_skus ADD COLUMN bundle_group_id BIGINT REFERENCES mall_bundle_groups(id);

-- 3. 删除 products.pick_count（选择逻辑已迁移到分组级）
ALTER TABLE products DROP COLUMN pick_count;
