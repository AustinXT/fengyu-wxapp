ALTER TABLE "sale_items" ADD COLUMN "service_fee" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_commissions" ADD COLUMN "fixed_fee" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_commissions" ADD COLUMN "consume_amount" numeric(10, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "chk_item_service_fee" CHECK ("sale_items"."service_fee" >= 0);--> statement-breakpoint
ALTER TABLE "service_commissions" ADD CONSTRAINT "chk_svc_comm_fixed_fee" CHECK ("service_commissions"."fixed_fee" >= 0);--> statement-breakpoint
ALTER TABLE "service_commissions" ADD CONSTRAINT "chk_svc_comm_consume_amount" CHECK ("service_commissions"."consume_amount" >= 0);--> statement-breakpoint

-- 回填 sale_items.service_fee ← product_skus.service_fee × quantity（开发阶段一次性回填，开单时由 order.create 持久化）
UPDATE sale_items si
SET service_fee = COALESCE(sk.service_fee, 0) * si.quantity
FROM product_skus sk
WHERE si.sku_id = sk.sku_id
  AND si.service_fee = 0;--> statement-breakpoint

-- 回填历史 service_commissions：旧行无法拆分 fixed_fee / consume_amount，
-- 按 WorkFine 导入口径视作"全部是固定手工费"，consume_amount 置 0
UPDATE service_commissions
SET fixed_fee = commission_amount
WHERE fixed_fee = 0 AND commission_amount > 0;