-- 移除 sale_order_source 列（代码已不再引用）
-- 先设默认值以防回滚时需要，再删除列
ALTER TABLE "sale_orders" ALTER COLUMN "sale_order_source" SET DEFAULT 'staff';
ALTER TABLE "sale_orders" ALTER COLUMN "sale_order_source" DROP NOT NULL;
