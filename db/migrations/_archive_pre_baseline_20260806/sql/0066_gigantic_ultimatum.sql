ALTER TABLE "sale_orders" ADD COLUMN "store_name" varchar(100);
--> statement-breakpoint
-- 回填历史订单门店名快照（按当前 stores.store_name；无历史名记录，仅能取当前名）
UPDATE "sale_orders" o SET "store_name" = s."store_name"
FROM "stores" s
WHERE o."store_id" = s."store_id" AND o."store_name" IS NULL;