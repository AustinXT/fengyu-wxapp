ALTER TYPE "public"."sale_order_type" ADD VALUE '充值单';--> statement-breakpoint

-- ===========================================
-- 充值卡剥离 SKU 化（来源：notes/plans/isrechargecard-sku-soft-hinton.md）
--
-- 顺序：
--   1. DROP D4 兜底触发器（trigger 引用 is_recharge_card 列，DROP COLUMN 前必须先拆）
--   2. 清理充值订单整链（card_transactions.ref → sale_order_payments → sale_allocations
--      → sale_items → sale_orders）+ 充值卡 SKU
--   3. DROP 约束 + 索引 + 列
--   4. system_configs 档位 seed
--
-- 数据清理依赖：项目未上线，pre-launch-data-wipe 保障（无运行时数据风险）
-- ===========================================

-- 1. 拆除 D4 兜底触发器 + 函数（migration 0020 引入）
DROP TRIGGER IF EXISTS trg_check_no_mixed_recharge ON "sale_items";--> statement-breakpoint
DROP FUNCTION IF EXISTS check_no_mixed_recharge();--> statement-breakpoint

-- 2. 充值订单整链清理（用临时表锁定订单/明细 ID，避免链式 DELETE 中识别失效）
CREATE TEMPORARY TABLE _recharge_items_cleanup AS
  SELECT sale_item_id, sale_order_id FROM "sale_items" WHERE is_recharge_card = true;--> statement-breakpoint

-- 解除 card_transactions.ref_order_id 引用（保留历史流水，仅清引用）
UPDATE "card_transactions" SET ref_order_id = NULL
  WHERE ref_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint

-- 解除 point_transactions.ref_order_id 引用（充值订单不应产生积分，但防御性清理）
UPDATE "point_transactions" SET ref_order_id = NULL
  WHERE ref_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint

-- inventory_sale_orders.related_sale_order_id 引用（充值订单不会被库存出库引用，但防御性 NULL 化）
UPDATE "inventory_sale_orders" SET related_sale_order_id = NULL
  WHERE related_sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint

-- user_coupons.used_sale_order_id 引用（充值订单不允许用券，但防御性 NULL 化 + 状态重置）
UPDATE "user_coupons"
  SET used_sale_order_id = NULL, used_at = NULL, status = '未使用'
  WHERE used_sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint

-- sale_orders.ref_sale_order_id 自引用（转换单引用原销售单，不会指向充值单，但防御性 NULL 化）
UPDATE "sale_orders" SET ref_sale_order_id = NULL
  WHERE ref_sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint

-- sale_order_payments 按订单 ID 清理
DELETE FROM "sale_order_payments"
  WHERE sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint

-- sale_allocations 按明细 ID 清理（该表 FK → sale_items.sale_item_id，无 sale_order_id 列）
DELETE FROM "sale_allocations"
  WHERE sale_item_id IN (SELECT sale_item_id FROM _recharge_items_cleanup);--> statement-breakpoint

DELETE FROM "sale_items"
  WHERE sale_item_id IN (SELECT sale_item_id FROM _recharge_items_cleanup);--> statement-breakpoint

DELETE FROM "sale_orders"
  WHERE sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint

DROP TABLE _recharge_items_cleanup;--> statement-breakpoint

-- 先清商城关联：mall_product_skus 是 products ↔ product_skus 的 M:N 桥表
-- 删充值卡 SKU 前必须先把这些关联行删掉（FK NO ACTION 会报错）
CREATE TEMPORARY TABLE _recharge_mall_products_cleanup AS
  SELECT DISTINCT mps.product_id
  FROM "mall_product_skus" mps
  JOIN "product_skus" sk ON mps.sku_id = sk.sku_id
  WHERE sk.is_recharge_card = true;--> statement-breakpoint

DELETE FROM "mall_product_skus"
  WHERE sku_id IN (SELECT sku_id FROM "product_skus" WHERE is_recharge_card = true);--> statement-breakpoint

-- 现在判定哪些 mall_products 已 0 SKU（仅曾挂充值卡 SKU），整商品下线
DELETE FROM "mall_bundle_groups"
  WHERE product_id IN (SELECT product_id FROM _recharge_mall_products_cleanup)
    AND product_id NOT IN (SELECT DISTINCT product_id FROM "mall_product_skus");--> statement-breakpoint

DELETE FROM "products"
  WHERE product_id IN (SELECT product_id FROM _recharge_mall_products_cleanup)
    AND product_id NOT IN (SELECT DISTINCT product_id FROM "mall_product_skus");--> statement-breakpoint

DROP TABLE _recharge_mall_products_cleanup;--> statement-breakpoint

-- 删充值卡 SKU（含真实档位 SKU + 'sku-recharge-virtual' 虚拟 SKU）
DELETE FROM "product_skus" WHERE is_recharge_card = true;--> statement-breakpoint

-- 3. DROP 约束 + 索引 + 列（drizzle-kit 生成）
ALTER TABLE "product_skus" DROP CONSTRAINT "chk_sku_not_both_capabilities";--> statement-breakpoint
DROP INDEX "idx_product_skus_is_recharge_card";--> statement-breakpoint
ALTER TABLE "product_skus" DROP COLUMN "is_recharge_card";--> statement-breakpoint
ALTER TABLE "sale_items" DROP COLUMN "is_recharge_card";--> statement-breakpoint

-- 4. 充值档位配置（系统配置，admin 后续走 system_configs 编辑入口维护）
INSERT INTO "system_configs" (key, value) VALUES
  ('recharge.tiers', '[{"faceValue":500,"payAmount":495},{"faceValue":1000,"payAmount":980},{"faceValue":5000,"payAmount":4750}]'),
  ('recharge.minAmount', '500'),
  ('recharge.maxAmount', '100000')
ON CONFLICT (key) DO NOTHING;
