ALTER TABLE "client_wechat_users" ADD COLUMN "old_member_level" "member_level";--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "is_shengmei" boolean;--> statement-breakpoint
ALTER TABLE "service_items" ADD COLUMN "is_shengmei" boolean;

-- 历史回填：sale_items.is_shengmei ← product_skus.is_shengmei
UPDATE sale_items si
SET is_shengmei = sk.is_shengmei
FROM product_skus sk
WHERE si.sku_id = sk.sku_id
  AND si.is_shengmei IS NULL;

-- 历史回填：service_items.is_shengmei ← sale_items.is_shengmei（已经回填过）
UPDATE service_items sit
SET is_shengmei = si.is_shengmei
FROM sale_items si
WHERE sit.sale_item_id = si.sale_item_id
  AND sit.is_shengmei IS NULL;

-- old_member_level 历史保持 NULL（现存有等级的客户均视为"首次升级=新会员"，与产品定义一致）