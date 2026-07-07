ALTER TABLE "client_wechat_users" ADD COLUMN "old_member_level" "member_level";--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "is_shengmei" boolean;--> statement-breakpoint
ALTER TABLE "service_items" ADD COLUMN "is_shengmei" boolean;


UPDATE sale_items si
SET is_shengmei = sk.is_shengmei
FROM product_skus sk
WHERE si.sku_id = sk.sku_id
  AND si.is_shengmei IS NULL;


UPDATE service_items sit
SET is_shengmei = si.is_shengmei
FROM sale_items si
WHERE sit.sale_item_id = si.sale_item_id
  AND sit.is_shengmei IS NULL;

