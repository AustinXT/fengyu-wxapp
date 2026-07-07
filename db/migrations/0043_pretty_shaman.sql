ALTER TYPE "public"."sale_order_type" ADD VALUE '充值单';--> statement-breakpoint















DROP TRIGGER IF EXISTS trg_check_no_mixed_recharge ON "sale_items";--> statement-breakpoint
DROP FUNCTION IF EXISTS check_no_mixed_recharge();--> statement-breakpoint


CREATE TEMPORARY TABLE _recharge_items_cleanup AS
  SELECT sale_item_id, sale_order_id FROM "sale_items" WHERE is_recharge_card = true;--> statement-breakpoint


UPDATE "card_transactions" SET ref_order_id = NULL
  WHERE ref_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint


UPDATE "point_transactions" SET ref_order_id = NULL
  WHERE ref_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint


UPDATE "inventory_sale_orders" SET related_sale_order_id = NULL
  WHERE related_sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint


UPDATE "user_coupons"
  SET used_sale_order_id = NULL, used_at = NULL, status = '未使用'
  WHERE used_sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint


UPDATE "sale_orders" SET ref_sale_order_id = NULL
  WHERE ref_sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint


DELETE FROM "sale_order_payments"
  WHERE sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint


DELETE FROM "sale_allocations"
  WHERE sale_item_id IN (SELECT sale_item_id FROM _recharge_items_cleanup);--> statement-breakpoint

DELETE FROM "sale_items"
  WHERE sale_item_id IN (SELECT sale_item_id FROM _recharge_items_cleanup);--> statement-breakpoint

DELETE FROM "sale_orders"
  WHERE sale_order_id IN (SELECT sale_order_id FROM _recharge_items_cleanup);--> statement-breakpoint

DROP TABLE _recharge_items_cleanup;--> statement-breakpoint



CREATE TEMPORARY TABLE _recharge_mall_products_cleanup AS
  SELECT DISTINCT mps.product_id
  FROM "mall_product_skus" mps
  JOIN "product_skus" sk ON mps.sku_id = sk.sku_id
  WHERE sk.is_recharge_card = true;--> statement-breakpoint

DELETE FROM "mall_product_skus"
  WHERE sku_id IN (SELECT sku_id FROM "product_skus" WHERE is_recharge_card = true);--> statement-breakpoint


DELETE FROM "mall_bundle_groups"
  WHERE product_id IN (SELECT product_id FROM _recharge_mall_products_cleanup)
    AND product_id NOT IN (SELECT DISTINCT product_id FROM "mall_product_skus");--> statement-breakpoint

DELETE FROM "products"
  WHERE product_id IN (SELECT product_id FROM _recharge_mall_products_cleanup)
    AND product_id NOT IN (SELECT DISTINCT product_id FROM "mall_product_skus");--> statement-breakpoint

DROP TABLE _recharge_mall_products_cleanup;--> statement-breakpoint


DELETE FROM "product_skus" WHERE is_recharge_card = true;--> statement-breakpoint


ALTER TABLE "product_skus" DROP CONSTRAINT "chk_sku_not_both_capabilities";--> statement-breakpoint
DROP INDEX "idx_product_skus_is_recharge_card";--> statement-breakpoint
ALTER TABLE "product_skus" DROP COLUMN "is_recharge_card";--> statement-breakpoint
ALTER TABLE "sale_items" DROP COLUMN "is_recharge_card";--> statement-breakpoint


INSERT INTO "system_configs" (key, value) VALUES
  ('recharge.tiers', '[{"faceValue":500,"payAmount":495},{"faceValue":1000,"payAmount":980},{"faceValue":5000,"payAmount":4750}]'),
  ('recharge.minAmount', '500'),
  ('recharge.maxAmount', '100000')
ON CONFLICT (key) DO NOTHING;
