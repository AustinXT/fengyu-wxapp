ALTER TABLE "sale_orders" ADD COLUMN "store_name" varchar(100);
--> statement-breakpoint

UPDATE "sale_orders" o SET "store_name" = s."store_name"
FROM "stores" s
WHERE o."store_id" = s."store_id" AND o."store_name" IS NULL;